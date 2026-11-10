import "server-only";
import { createHash } from "node:crypto";
import { and, asc, count, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AI_DISCLAIMER } from "@/lib/advice-guardrails";
import { generate } from "@/lib/ai";
import { explainStats, type Explanation, explanationOutput, type ExplainMode, MAX_CATEGORIZE_ROWS, MIN_CONFIDENCE, proposeCategories, skippedExplanation } from "@/lib/ai/budget-tasks";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { cashFlow, currentMonth, monthInput } from "@/lib/budget";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { BadRequestError, TooManyRequestsError } from "@/lib/errors";
import { ownedBy } from "@/lib/owned";
import { advisoryLock, consumeRate, releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

const { txn, categoryRule, cashflowSummary } = schema;
type Gen = typeof generate;

export const CATEGORIZE_PER_HOUR = 10;
export const EXPLAIN_PER_HOUR = 10;
export const MAX_REGENERATIONS = 2;
/** Bump when the prompt or guardrails change so cached explanations are regenerated. */
const PROMPT_VERSION = 1;

const permission = (actor: Actor) => assertCan(actor, "update", { ownerId: actor.id });
const dailyMessage = "The daily AI limit for this app has been reached. Try again tomorrow.";

/** Reserve one hourly slot for the user and one app-wide daily slot, in one short transaction, before any model call. */
async function reserve(actor: Actor, kind: "categorize" | "explain", perHour: number) {
  await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, kind, perHour, `AI limit reached (${perHour} per hour). Try again later.`);
    if (!(await reserveDaily(tx, "ai", env().AI_DAILY_CAP))) throw new TooManyRequestsError(dailyMessage);
  });
}
/** The work the reservation paid for never happened. */
async function refund(actor: Actor, kind: "categorize" | "explain") {
  await db().transaction(async (tx) => {
    await releaseRate(tx, actor.id, kind);
    await releaseDaily(tx, "ai");
  });
}

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

const eligible = or(eq(txn.categorySource, "none"), and(eq(txn.categorySource, "ai"), lt(txn.aiConfidence, "0.60")));

/** Own uncategorized and low-confidence AI rows. Never `user`, `rule` or `provider` rows. */
export async function countCategorizable(actor: Actor): Promise<number> {
  permission(actor);
  const [{ n }] = await db().select({ n: count() }).from(txn).where(ownedBy(txn, actor, eligible));
  return n;
}

export type CategorizeResult = { sent: number; applied: number; suggested: number; unchanged: number; remaining: number; demo: boolean; disclaimer: string };

/**
 * Up to 50 of the actor's rows, oldest first (never-categorized before low-confidence retries), go to the model.
 * Confident proposals (>= 0.6) are applied with `category_source = 'ai'`; weaker ones are stored the same way with
 * their confidence so the UI shows them as a chip, and the row still counts as "needs review".
 */
export async function categorizeTransactions(actor: Actor, gen: Gen = generate): Promise<CategorizeResult> {
  permission(actor);
  const rows = await db().select().from(txn).where(ownedBy(txn, actor, eligible))
    .orderBy(sql`(${txn.categorySource} = 'none') desc`, asc(txn.date), asc(txn.id)).limit(MAX_CATEGORIZE_ROWS);
  if (rows.length === 0) return { sent: 0, applied: 0, suggested: 0, unchanged: 0, remaining: 0, demo: false, disclaimer: AI_DISCLAIMER };
  const rules = await db().select().from(categoryRule).where(ownedBy(categoryRule, actor)).limit(20);

  await reserve(actor, "categorize", CATEGORIZE_PER_HOUR);
  let result: Awaited<ReturnType<typeof proposeCategories>>;
  try {
    result = await proposeCategories(
      rows.map((r) => ({ id: r.id, name: r.name, merchantName: r.merchantName, amountCents: r.amountCents, providerCategory: r.providerCategory })),
      rules, gen);
  } catch (err) {
    await refund(actor, "categorize");
    throw err;
  }
  let applied = 0; let suggested = 0;
  await db().transaction(async (tx) => {
    // Same lock as recategorize: a user's edit and this write never interleave.
    await advisoryLock(tx, `categories:${actor.id}`);
    for (const p of result.proposals) {
      const updated = await tx.update(txn).set({ categorySlug: p.category, categorySource: "ai", aiConfidence: p.confidence.toFixed(2), updatedAt: new Date() })
        .where(ownedBy(txn, actor, eq(txn.id, p.id), inArray(txn.categorySource, ["none", "ai"]))).returning({ id: txn.id });
      if (!updated.length) continue; // the user or a rule got there first
      if (p.confidence >= MIN_CONFIDENCE) applied++; else suggested++;
    }
  });
  return { sent: result.sent, applied, suggested, unchanged: result.sent - applied - suggested, remaining: await countCategorizable(actor), demo: result.demo, disclaimer: AI_DISCLAIMER };
}

// ---------------------------------------------------------------------------
// Cash-flow explanation
// ---------------------------------------------------------------------------

export type ExplanationView = {
  month: string; data: Explanation; mode: ExplainMode; demo: boolean; generatedAt: string | null;
  /** True when the month's numbers changed since this text was written. */
  stale: boolean; regenerationsLeft: number; disclaimer: string;
};

export const explainInput = z.object({ month: monthInput, regenerate: z.boolean().default(false) }).strict();

const hashStats = (stats: unknown) => createHash("sha256").update(JSON.stringify([PROMPT_VERSION, stats])).digest("hex");

/** Current month and the two before it. */
export function explainableMonths(now = currentMonth()): string[] {
  const [y, m] = now.split("-").map(Number);
  return [0, 1, 2].map((back) => new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 7));
}

function toView(row: typeof cashflowSummary.$inferSelect, stale: boolean): ExplanationView | null {
  const data = explanationOutput.safeParse(row.data);
  if (!data.success) return null;
  return {
    month: row.month, data: data.data, mode: row.mode as ExplainMode, demo: row.mode === "demo", generatedAt: row.generatedAt.toISOString(),
    stale, regenerationsLeft: Math.max(0, MAX_REGENERATIONS - row.regenerations), disclaimer: AI_DISCLAIMER,
  };
}

/** The cached explanation for a month, or null. Makes no model call and uses no quota. */
export async function getCachedExplanation(actor: Actor, monthParam: string): Promise<ExplanationView | null> {
  assertCan(actor, "read", { ownerId: actor.id });
  const month = monthInput.parse(monthParam);
  const [row] = await db().select().from(cashflowSummary).where(ownedBy(cashflowSummary, actor, eq(cashflowSummary.month, month)));
  if (!row) return null;
  return toView(row, row.inputHash !== hashStats(await cashFlow(actor, month)));
}

export async function explainCashflow(actor: Actor, input: unknown, gen: Gen = generate): Promise<ExplanationView> {
  permission(actor);
  const { month, regenerate } = explainInput.parse(input);
  if (!explainableMonths().includes(month)) throw new BadRequestError("Choose the current month or one of the two before it.");
  const stats = await cashFlow(actor, month);
  if (stats.counts.transactions === 0) {
    return { month, data: skippedExplanation(month), mode: "skipped", demo: false, generatedAt: null, stale: false, regenerationsLeft: MAX_REGENERATIONS, disclaimer: AI_DISCLAIMER };
  }
  const inputHash = hashStats(stats);

  // Decide and reserve in one short transaction; the model call happens after it commits.
  const cached = await db().transaction(async (tx) => {
    await advisoryLock(tx, `explain:${actor.id}:${month}`);
    const [row] = await tx.select().from(cashflowSummary).where(ownedBy(cashflowSummary, actor, eq(cashflowSummary.month, month)));
    if (row && row.inputHash === inputHash && !regenerate) return toView(row, false);
    if (row && row.regenerations >= MAX_REGENERATIONS) {
      throw new TooManyRequestsError(`This month's summary can be regenerated ${MAX_REGENERATIONS} times. The limit has been reached.`);
    }
    await consumeRate(tx, actor.id, "explain", EXPLAIN_PER_HOUR, `AI limit reached (${EXPLAIN_PER_HOUR} per hour). Try again later.`);
    if (!(await reserveDaily(tx, "ai", env().AI_DAILY_CAP))) throw new TooManyRequestsError(dailyMessage);
    if (row) await tx.update(cashflowSummary).set({ regenerations: row.regenerations + 1 }).where(ownedBy(cashflowSummary, actor, eq(cashflowSummary.month, month)));
    return null;
  });
  if (cached) return cached;

  let out: Awaited<ReturnType<typeof explainStats>>;
  try {
    out = await explainStats(stats, gen);
  } catch (err) {
    await refund(actor, "explain");
    await db().update(cashflowSummary).set({ regenerations: sql`greatest(${cashflowSummary.regenerations} - 1, 0)` }).where(ownedBy(cashflowSummary, actor, eq(cashflowSummary.month, month)));
    throw err;
  }
  const [saved] = await db().insert(cashflowSummary).values({ ownerId: actor.id, month, data: out.data, stats, mode: out.mode, inputHash, regenerations: 0 })
    .onConflictDoUpdate({ target: [cashflowSummary.ownerId, cashflowSummary.month], set: { data: out.data, stats, mode: out.mode, inputHash, generatedAt: new Date() } }).returning();
  return toView(saved, false)!;
}

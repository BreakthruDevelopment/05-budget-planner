import "server-only";
import { and, count, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { env } from "@/lib/env";
import { ownedBy } from "@/lib/owned";
import { advisoryLock, consumeRate } from "@/lib/usage";
const { txn, budget, categoryRule, bankAccount, SLUGS } = schema;
const permission = (actor: Actor, action: "read" | "update") => assertCan(actor, action, { ownerId: actor.id });
export const monthInput = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(v => v >= "2000-01" && v <= "2100-12", "Month is out of range");
export const currentMonth = () => new Date().toISOString().slice(0, 7);
export function monthBounds(month: string) {
  month = monthInput.parse(month);
  const [year, m] = month.split("-").map(Number);
  return { start: `${month}-01`, end: new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 10), previous: new Date(Date.UTC(year, m - 2, 1)).toISOString().slice(0, 10) };
}
const cursorInput = z.object({ date: z.iso.date(), id: z.uuid() });
export const transactionFilters = z.object({ month: monthInput.optional(), account: z.uuid().optional(), category: z.enum(SLUGS).optional(), review: z.enum(["true", "false"]).optional(), cursor: z.string().max(500).optional() }).strict();
export async function listTransactions(actor: Actor, input: unknown = {}) {
  permission(actor, "read"); const f = transactionFilters.parse(input);
  const range = f.month ? monthBounds(f.month) : null;
  let cursor: z.infer<typeof cursorInput> | null = null;
  if (f.cursor) {
    try { cursor = cursorInput.parse(JSON.parse(Buffer.from(f.cursor, "base64url").toString())); }
    catch { throw new z.ZodError([{ code: "custom", path: ["cursor"], message: "Invalid cursor" }]); }
  }
  if (f.account) {
    const [account] = await db().select({ id: bankAccount.id }).from(bankAccount).where(ownedBy(bankAccount, actor, eq(bankAccount.id, f.account)));
    if (!account) throw new NotFoundError();
  }
  const rows = await db().select().from(txn).where(ownedBy(txn, actor,
    range ? and(gte(txn.date, range.start), lt(txn.date, range.end)) : undefined,
    f.account ? eq(txn.accountId, f.account) : undefined, f.category ? eq(txn.categorySlug, f.category) : undefined,
    f.review === "true" ? or(eq(txn.categorySource, "none"), lt(txn.aiConfidence, "0.60")) : undefined,
    cursor ? or(lt(txn.date, cursor.date), and(eq(txn.date, cursor.date), lt(txn.id, cursor.id))) : undefined,
  )).orderBy(desc(txn.date), desc(txn.id)).limit(101);
  const items = rows.slice(0, 100); const last = items.at(-1);
  return { items, nextCursor: rows.length > 100 && last ? Buffer.from(JSON.stringify({ date: last.date, id: last.id })).toString("base64url") : null };
}
export async function getTransaction(actor: Actor, id: string) {
  permission(actor, "read");
  const [row] = await db().select().from(txn).where(ownedBy(txn, actor, eq(txn.id, z.uuid().parse(id))));
  if (!row) throw new NotFoundError(); return row;
}
export const categoryInput = z.object({ categorySlug: z.enum(SLUGS), always: z.boolean().default(false) }).strict();
export async function recategorizeTransaction(actor: Actor, id: string, input: unknown) {
  permission(actor, "update"); id = z.uuid().parse(id); const data = categoryInput.parse(input);
  return db().transaction(async tx => {
    await advisoryLock(tx, `categories:${actor.id}`);
    const [row] = await tx.select().from(txn).where(ownedBy(txn, actor, eq(txn.id, id)));
    if (!row) throw new NotFoundError();
    if (data.always) {
      await consumeRate(tx, actor.id, "rule_write", 60, "Rule write limit reached.");
      const [existing] = await tx.select().from(categoryRule).where(ownedBy(categoryRule, actor, eq(categoryRule.merchantKey, row.merchantKey)));
      const [{ n }] = await tx.select({ n: count() }).from(categoryRule).where(ownedBy(categoryRule, actor));
      if (!existing && n >= 200) throw new TooManyRequestsError("At most 200 merchant rules are allowed.");
      await tx.insert(categoryRule).values({ ownerId: actor.id, merchantKey: row.merchantKey, categorySlug: data.categorySlug }).onConflictDoUpdate({ target: [categoryRule.ownerId, categoryRule.merchantKey], set: { categorySlug: data.categorySlug } });
      await tx.update(txn).set({ categorySlug: data.categorySlug, categorySource: "rule", aiConfidence: null, updatedAt: new Date() }).where(ownedBy(txn, actor, eq(txn.merchantKey, row.merchantKey), or(inArray(txn.categorySource, ["none", "ai"]), isNull(txn.categorySlug))));
    }
    const [updated] = await tx.update(txn).set({ categorySlug: data.categorySlug, categorySource: "user", aiConfidence: null, updatedAt: new Date() }).where(ownedBy(txn, actor, eq(txn.id, id))).returning();
    return updated;
  });
}
export async function listRules(actor: Actor) { permission(actor, "read"); return db().select().from(categoryRule).where(ownedBy(categoryRule, actor)); }
export async function listCategories(actor: Actor) { permission(actor, "read"); return db().select().from(schema.category).orderBy(schema.category.position); }
export const budgetsInput = z.object({ budgets: z.array(z.object({ categorySlug: z.enum(SLUGS).refine(s => s !== "income" && s !== "transfer", "Expense categories only"), monthlyLimitCents: z.number().int().min(1).max(10_000_000) }).strict()).max(12).refine(rows => new Set(rows.map(r => r.categorySlug)).size === rows.length, "Duplicate category") }).strict();
export async function listBudgets(actor: Actor) { permission(actor, "read"); return db().select().from(budget).where(ownedBy(budget, actor)); }
export async function replaceBudgets(actor: Actor, input: unknown) {
  permission(actor, "update"); const { budgets } = budgetsInput.parse(input);
  return db().transaction(async tx => {
    await advisoryLock(tx, `budgets:${actor.id}`);
    await tx.delete(budget).where(ownedBy(budget, actor));
    if (!budgets.length) return [];
    return tx.insert(budget).values(budgets.map(b => ({ ...b, ownerId: actor.id }))).returning();
  });
}
export type CashFlow = { month: string; incomeCents: number; spendCents: number; netCents: number; categories: { categorySlug: string; spendCents: number; budgetCents: number; remainingCents: number; previousCents: number }[]; topMerchants: { merchantName: string; spendCents: number }[]; counts: { transactions: number; needsReview: number; pending: number; nonUsd: number } };
/** One SQL snapshot: all monetary totals are USD, posted only; transfers never count as income/spend. */
export async function cashFlow(actor: Actor, month: string): Promise<CashFlow> {
  permission(actor, "read"); const { start, end, previous } = monthBounds(month);
  const [row] = await db().execute<{ data: CashFlow }>(sql`
    with rows as (select *, case when category_source = 'ai' and ai_confidence < 0.6 then 'other' else coalesce(category_slug, 'other') end as eff_slug from txn where owner_id = ${actor.id} and date >= ${previous}::date and date < ${end}::date),
    posted as (select * from rows where iso_currency = 'USD' and not pending and eff_slug <> 'transfer'),
    current_rows as (select * from posted where date >= ${start}::date),
    totals as (select coalesce(sum(amount_cents) filter (where amount_cents > 0),0) as income, -coalesce(sum(amount_cents) filter (where amount_cents < 0),0) as spend from current_rows),
    cats as (select c.slug, coalesce(-sum(p.amount_cents) filter (where p.date >= ${start}::date),0) as spend,
      coalesce(-sum(p.amount_cents) filter (where p.date < ${start}::date),0) as previous, coalesce(b.monthly_limit_cents,0) as budget
      from category c left join posted p on p.eff_slug=c.slug and p.amount_cents < 0
      left join budget b on b.category_slug=c.slug and b.owner_id=${actor.id} where c.kind<>'transfer' group by c.slug,c.position,b.monthly_limit_cents order by c.position),
    merchants as (select coalesce(merchant_name,name) as name, -sum(amount_cents) as spend from current_rows where amount_cents < 0 group by coalesce(merchant_name,name) order by spend desc, name limit 5)
    select jsonb_build_object('month',${month}::text,'incomeCents',income,'spendCents',spend,'netCents',income-spend,
      'categories',(select coalesce(jsonb_agg(jsonb_build_object('categorySlug',slug,'spendCents',spend,'budgetCents',budget,'remainingCents',budget-spend,'previousCents',previous)),'[]'::jsonb) from cats),
      'topMerchants',(select coalesce(jsonb_agg(jsonb_build_object('merchantName',name,'spendCents',spend)),'[]'::jsonb) from merchants),
      'counts',(select jsonb_build_object('transactions',count(*),'needsReview',count(*) filter (where category_source='none' or ai_confidence < 0.6),'pending',count(*) filter (where pending),'nonUsd',count(*) filter (where iso_currency <> 'USD')) from rows where date >= ${start}::date)) as data from totals
  `);
  return row.data;
}
export async function adminCounts(actor: Actor) {
  assertCan(actor, "read", { ownerId: actor.id });
  if (actor.role !== "admin") throw new ForbiddenError();
  const [row] = await db().execute<{ data: { users: number; items: { demo: number; plaid: number }; transactions: number; aiCalls: number; aiDailyCap: number } }>(sql`
    select jsonb_build_object('users',(select count(*) from "user"), 'items', jsonb_build_object('demo',(select count(*) from bank_item where provider='demo'),'plaid',(select count(*) from bank_item where provider='plaid')), 'transactions',(select count(*) from txn), 'aiCalls',(select coalesce(sum(count),0) from daily_usage where day=(now() at time zone 'utc')::date and kind in ('ai','categorize','explain')), 'aiDailyCap',${env().AI_DAILY_CAP}::int) as data`);
  return row.data;
}

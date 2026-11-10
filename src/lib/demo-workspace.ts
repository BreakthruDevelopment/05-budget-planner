import "server-only";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { demoTransactions } from "@/lib/bank/demo";
import { merchantKey, providerCategory } from "@/lib/bank/categories";
import { MARKER, DEMO_EMAIL_DOMAIN } from "@/lib/demo-identity";
import { ConflictError } from "@/lib/errors";
import { advisoryLock, consumeRate } from "@/lib/usage";
import { ownedBy } from "@/lib/owned";
/** Postgres unique violation, possibly wrapped by Drizzle (`cause`). */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ((e as { code?: unknown }).code === "23505" || isUniqueViolation((e as { cause?: unknown }).cause));
const inputSchema = z.object({ password: z.string().min(10).max(128).optional() }).strict();
/** All changes are atomic; collisions with unrelated identities fail without modifying any of them. */
export async function loadDemoWorkspace(actor: Actor, input: unknown = {}) {
  assertCan(actor, "create"); if (actor.role !== "admin") throw new ForbiddenError();
  const { password } = inputSchema.parse(input);
  const hashedPassword = await hashPassword(password ?? randomUUID());
  return db().transaction(async tx => {
    await advisoryLock(tx, "demo:budget-planner");
    await consumeRate(tx, actor.id, "demo_load", 2, "Demo workspace limit reached.");
    const emails = ["alex", "blair", "casey"].map(n => `${n}@${DEMO_EMAIL_DOMAIN}`);
    const existing = await tx.select().from(schema.user).where(inArray(schema.user.email, emails));
    if (existing.some(u => u.image !== MARKER)) throw new ConflictError("A demo identity is unavailable.");
    const result: { id: string; email: string }[] = [];
    for (const [i, email] of emails.entries()) {
      const previous = existing.find(u => u.email === email);
      const id = previous?.id ?? randomUUID();
      if (!previous) {
        // A real account may have taken the demo email since the check above: report a conflict, not a crash.
        try {
          await tx.insert(schema.user).values({ id, email, name: ["Alex Demo", "Blair Demo", "Casey Demo"][i], image: MARKER });
        } catch (e) {
          if (isUniqueViolation(e)) throw new ConflictError("A demo identity is unavailable.");
          throw e;
        }
        await tx.insert(schema.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hashedPassword });
      }
      // Existing users keep credentials and sessions. The loader only replaces its own marked financial fixtures.
      const demoActor: Actor = { id, role: "user" };
      await advisoryLock(tx, `categories:${id}`);
      const items = await tx.select().from(schema.bankItem).where(ownedBy(schema.bankItem, demoActor));
      if (items.some(item => item.provider !== "demo" || item.syncingSince)) throw new ConflictError("Demo data is busy or has a non-demo item.");
      await tx.delete(schema.bankItem).where(ownedBy(schema.bankItem, demoActor));
      await tx.delete(schema.budget).where(ownedBy(schema.budget, demoActor));
      await tx.delete(schema.categoryRule).where(ownedBy(schema.categoryRule, demoActor));
      await tx.delete(schema.cashflowSummary).where(ownedBy(schema.cashflowSummary, demoActor));
      const [item] = await tx.insert(schema.bankItem).values({ ownerId: id, provider: "demo", providerItemId: `demo-seed-${id}`, institutionName: "Breakthru Demo Bank", cursor: `${new Date().toISOString().slice(0, 10)}:150`, lastSyncedAt: new Date() }).returning();
      const accounts = await tx.insert(schema.bankAccount).values([
        { ownerId: id, itemId: item.id, providerAccountId: "checking", name: "Demo Checking", mask: "1234", type: "depository", subtype: "checking", currentCents: 420000 },
        { ownerId: id, itemId: item.id, providerAccountId: "credit", name: "Demo Credit Card", mask: "5678", type: "credit", subtype: "credit card", currentCents: 32000 },
      ]).returning();
      const rows = demoTransactions(new Date().toISOString().slice(0, 10)).filter(t => t.transaction_id !== "demo-1");
      await tx.insert(schema.txn).values(rows.map(t => {
        const slug = providerCategory(t.personal_finance_category?.primary ?? null);
        return { ownerId: id, itemId: item.id, accountId: accounts.find(a => a.providerAccountId === t.account_id)!.id, providerTxnId: t.transaction_id === "demo-0" ? "demo-posted-0" : t.transaction_id, pendingTxnId: t.transaction_id === "demo-0" ? "demo-0" : null, date: t.date, name: t.name, merchantName: t.merchant_name, merchantKey: merchantKey(t.merchant_name || t.name), amountCents: -Math.round(t.amount * 100), isoCurrency: "USD", pending: false, providerCategory: t.personal_finance_category?.primary, categorySlug: slug, categorySource: slug ? "provider" as const : "none" as const };
      }));
      await tx.insert(schema.budget).values([{ ownerId: id, categorySlug: "groceries", monthlyLimitCents: 50000 }, { ownerId: id, categorySlug: "dining", monthlyLimitCents: 25000 }]);
      result.push({ id, email });
    }
    return { users: result, bank: "demo", transactions: 447 };
  });
}

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BankProvider, BankTransaction, SyncPage } from "@/lib/bank/types";
const url = process.env.TEST_DATABASE_URL;
const alice = { id: "budget-alice", role: "user" as const };
const bob = { id: "budget-bob", role: "user" as const };
const admin = { id: "budget-admin", role: "admin" as const };
const base: BankTransaction = { transaction_id: "one", account_id: "checking", pending_transaction_id: null, date: "2026-06-10", name: "Test Market", merchant_name: "Test Market", amount: 12.34, iso_currency_code: "USD", pending: false, personal_finance_category: { primary: "GROCERIES" } };
const account = { account_id: "checking", name: "Checking", mask: "1234", type: "depository", subtype: "checking", current: 100, available: 90 };
const page = (added: BankTransaction[] = [], cursor = "done", extra: Partial<SyncPage> = {}): SyncPage => ({ accounts: [account], added, modified: [], removed: [], next_cursor: cursor, has_more: false, ...extra });
function provider(fn: BankProvider["sync"]): BankProvider {
  return { name: "demo", createLinkToken: async () => ({ linkToken: "demo" }), exchange: async () => ({ itemId: "demo", institutionName: "Demo", accessToken: null }), remove: async () => {}, sync: fn };
}
describe.skipIf(!url)("budget data layer (Postgres)", () => {
  let sql: postgres.Sql;
  let bank: typeof import("@/lib/bank/items");
  let data: typeof import("@/lib/budget");
  let itemId: string;
  async function rows() { return sql`select * from txn where item_id=${itemId} order by provider_txn_id`; }
  async function clearRate() { await sql`delete from rate_event where user_id=${alice.id}`; }
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 5, onnotice: () => {} });
    await sql`delete from "user" where id like 'budget-%'`;
    for (const u of [alice, bob, admin]) await sql`insert into "user" (id,name,email,role) values (${u.id},${u.id},${u.id + "@test.local"},${u.role})`;
    bank = await import("@/lib/bank/items"); data = await import("@/lib/budget");
  });
  beforeEach(async () => {
    await sql`delete from bank_item where owner_id in (${alice.id},${bob.id},${admin.id})`;
    await sql`delete from category_rule where owner_id=${alice.id}`;
    await sql`delete from budget where owner_id=${alice.id}`;
    await clearRate();
    itemId = randomUUID();
    await sql`insert into bank_item (id,owner_id,provider,provider_item_id,institution_name) values (${itemId},${alice.id},'demo',${randomUUID()},'Test')`;
  });
  afterAll(async () => { await sql`delete from "user" where id like 'budget-%'`; await sql.end(); });
  it("allows the owner, returns 404 to other users AND admins for items, sync, delete and transactions", async () => {
    await bank.syncItem(alice, itemId, provider(async () => page([base])));
    const [row] = await rows();
    expect((await bank.getItem(alice, itemId)).id).toBe(itemId);
    expect((await data.getTransaction(alice, row.id)).id).toBe(row.id);
    for (const actor of [bob, admin]) {
      for (const fn of [() => bank.getItem(actor, itemId), () => bank.syncItem(actor, itemId), () => bank.disconnectItem(actor, itemId), () => data.getTransaction(actor, row.id), () => data.recategorizeTransaction(actor, row.id, { categorySlug: "dining" }), () => data.listTransactions(actor, { account: row.account_id })]) await expect(fn()).rejects.toMatchObject({ status: 404 });
      expect(await bank.listBankItems(actor)).toEqual([]);
      expect((await data.listTransactions(actor)).items).toEqual([]);
      expect(await data.listRules(actor)).toEqual([]);
      expect(await data.listBudgets(actor)).toEqual([]);
      expect((await data.cashFlow(actor, "2026-06")).spendCents).toBe(0);
    }
    expect((await data.recategorizeTransaction(alice, row.id, { categorySlug: "dining" })).categorySource).toBe("user");
    await bank.disconnectItem(alice, itemId); expect(await rows()).toHaveLength(0);
  });
  it("two full syncs and replaying page 2 leave identical rows; removed deletes; signs negate once", async () => {
    const p2 = page([], "p2", { modified: [{ ...base, transaction_id: "two", amount: -100 }], removed: [{ transaction_id: "one" }] });
    const p = provider(async (_token, cursor) => cursor === null ? page([base], "p1", { has_more: true }) : p2);
    await bank.syncItem(alice, itemId, p);
    const before = await rows(); expect(before).toHaveLength(1); expect(Number(before[0].amount_cents)).toBe(10000);
    await bank.syncItem(alice, itemId, p); expect(await rows()).toEqual(before);
    await sql`update bank_item set cursor='p1' where id=${itemId}`;
    await bank.syncItem(alice, itemId, p); expect(await rows()).toEqual(before);
    await clearRate();
    await bank.syncItem(alice, itemId, provider(async () => page([base])));
    expect(Number((await rows()).find(r => r.provider_txn_id === "one")!.amount_cents)).toBe(-1234);
  });
  it("pending to posted carries a user's category and re-sync never overwrites it", async () => {
    await bank.syncItem(alice, itemId, provider(async () => page([{ ...base, pending: true }])));
    const [pending] = await rows();
    await data.recategorizeTransaction(alice, pending.id, { categorySlug: "health" });
    const posted = { ...base, transaction_id: "posted", pending_transaction_id: "one" };
    await bank.syncItem(alice, itemId, provider(async () => page([], "posted", { modified: [posted] })));
    expect(await rows()).toHaveLength(1); const [row] = await rows();
    expect(row.category_slug).toBe("health"); expect(row.category_source).toBe("user"); expect(row.pending).toBe(false);
    await bank.syncItem(alice, itemId, provider(async () => page([posted])));
    expect((await rows())[0].category_slug).toBe("health");
  });
  it("rules apply on import and always updates own none/AI rows without overwriting user/provider rows", async () => {
    const unknown = { ...base, personal_finance_category: null };
    await bank.syncItem(alice, itemId, provider(async () => page([base, { ...unknown, transaction_id: "two" }, { ...unknown, transaction_id: "three" }, { ...base, transaction_id: "four" }])));
    const all = await rows();
    await data.recategorizeTransaction(alice, all.find(r => r.provider_txn_id === "three")!.id, { categorySlug: "travel" });
    await data.recategorizeTransaction(alice, all.find(r => r.provider_txn_id === "one")!.id, { categorySlug: "dining", always: true });
    expect((await rows()).find(r => r.provider_txn_id === "two")!.category_source).toBe("rule");
    expect((await rows()).find(r => r.provider_txn_id === "three")!.category_slug).toBe("travel");
    expect((await rows()).find(r => r.provider_txn_id === "four")!.category_slug).toBe("groceries");
    await bank.syncItem(alice, itemId, provider(async () => page([{ ...base, transaction_id: "five" }])));
    expect((await rows()).find(r => r.provider_txn_id === "five")!.category_source).toBe("rule");
    expect((await rows()).find(r => r.provider_txn_id === "five")!.category_slug).toBe("dining");
  });
  it("provider mapping takes precedence over AI and clears stale AI confidence", async () => {
    await bank.syncItem(alice, itemId, provider(async () => page([{ ...base, personal_finance_category: null }])));
    const [row] = await rows();
    await sql`update txn set category_source='ai',category_slug='other',ai_confidence=0.4 where id=${row.id}`;
    await bank.syncItem(alice, itemId, provider(async () => page([base])));
    const [updated] = await rows();
    expect(updated.category_slug).toBe("groceries"); expect(updated.category_source).toBe("provider"); expect(updated.ai_confidence).toBeNull();
    expect((await data.listTransactions(alice, { review: "true" })).items).toEqual([]);
  });
  it("concurrent refreshes return one 409 and release the lease after success or error", async () => {
    let entered!: () => void, release!: () => void;
    const start = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
    const first = bank.syncItem(alice, itemId, provider(async () => { entered(); await gate; return page([base]); }));
    await start;
    await expect(bank.syncItem(alice, itemId)).rejects.toMatchObject({ status: 409 });
    release(); await first;
    await expect(bank.syncItem(alice, itemId, provider(async () => { throw new Error("provider failed"); }))).rejects.toThrow("provider failed");
    expect((await bank.getItem(alice, itemId)).syncingSince).toBeNull();
  });
  it("restarts pagination from the loop's starting cursor after mutation and commits each cursor with its page", async () => {
    const seen: (string | null)[] = []; let mutated = false;
    await sql`update bank_item set cursor='saved' where id=${itemId}`;
    await bank.syncItem(alice, itemId, provider(async (_token, cursor) => {
      seen.push(cursor);
      if (cursor === "saved") return page([base], "p2", { has_more: true });
      if (!mutated) { mutated = true; throw Object.assign(new Error("mutation"), { code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" }); }
      return page([{ ...base, transaction_id: "two" }]);
    }));
    expect(seen).toEqual(["saved", "p2", "saved", "p2"]); expect(await rows()).toHaveLength(2);
    expect((await bank.getItem(alice, itemId)).cursor).toBe("done");
  });
  it("a failed page changes neither rows nor cursor and can resume", async () => {
    await expect(bank.syncItem(alice, itemId, provider(async () => page([base, { ...base, transaction_id: "bad", account_id: "missing" }])))).rejects.toMatchObject({ status: 409 });
    expect(await rows()).toHaveLength(0); expect((await bank.getItem(alice, itemId)).cursor).toBeNull();
    await bank.syncItem(alice, itemId, provider(async () => page([base]))); expect(await rows()).toHaveLength(1);
  });
  it("cash flow equals a hand-computed fixture, excluding pending, FX and transfers; budgets are private and atomic", async () => {
    const fixture = [
      { ...base, transaction_id: "salary", amount: -1000, personal_finance_category: { primary: "INCOME" } },
      { ...base, transaction_id: "groceries", amount: 100 },
      { ...base, transaction_id: "dining", amount: 40, merchant_name: "Cafe", personal_finance_category: { primary: "FOOD_AND_DRINK" } },
      { ...base, transaction_id: "unknown", amount: 10, personal_finance_category: null },
      { ...base, transaction_id: "pending", amount: 800, pending: true },
      { ...base, transaction_id: "fx", amount: 700, iso_currency_code: "EUR" },
      { ...base, transaction_id: "transfer", amount: 600, personal_finance_category: { primary: "TRANSFER_OUT" } },
      { ...base, transaction_id: "prior", date: "2026-05-10", amount: 75 },
    ];
    await bank.syncItem(alice, itemId, provider(async () => page(fixture)));
    await data.replaceBudgets(alice, { budgets: [{ categorySlug: "groceries", monthlyLimitCents: 12000 }, { categorySlug: "dining", monthlyLimitCents: 3000 }] });
    const flow = await data.cashFlow(alice, "2026-06");
    expect(flow).toMatchObject({ incomeCents: 100000, spendCents: 15000, netCents: 85000, counts: { transactions: 7, pending: 1, nonUsd: 1, needsReview: 1 } });
    expect(flow.categories.find(c => c.categorySlug === "groceries")).toMatchObject({ spendCents: 10000, budgetCents: 12000, remainingCents: 2000, previousCents: 7500 });
    expect(flow.categories.find(c => c.categorySlug === "dining")!.remainingCents).toBe(-1000);
    expect(flow.topMerchants).toEqual([{ merchantName: "Test Market", spendCents: 11000 }, { merchantName: "Cafe", spendCents: 4000 }]);
    expect(flow.categories.reduce((sum,c) => sum+c.spendCents,0)).toBe(flow.spendCents);
    await expect(data.replaceBudgets(alice, { budgets: [{ categorySlug: "income", monthlyLimitCents: 1 }] })).rejects.toThrow();
    await expect(data.replaceBudgets(alice, { budgets: [{ categorySlug: "dining", monthlyLimitCents: 1 }, { categorySlug: "dining", monthlyLimitCents: 2 }] })).rejects.toThrow();
    expect(await data.listBudgets(alice)).toHaveLength(2); expect(await data.listBudgets(admin)).toHaveLength(0);
    await data.replaceBudgets(alice, { budgets: [] }); expect(await data.listBudgets(alice)).toEqual([]);
    expect((await data.cashFlow(alice, "2026-07")).incomeCents).toBe(0);
  });
  it("stops starting pages after the time budget, saves the cursor, and allows continuation", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    try {
      const result = await bank.syncItem(alice, itemId, provider(async () => {
        calls++; now += 20_001; return page([base], "continue", { has_more: true });
      }));
      expect(result.more).toBe(true); expect(calls).toBe(1);
      expect((await bank.getItem(alice, itemId)).cursor).toBe("continue");
    } finally { clock.mockRestore(); }
    const result = await bank.syncItem(alice, itemId, provider(async (_token, cursor) => { expect(cursor).toBe("continue"); return page(); }));
    expect(result.more).toBe(false); expect(await rows()).toHaveLength(1);
  });
  it("admins can manage their own financial records, without an ownership bypass", async () => {
    const id = randomUUID();
    await sql`insert into bank_item (id,owner_id,provider,provider_item_id,institution_name) values (${id},${admin.id},'demo',${randomUUID()},'Admin Bank')`;
    await bank.syncItem(admin, id, provider(async () => page([base])));
    const txns = await data.listTransactions(admin);
    expect(txns.items).toHaveLength(1); expect(txns.items[0].ownerId).toBe(admin.id);
    await data.recategorizeTransaction(admin, txns.items[0].id, { categorySlug: "income" });
    const flow = await data.cashFlow(admin, "2026-06");
    expect(flow.categories.reduce((n, c) => n + c.spendCents, 0)).toBe(flow.spendCents);
    await bank.disconnectItem(admin, id);
  });
  it("lists 100 rows per page with a stable owner-scoped keyset cursor and filters", async () => {
    await bank.syncItem(alice, itemId, provider(async () => page(Array.from({ length: 105 }, (_, i) => ({ ...base, transaction_id: `txn-${i}` })))));
    const first = await data.listTransactions(alice, { month: "2026-06" });
    expect(first.items).toHaveLength(100); expect(first.nextCursor).toBeTruthy();
    const second = await data.listTransactions(alice, { month: "2026-06", cursor: first.nextCursor });
    expect(second.items).toHaveLength(5); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items,...second.items].map(t => t.id)).size).toBe(105);
    expect((await data.listTransactions(bob, { cursor: first.nextCursor })).items).toEqual([]);
    expect((await data.listTransactions(alice, { review: "true" })).items).toEqual([]);
    await expect(data.listTransactions(alice, { cursor: "garbage" })).rejects.toThrow();
  });
  it("enforces item caps, refresh caps, composite owner FKs and counts-only admin access", async () => {
    await expect(data.adminCounts(alice)).rejects.toMatchObject({ status: 403 });
    await bank.syncItem(alice, itemId, provider(async () => page([base])));
    const [row] = await rows();
    await expect(sql`update txn set owner_id=${bob.id} where id=${row.id}`).rejects.toMatchObject({ code: "23503" });
    const counts = await data.adminCounts(admin);
    expect(counts.transactions).toBeGreaterThan(0); expect(Object.keys(counts).sort()).toEqual(["aiCalls","aiDailyCap","items","transactions","users"]);
    for (let i=0;i<5;i++) await bank.syncItem(alice, itemId, provider(async () => page()));
    await expect(bank.syncItem(alice, itemId)).rejects.toMatchObject({ status: 429 });
    await clearRate();
    await bank.connectDemo(alice, { demo: true }); await bank.connectDemo(alice, { demo: true });
    await expect(bank.connectDemo(alice, { demo: true })).rejects.toMatchObject({ status: 429 });
  });
});

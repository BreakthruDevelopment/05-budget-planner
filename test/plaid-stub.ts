import { randomUUID } from "node:crypto";

/**
 * An in-memory stand-in for Plaid's sandbox API, shaped like a `fetch`. It speaks only the endpoints the app uses,
 * pages `/transactions/sync` two events at a time (so pagination always happens), and can be told to fail.
 */
export type StubTxn = { transaction_id: string; account_id: string; pending_transaction_id?: string | null; date: string; name: string | null; merchant_name?: string | null; amount: number; iso_currency_code?: string | null; pending: boolean; personal_finance_category?: { primary: string } | null };
type Event = { kind: "added" | "modified" | "removed"; txn: StubTxn };
export type StubFailure = { path: string; status?: number; code: string; type?: string; echo?: string };

export const PUBLIC_TOKEN = "public-sandbox-0a1b2c3d-4e5f-6789";
export const stubAccounts = [
  { account_id: "acc-checking", name: "Plaid Checking", mask: "0000", type: "depository", subtype: "checking", balances: { current: 110.5, available: 100 } },
  { account_id: "acc-credit", name: "Plaid Credit Card", mask: null, type: "credit", subtype: "credit card", balances: { current: 410, available: null } },
];
export const txn = (id: string, extra: Partial<StubTxn> = {}): StubTxn => ({ transaction_id: id, account_id: "acc-checking", date: "2026-06-10", name: `Store ${id}`, merchant_name: `Store ${id}`, amount: 12.34, iso_currency_code: "USD", pending: false, personal_finance_category: { primary: "FOOD_AND_DRINK" }, ...extra });

export function plaidStub(opts: { pageSize?: number; itemId?: string } = {}) {
  const pageSize = opts.pageSize ?? 2;
  const accessToken = `access-sandbox-${randomUUID()}`;
  const itemId = opts.itemId ?? `item-${randomUUID()}`;
  const calls: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const events: Event[] = [];
  const failures: StubFailure[] = [];
  let removed = false;
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    if (!input.startsWith("https://sandbox.plaid.com/")) throw new Error(`unexpected host: ${input}`);
    const path = input.slice("https://sandbox.plaid.com".length);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ path, body, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)) });
    const failIdx = failures.findIndex(f => f.path === path);
    if (failIdx >= 0) {
      const f = failures.splice(failIdx, 1)[0];
      return respond(f.status ?? 400, { error_type: f.type ?? "API_ERROR", error_code: f.code, error_message: `secret detail ${f.echo ?? ""} ${accessToken}`, request_id: "req-abc123" });
    }
    if (path === "/link/token/create") return respond(200, { link_token: "link-sandbox-test", expiration: "2026-06-10T00:00:00Z", request_id: "r" });
    if (path === "/item/public_token/exchange") {
      if (body.public_token !== PUBLIC_TOKEN) return respond(400, { error_type: "INVALID_INPUT", error_code: "INVALID_PUBLIC_TOKEN", request_id: "r" });
      return respond(200, { access_token: accessToken, item_id: itemId, request_id: "r" });
    }
    if (path === "/item/get") return respond(200, { item: { institution_id: "ins_109508" }, request_id: "r" });
    if (path === "/institutions/get_by_id") return respond(200, { institution: { name: "First Platypus Bank" }, request_id: "r" });
    if (body.access_token !== accessToken || removed) return respond(400, { error_type: "ITEM_ERROR", error_code: "ITEM_NOT_FOUND", request_id: "r" });
    if (path === "/item/remove") { removed = true; return respond(200, { request_id: "r" }); }
    if (path === "/transactions/sync") {
      const offset = body.cursor ? Number(String(body.cursor).slice(1)) : 0;
      const slice = events.slice(offset, offset + pageSize);
      const next = offset + slice.length;
      return respond(200, {
        accounts: stubAccounts,
        added: slice.filter(e => e.kind === "added").map(e => e.txn), modified: slice.filter(e => e.kind === "modified").map(e => e.txn),
        removed: slice.filter(e => e.kind === "removed").map(e => ({ transaction_id: e.txn.transaction_id })),
        next_cursor: `c${next}`, has_more: next < events.length, request_id: "r",
      });
    }
    return respond(404, { error_type: "INVALID_REQUEST", error_code: "UNKNOWN_ENDPOINT", request_id: "r" });
  };
  return {
    fetch, calls, accessToken, itemId, failures,
    get removed() { return removed; },
    add: (...t: StubTxn[]) => t.forEach(x => events.push({ kind: "added", txn: x })),
    modify: (...t: StubTxn[]) => t.forEach(x => events.push({ kind: "modified", txn: x })),
    remove: (...ids: string[]) => ids.forEach(id => events.push({ kind: "removed", txn: txn(id) })),
    syncCursors: () => calls.filter(c => c.path === "/transactions/sync").map(c => (c.body.cursor as string | undefined) ?? null),
  };
}

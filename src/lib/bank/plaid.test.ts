import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_TOKEN, plaidStub, txn } from "../../../test/plaid-stub";
import { PLAID_BASE_URL, PlaidError, createPlaidProvider } from "./plaid";

const creds = { clientId: "test-client-id", secret: "test-secret-value" };
const actor = { id: "user-123", role: "user" as const };
afterEach(() => vi.restoreAllMocks());

function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((l) => void lines.push(String(l)));
  vi.spyOn(console, "error").mockImplementation((l) => void lines.push(String(l)));
  return lines;
}

describe("plaid client (mocked fetch)", () => {
  it("only talks to the hard-coded sandbox host, with credentials in headers, never in the body", async () => {
    const stub = plaidStub();
    const plaid = createPlaidProvider(creds, { fetch: stub.fetch });
    await plaid.createLinkToken(actor);
    expect(PLAID_BASE_URL).toBe("https://sandbox.plaid.com");
    const [call] = stub.calls;
    expect(call.path).toBe("/link/token/create");
    expect(call.headers["PLAID-CLIENT-ID"]).toBe("test-client-id");
    expect(JSON.stringify(call.body)).not.toContain("test-secret-value");
    expect(call.body).toMatchObject({ products: ["transactions"], country_codes: ["US"] });
  });

  it("sends an opaque hash instead of our user id", async () => {
    const stub = plaidStub();
    await createPlaidProvider(creds, { fetch: stub.fetch }).createLinkToken(actor);
    const id = (stub.calls[0].body.user as { client_user_id: string }).client_user_id;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain("user-123");
  });

  it("exchange returns at once, with no institution lookup, so the token can be stored first", async () => {
    const stub = plaidStub();
    const ok = await createPlaidProvider(creds, { fetch: stub.fetch }).exchange(PUBLIC_TOKEN);
    expect(ok).toEqual({ itemId: stub.itemId, institutionName: "Plaid Sandbox", accessToken: stub.accessToken });
    expect(stub.calls.map(c => c.path)).toEqual(["/item/public_token/exchange"]);
  });

  it("looks the institution name up separately, and a failure or slow answer just yields null", async () => {
    const stub = plaidStub();
    expect(await createPlaidProvider(creds, { fetch: stub.fetch }).lookupInstitution!(stub.accessToken)).toBe("First Platypus Bank");

    captureLogs();
    const failing = plaidStub();
    failing.failures.push({ path: "/item/get", code: "INTERNAL_SERVER_ERROR", status: 500 });
    expect(await createPlaidProvider(creds, { fetch: failing.fetch }).lookupInstitution!(failing.accessToken)).toBeNull();

    // A hanging lookup is cut off by its own short timeout, not the 10 s request timeout.
    const started = Date.now();
    const hang = createPlaidProvider(creds, {
      institutionTimeoutMs: 30,
      fetch: (_url, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")))),
    });
    expect(await hang.lookupInstitution!("t")).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("pages /transactions/sync by cursor and maps Plaid fields to ours", async () => {
    const stub = plaidStub();
    stub.add(txn("t1"), txn("t2", { name: null, merchant_name: null, iso_currency_code: null, personal_finance_category: null }), txn("t3"));
    stub.modify(txn("t3", { pending: true, pending_transaction_id: "t1" }));
    stub.remove("t2");
    const plaid = createPlaidProvider(creds, { fetch: stub.fetch });
    const p1 = await plaid.sync(stub.accessToken, null, 500);
    expect(p1.has_more).toBe(true);
    expect(p1.next_cursor).toBe("c2");
    expect(p1.accounts.map(a => a.mask)).toEqual(["0000", "0000"]); // a null mask becomes 0000
    expect(p1.accounts[1]).toMatchObject({ current: 410, available: null });
    expect(p1.added[1]).toMatchObject({ name: "Unknown", merchant_name: null, iso_currency_code: "XXX", personal_finance_category: null });
    const p2 = await plaid.sync(stub.accessToken, p1.next_cursor, 500);
    expect(p2.has_more).toBe(true);
    const p3 = await plaid.sync(stub.accessToken, p2.next_cursor, 500);
    expect(p3.has_more).toBe(false);
    expect(p3.removed).toEqual([{ transaction_id: "t2" }]);
    expect(stub.syncCursors()).toEqual([null, "c2", "c4"]);
    // The cursor is omitted on the first call and the page size is capped at Plaid's maximum.
    expect(stub.calls[0].body).not.toHaveProperty("cursor");
    await plaid.sync(stub.accessToken, null, 9999);
    expect(stub.calls.at(-1)!.body.count).toBe(500);
  });

  it("surfaces Plaid's code (for the mutation restart) without any upstream text, in the error or the logs", async () => {
    const logs = captureLogs();
    const stub = plaidStub();
    stub.failures.push({ path: "/transactions/sync", code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", type: "TRANSACTIONS_ERROR", echo: "Bearer abc" });
    const plaid = createPlaidProvider(creds, { fetch: stub.fetch });
    const err = await plaid.sync(stub.accessToken, "c2", 500).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaidError);
    expect(err).toMatchObject({ code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", errorType: "TRANSACTIONS_ERROR", requestId: "req-abc123", status: 502 });
    const everything = JSON.stringify([String((err as Error).message), logs]);
    expect(everything).not.toContain(stub.accessToken);
    expect(everything).not.toContain("access-sandbox-");
    expect(everything).not.toContain("secret detail");
    expect(everything).not.toContain("test-secret-value");
    expect(logs.join("\n")).toContain("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
  });

  it("rejects unsafe error codes, malformed bodies and non-JSON responses", async () => {
    const logs = captureLogs();
    const bad = (body: string, status = 500) => createPlaidProvider(creds, { fetch: async () => new Response(body, { status }) });
    await expect(bad(JSON.stringify({ error_code: "x\nINJECT", request_id: "has space" })).sync("t", null, 10)).rejects.toMatchObject({ code: "UNKNOWN", requestId: null });
    await expect(bad("<html>502</html>", 502).sync("t", null, 10)).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(bad(JSON.stringify({ added: "nope" }), 200).sync("t", null, 10)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(logs.join("\n")).not.toContain("INJECT");
  });

  it("times out and does not follow redirects", async () => {
    captureLogs();
    const hang = createPlaidProvider(creds, {
      timeoutMs: 20,
      fetch: (_url, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")))),
    });
    await expect(hang.createLinkToken(actor)).rejects.toMatchObject({ code: "TIMEOUT", status: 504 });
    const seen = vi.fn(async (_u: string, init: RequestInit) => { expect(init.redirect).toBe("error"); return new Response("{}", { status: 200 }); });
    await createPlaidProvider(creds, { fetch: seen }).remove("t");
    expect(seen).toHaveBeenCalled();
  });

  it("removes an item, and treats an already-removed item as success", async () => {
    const stub = plaidStub();
    const plaid = createPlaidProvider(creds, { fetch: stub.fetch });
    await plaid.remove(stub.accessToken);
    expect(stub.removed).toBe(true);
    await expect(plaid.remove(stub.accessToken)).resolves.toBeUndefined(); // ITEM_NOT_FOUND
    captureLogs();
    const other = plaidStub();
    other.failures.push({ path: "/item/remove", code: "INTERNAL_SERVER_ERROR", status: 500 });
    await expect(createPlaidProvider(creds, { fetch: other.fetch }).remove(other.accessToken)).rejects.toBeInstanceOf(PlaidError);
  });

  it("refuses to sync or remove without a token", async () => {
    const plaid = createPlaidProvider(creds, { fetch: plaidStub().fetch });
    await expect(plaid.sync(null, null, 10)).rejects.toMatchObject({ code: "MISSING_TOKEN" });
    await expect(plaid.remove(null)).rejects.toMatchObject({ code: "MISSING_TOKEN" });
  });
});

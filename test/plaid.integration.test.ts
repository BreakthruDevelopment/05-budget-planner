import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_TOKEN, plaidStub, txn } from "./plaid-stub";

const url = process.env.TEST_DATABASE_URL;
const alice = { id: "plaid-alice", role: "user" as const };
const bob = { id: "plaid-bob", role: "user" as const };
const admin = { id: "plaid-admin", role: "admin" as const };
const creds = { clientId: "test-client-id", secret: "test-secret-value" };
const saved = { key: process.env.TOKEN_ENC_KEY, id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, bp: process.env.BANK_PROVIDER };

describe.skipIf(!url)("Plaid bank sync (Postgres, stubbed Plaid)", () => {
  let sql: postgres.Sql;
  let bank: typeof import("@/lib/bank/items");
  let secrets: typeof import("@/lib/bank/secrets");
  let plaidMod: typeof import("@/lib/bank/plaid");
  let http: typeof import("@/lib/http");
  const connect = async (stub: ReturnType<typeof plaidStub>, actor = alice) =>
    bank.connectPlaid(actor, { publicToken: PUBLIC_TOKEN }, plaidMod.createPlaidProvider(creds, { fetch: stub.fetch }));
  const providerOf = (stub: ReturnType<typeof plaidStub>) => plaidMod.createPlaidProvider(creds, { fetch: stub.fetch });
  const txns = (itemId: string) => sql`select provider_txn_id, amount_cents, category_source, category_slug, pending from txn where item_id=${itemId} order by provider_txn_id`;
  const clearRate = () => sql`delete from rate_event where user_id in (${alice.id},${bob.id},${admin.id})`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.TOKEN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.PLAID_CLIENT_ID = creds.clientId; process.env.PLAID_SECRET = creds.secret; delete process.env.BANK_PROVIDER;
    sql = postgres(url!, { max: 5, onnotice: () => {} });
    await sql`delete from "user" where id like 'plaid-%'`;
    for (const u of [alice, bob, admin]) await sql`insert into "user" (id,name,email,role) values (${u.id},${u.id},${u.id + "@test.local"},${u.role})`;
    bank = await import("@/lib/bank/items"); secrets = await import("@/lib/bank/secrets");
    plaidMod = await import("@/lib/bank/plaid"); http = await import("@/lib/http");
  });
  beforeEach(async () => {
    await sql`delete from bank_item where owner_id in (${alice.id},${bob.id},${admin.id})`;
    await clearRate();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await sql`delete from "user" where id like 'plaid-%'`; await sql.end();
    for (const [k, v] of [["TOKEN_ENC_KEY", saved.key], ["PLAID_CLIENT_ID", saved.id], ["PLAID_SECRET", saved.secret], ["BANK_PROVIDER", saved.bp]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("connect -> sync -> disconnect works end to end, and no log line or error body holds a token", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => void logs.push(String(l)));
    vi.spyOn(console, "error").mockImplementation((l) => void logs.push(String(l)));
    const stub = plaidStub();
    stub.add(txn("t1"), txn("t2", { amount: -2500, personal_finance_category: { primary: "INCOME" } }), txn("t3"), txn("t4", { pending: true }));
    stub.modify(txn("t4-posted", { pending_transaction_id: "t4" }));
    stub.remove("t3");
    const connected = await connect(stub);
    expect(connected.item).toMatchObject({ provider: "plaid", institutionName: "First Platypus Bank", status: "active" });
    expect(connected.sync).toMatchObject({ added: 4, modified: 1, removed: 1, more: false });
    const rows = await txns(connected.item.id);
    expect(rows.map(r => r.provider_txn_id)).toEqual(["t1", "t2", "t4-posted"]); // removed gone, pending replaced by posted
    expect(Number(rows[0].amount_cents)).toBe(-1234); // Plaid positive = money out, stored negative
    expect(Number(rows[1].amount_cents)).toBe(250000);
    expect(JSON.stringify(connected)).not.toContain(stub.accessToken);

    // A failing call must not echo the token either, in the response body or in logs.
    stub.failures.push({ path: "/transactions/sync", code: "INTERNAL_SERVER_ERROR", status: 500 });
    await clearRate();
    const failure = await bank.syncItem(alice, connected.item.id, providerOf(stub)).catch((e: unknown) => e);
    const info = http.errorInfo(failure);
    expect(info.status).toBe(502);

    await clearRate();
    await bank.disconnectItem(alice, connected.item.id, providerOf(stub));
    expect(stub.removed).toBe(true);
    expect(stub.calls.some(c => c.path === "/item/remove" && c.body.access_token === stub.accessToken)).toBe(true);
    expect(await sql`select 1 from bank_item_secret where owner_id=${alice.id}`).toHaveLength(0);
    expect(await txns(connected.item.id)).toHaveLength(0);

    const everything = JSON.stringify([logs, info]);
    expect(everything).not.toContain(stub.accessToken);
    expect(everything).not.toContain("access-sandbox-");
    expect(everything).not.toContain(PUBLIC_TOKEN);
    expect(everything).not.toContain("test-secret-value");
    expect(everything).not.toContain("secret detail");
  });

  it("stores the access token encrypted with a row-bound key id, in a table nothing else reads", async () => {
    const stub = plaidStub();
    const { item } = await connect(stub);
    const [secret] = await sql`select * from bank_item_secret where item_id=${item.id}`;
    const stored = Buffer.from(secret.blob).toString("utf8");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(stub.accessToken);
    expect(Buffer.from(secret.blob).includes(Buffer.from("access-sandbox-"))).toBe(false);
    expect(secret.kid).toBe(stored.split(".")[1]);
    expect(secret.owner_id).toBe(alice.id);
    // The item row, the list view and the API shape carry no ciphertext or token.
    const listed = await bank.listBankItems(alice);
    expect(JSON.stringify(listed)).not.toContain(stored);
    expect(JSON.stringify(listed)).not.toContain(stub.accessToken);
    // The one decrypt path round-trips.
    await secrets.withAccessToken(alice, item.id, async token => { expect(token).toBe(stub.accessToken); });
    // Ciphertext differs per encryption (fresh DEK and IVs).
    const other = plaidStub();
    expect(other.accessToken).not.toBe(stub.accessToken);
  });

  it("enforces ownership: owner allowed, other user and admin get 404 on the item, sync, disconnect and token", async () => {
    const stub = plaidStub();
    stub.add(txn("t1"));
    const { item } = await connect(stub);
    expect((await bank.getItem(alice, item.id)).id).toBe(item.id);
    const before = stub.calls.length;
    for (const actor of [bob, admin]) {
      await expect(bank.getItem(actor, item.id)).rejects.toMatchObject({ status: 404 });
      await expect(bank.syncItem(actor, item.id, providerOf(stub))).rejects.toMatchObject({ status: 404 });
      await expect(bank.disconnectItem(actor, item.id, providerOf(stub))).rejects.toMatchObject({ status: 404 });
      expect(await bank.listBankItems(actor)).toEqual([]);
      // Even calling the token path directly never yields another user's token.
      await expect(secrets.withAccessToken(actor, item.id, async t => t)).rejects.toMatchObject({ status: 409 });
    }
    expect(stub.calls.length).toBe(before); // nothing reached Plaid on their behalf
    await clearRate();
    await expect(bank.syncItem(alice, item.id, providerOf(stub))).resolves.toMatchObject({ more: false });
    await clearRate();
    await bank.disconnectItem(alice, item.id, providerOf(stub));
  });

  it("a ciphertext moved to another row or user fails to decrypt, and nothing is sent to Plaid", async () => {
    const a = plaidStub(), b = plaidStub(), c = plaidStub();
    const itemA = (await connect(a)).item, itemB = (await connect(b)).item, itemC = (await connect(c, bob)).item;
    await clearRate();
    const [{ blob }] = await sql`select blob from bank_item_secret where item_id=${itemA.id}`;
    // Same owner, different row.
    await sql`update bank_item_secret set blob=${blob} where item_id=${itemB.id}`;
    // Different owner, different row.
    await sql`update bank_item_secret set blob=${blob} where item_id=${itemC.id}`;
    const callsB = b.calls.length, callsC = c.calls.length;
    await expect(bank.syncItem(alice, itemB.id, providerOf(b))).rejects.toMatchObject({ name: "EnvelopeError", message: "Decryption failed" });
    await expect(bank.syncItem(bob, itemC.id, providerOf(c))).rejects.toMatchObject({ name: "EnvelopeError" });
    expect(b.calls.length).toBe(callsB);
    expect(c.calls.length).toBe(callsC);
    // The original row still works, and a failed decrypt released the sync lease.
    await expect(bank.syncItem(alice, itemA.id, providerOf(a))).resolves.toBeTruthy();
    const [lease] = await sql`select syncing_since from bank_item where id=${itemB.id}`;
    expect(lease.syncing_since).toBeNull();
    expect(http.errorInfo(await bank.syncItem(alice, itemB.id, providerOf(b)).catch((e: unknown) => e)).status).toBe(500);
  });

  it("when the token can't be decrypted (key lost) the owner can still delete locally, with a log line and no Plaid call", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => void logs.push(String(l)));
    vi.spyOn(console, "error").mockImplementation((l) => void logs.push(String(l)));
    const stub = plaidStub();
    const { item } = await connect(stub);
    const calls = stub.calls.length, key = process.env.TOKEN_ENC_KEY;
    process.env.TOKEN_ENC_KEY = randomBytes(32).toString("base64"); // the old key is gone
    try {
      await bank.disconnectItem(alice, item.id, providerOf(stub));
    } finally { process.env.TOKEN_ENC_KEY = key; }
    expect(stub.calls.length).toBe(calls);
    expect(await sql`select 1 from bank_item where id=${item.id}`).toHaveLength(0);
    expect(await sql`select 1 from bank_item_secret where item_id=${item.id}`).toHaveLength(0);
    const out = logs.join("\n");
    expect(out).toContain("bank.item.disconnect_without_revoke");
    expect(out).toContain("token_undecryptable");
    expect(out).not.toContain(stub.accessToken);
    // Still owner-only: nobody else can use this escape hatch.
    const other = plaidStub();
    const { item: mine } = await connect(other);
    for (const actor of [bob, admin]) await expect(bank.disconnectItem(actor, mine.id, providerOf(other))).rejects.toMatchObject({ status: 404 });
  });

  it("sync is idempotent: a second sync and a full replay from a null cursor leave identical rows", async () => {
    const stub = plaidStub();
    stub.add(txn("t1"), txn("t2"), txn("t3"));
    stub.modify(txn("t2", { name: "Renamed", merchant_name: "Renamed" }));
    const { item } = await connect(stub);
    const first = await txns(item.id);
    await clearRate();
    await bank.syncItem(alice, item.id, providerOf(stub));
    expect(await txns(item.id)).toEqual(first);
    await sql`update bank_item set cursor=null where id=${item.id}`; // a retry that lost the saved cursor
    await bank.syncItem(alice, item.id, providerOf(stub));
    expect(await txns(item.id)).toEqual(first);
    expect(first).toHaveLength(3);
  });

  it("resumes from the saved cursor, applies removals, and keeps a user category through the update", async () => {
    const stub = plaidStub();
    stub.add(txn("t1"), txn("t2"));
    const { item } = await connect(stub);
    expect(stub.syncCursors()).toEqual([null]);
    await sql`update txn set category_slug='dining', category_source='user' where item_id=${item.id} and provider_txn_id='t1'`;
    stub.modify(txn("t1", { amount: 99 }));
    stub.remove("t2");
    await clearRate();
    const r = await bank.syncItem(alice, item.id, providerOf(stub));
    expect(stub.syncCursors().at(-1)).toBe("c2"); // continued from the stored cursor, not from scratch
    expect(r).toMatchObject({ modified: 1, removed: 1 });
    const rows = await txns(item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider_txn_id: "t1", category_slug: "dining", category_source: "user" });
    expect(Number(rows[0].amount_cents)).toBe(-9900);
  });

  it("restarts from the cursor the loop began with when Plaid reports a mutation during pagination", async () => {
    const stub = plaidStub();
    stub.add(txn("t1"), txn("t2"));
    const { item } = await connect(stub);
    stub.add(txn("t3"), txn("t4"), txn("t5"), txn("t6"));
    const cursorBefore = stub.syncCursors().length;
    // Fail the second page of the next sync only.
    const real = stub.fetch; let syncs = 0;
    const flaky = async (input: string, init: RequestInit) => {
      if (input.endsWith("/transactions/sync") && ++syncs === 2) stub.failures.push({ path: "/transactions/sync", code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", type: "TRANSACTIONS_ERROR" });
      return real(input, init);
    };
    await clearRate();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await bank.syncItem(alice, item.id, plaidMod.createPlaidProvider(creds, { fetch: flaky }));
    const cursors = stub.syncCursors().slice(cursorBefore);
    expect(cursors).toEqual(["c2", "c4", "c2", "c4"]); // the second page failed; the sync restarted from its starting cursor c2
    expect(r.more).toBe(false);
    expect((await txns(item.id)).map(x => x.provider_txn_id)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
  });

  it("marks an item login_required when Plaid says so, with a clear 409", async () => {
    const stub = plaidStub();
    const { item } = await connect(stub);
    stub.failures.push({ path: "/transactions/sync", code: "ITEM_LOGIN_REQUIRED", type: "ITEM_ERROR" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await clearRate();
    await expect(bank.syncItem(alice, item.id, providerOf(stub))).rejects.toMatchObject({ status: 409 });
    expect((await bank.getItem(alice, item.id)).status).toBe("login_required");
  });

  it("falls back to the demo bank when Plaid keys are absent or the key is 31 bytes, and demo connect still works", async () => {
    const providerMod = await import("@/lib/bank/provider");
    const key = process.env.TOKEN_ENC_KEY;
    try {
      vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
      for (const setup of [() => { delete process.env.PLAID_SECRET; }, () => { process.env.PLAID_SECRET = creds.secret; process.env.TOKEN_ENC_KEY = randomBytes(31).toString("base64"); }]) {
        process.env.PLAID_CLIENT_ID = creds.clientId; process.env.PLAID_SECRET = creds.secret; process.env.TOKEN_ENC_KEY = key;
        setup();
        expect(providerMod.bankMode()).toBe("demo");
        await expect(bank.connectBank(alice, { publicToken: PUBLIC_TOKEN })).rejects.toMatchObject({ status: 409 });
        await expect(bank.createLinkToken(alice)).rejects.toMatchObject({ status: 409 });
        await clearRate();
        const demo = await bank.connectBank(alice, { demo: true });
        expect(demo.item.provider).toBe("demo");
        expect(await sql`select 1 from bank_item_secret where owner_id=${alice.id}`).toHaveLength(0); // demo stores no token
        await bank.disconnectItem(alice, demo.item.id);
      }
    } finally {
      process.env.PLAID_SECRET = creds.secret; process.env.TOKEN_ENC_KEY = key;
    }
  });

  it("while Plaid is disabled an item can't sync (409), but the owner can still delete it locally, logged", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => void logs.push(String(l)));
    vi.spyOn(console, "error").mockImplementation((l) => void logs.push(String(l)));
    const stub = plaidStub();
    const { item } = await connect(stub);
    const calls = stub.calls.length, key = process.env.TOKEN_ENC_KEY;
    delete process.env.PLAID_SECRET;
    try {
      await clearRate();
      await expect(bank.syncItem(alice, item.id)).rejects.toMatchObject({ status: 409 });
      await expect(bank.disconnectItem(bob, item.id)).rejects.toMatchObject({ status: 404 });
      await bank.disconnectItem(alice, item.id);
    } finally { process.env.PLAID_SECRET = creds.secret; process.env.TOKEN_ENC_KEY = key; }
    expect(stub.calls.length).toBe(calls);
    expect(await sql`select 1 from bank_item_secret where item_id=${item.id}`).toHaveLength(0);
    expect(logs.join("\n")).toContain("provider_disabled");
  });

  it("rejects anything but a sandbox public token before any Plaid call", async () => {
    const stub = plaidStub();
    for (const bad of ["", "public-production-abcdefgh12", "access-sandbox-abcdefgh12", "public-sandbox-short", { publicToken: PUBLIC_TOKEN, extra: 1 }]) {
      await expect(bank.connectPlaid(alice, typeof bad === "object" ? bad : { publicToken: bad }, providerOf(stub))).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("limits exchanges (5 per hour), link tokens (10 per hour) and items (3), all per user", async () => {
    const mk = () => plaidStub();
    // Link tokens
    const link = providerOf(mk());
    for (let i = 0; i < 10; i++) await bank.createLinkToken(alice, link);
    await expect(bank.createLinkToken(alice, link)).rejects.toMatchObject({ status: 429 });
    await expect(bank.createLinkToken(bob, link)).resolves.toEqual({ linkToken: "link-sandbox-test" }); // another user is unaffected
    // Items: 3 allowed, the 4th is refused before the exchange call.
    for (let i = 0; i < 3; i++) await connect(mk());
    const fourth = mk();
    await expect(connect(fourth)).rejects.toMatchObject({ status: 429 });
    expect(fourth.calls).toHaveLength(0);
    // Exchanges: attempts count even when they fail.
    await sql`delete from bank_item where owner_id=${alice.id}`; await clearRate();
    const wrong = providerOf(mk());
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) await expect(bank.connectPlaid(alice, { publicToken: "public-sandbox-ffffffff-0000" }, wrong)).rejects.toMatchObject({ status: 502 });
    await expect(bank.connectPlaid(alice, { publicToken: PUBLIC_TOKEN }, wrong)).rejects.toMatchObject({ status: 429 });
  });

  it("a duplicate exchange is a 409 and does not revoke the live item at Plaid", async () => {
    const first = plaidStub();
    await connect(first);
    const dup = plaidStub({ itemId: first.itemId });
    await expect(connect(dup, bob)).rejects.toMatchObject({ status: 409 });
    expect(dup.calls.some(c => c.path === "/item/remove")).toBe(false);
    expect(await bank.listBankItems(bob)).toEqual([]);
  });

  it("removes the orphaned item at Plaid when storing it fails", async () => {
    const stub = plaidStub();
    const key = process.env.TOKEN_ENC_KEY;
    // Exchange succeeds, then the key breaks before the token can be stored.
    const breaking = async (input: string, init: RequestInit) => {
      const res = await stub.fetch(input, init);
      if (input.endsWith("/item/public_token/exchange")) process.env.TOKEN_ENC_KEY = "broken";
      return res;
    };
    try {
      await expect(bank.connectPlaid(alice, { publicToken: PUBLIC_TOKEN }, plaidMod.createPlaidProvider(creds, { fetch: breaking }))).rejects.toBeTruthy();
    } finally { process.env.TOKEN_ENC_KEY = key; }
    expect(stub.removed).toBe(true);
    expect(await bank.listBankItems(alice)).toEqual([]);
  });

  it("connect keeps the item and returns the sync error when the first sync fails, so the one-time public token isn't wasted", async () => {
    // Sync limit already used up: the first sync is refused with 429.
    await sql`insert into rate_event (user_id, kind) select ${alice.id}, 'sync' from generate_series(1,6)`;
    const stub = plaidStub();
    stub.add(txn("t1"));
    const res = await connect(stub);
    expect(res.item).toMatchObject({ provider: "plaid", status: "active" });
    expect(res.sync).toMatchObject({ more: true, added: 0, error: "Refresh limit reached. Try again later.", status: 429 });
    expect(stub.calls.filter(c => c.path === "/item/public_token/exchange")).toHaveLength(1);
    expect(stub.removed).toBe(false);
    expect(await sql`select 1 from bank_item_secret where item_id=${res.item.id}`).toHaveLength(1);
    // The UI continues with a normal refresh.
    await clearRate();
    await expect(bank.syncItem(alice, res.item.id, providerOf(stub))).resolves.toMatchObject({ added: 1, more: false });

    // A Plaid failure during the first sync behaves the same way, without leaking upstream text.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = plaidStub();
    flaky.failures.push({ path: "/transactions/sync", code: "INTERNAL_SERVER_ERROR", status: 500, echo: "upstream words" });
    const second = await connect(flaky);
    expect(second.sync).toMatchObject({ more: true, status: 502 });
    expect(JSON.stringify(second)).not.toContain("upstream words");
    expect(JSON.stringify(second)).not.toContain(flaky.accessToken);
  });

  it("stores the encrypted token before the institution lookup, and a failed lookup keeps the default name", async () => {
    const stub = plaidStub();
    let storedAtLookup = -1;
    const real = stub.fetch;
    const watching = async (input: string, init: RequestInit) => {
      if (input.endsWith("/item/get")) {
        storedAtLookup = (await sql`select 1 from bank_item_secret where owner_id=${alice.id}`).length;
        stub.failures.push({ path: "/item/get", code: "INTERNAL_SERVER_ERROR", status: 500 });
      }
      return real(input, init);
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await bank.connectPlaid(alice, { publicToken: PUBLIC_TOKEN }, plaidMod.createPlaidProvider(creds, { fetch: watching }));
    expect(storedAtLookup).toBe(1);
    expect(res.item.institutionName).toBe("Plaid Sandbox");
    expect(res.sync).not.toHaveProperty("error");
  });

  it("limits the first sync to the time left in the request: with almost none left it skips the sync and says more: true", async () => {
    const stub = plaidStub();
    stub.add(txn("t1"));
    const real = stub.fetch;
    let offset = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const slow = async (input: string, init: RequestInit) => { const r = await real(input, init); if (input.endsWith("/item/public_token/exchange")) offset = 23_500; return r; };
    try {
      const res = await bank.connectPlaid(alice, { publicToken: PUBLIC_TOKEN }, plaidMod.createPlaidProvider(creds, { fetch: slow }));
      expect(res.sync).toEqual({ added: 0, modified: 0, removed: 0, more: true });
      expect(stub.syncCursors()).toEqual([]);
      expect(res.item.id).toBeTruthy();
    } finally { offset = 0; }
    vi.restoreAllMocks();
    await clearRate();
    const [{ id }] = await sql`select id from bank_item where owner_id=${alice.id}`;
    await expect(bank.syncItem(alice, id, providerOf(stub))).resolves.toMatchObject({ added: 1, more: false });
  });

  it("puts the stored cursor back to the loop's starting cursor on a mutation error, including when the restart budget runs out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = plaidStub();
    stub.add(txn("t1"), txn("t2"), txn("t3"), txn("t4"), txn("t5"), txn("t6"));
    const { item } = await connect(stub);
    expect((await bank.getItem(alice, item.id)).cursor).toBe("c6");
    stub.add(txn("t7"), txn("t8"), txn("t9"), txn("t10"));
    const real = stub.fetch; let syncs = 0; const storedDuringRestarts: (string | null)[] = [];
    const flaky = async (input: string, init: RequestInit) => {
      if (input.endsWith("/transactions/sync")) {
        syncs++;
        if (syncs === 2) for (let i = 0; i < 3; i++) stub.failures.push({ path: "/transactions/sync", code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", type: "TRANSACTIONS_ERROR" });
        if (syncs >= 3) storedDuringRestarts.push((await sql`select cursor from bank_item where id=${item.id}`)[0].cursor);
      }
      return real(input, init);
    };
    await clearRate();
    // page 1 applies (stored cursor moves to c8), then three mutation errors exhaust the 2 restarts.
    await expect(bank.syncItem(alice, item.id, plaidMod.createPlaidProvider(creds, { fetch: flaky }))).rejects.toMatchObject({ code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" });
    expect(storedDuringRestarts).toEqual(["c6", "c6"]); // reset before each restart, not left mid-loop at c8
    expect((await bank.getItem(alice, item.id)).cursor).toBe("c6");
    expect((await bank.getItem(alice, item.id)).syncingSince).toBeNull();
    // The next sync starts from the loop-start cursor and finishes.
    const before = stub.syncCursors().length;
    await clearRate();
    await expect(bank.syncItem(alice, item.id, providerOf(stub))).resolves.toMatchObject({ added: 4, more: false });
    expect(stub.syncCursors().slice(before)[0]).toBe("c6");
    expect(await txns(item.id)).toHaveLength(10);
  });

  it("disconnect calls Plaid with no transaction open and no second pool connection held, and takes a lease against concurrent work", async () => {
    const stub = plaidStub();
    const { item } = await connect(stub);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void; const inRemove = new Promise<void>(r => { entered = r; });
    const gated = { ...providerOf(stub), remove: async (t: string | null) => { entered(); await gate; return providerOf(stub).remove(t); } };
    await clearRate();
    const done = bank.disconnectItem(alice, item.id, gated);
    await inRemove;
    const [{ n }] = await sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and (state like 'idle in transaction%' or xact_start is not null)`;
    expect(n).toBe(0); // nothing is mid-transaction while Plaid is being called
    await expect(bank.syncItem(alice, item.id, providerOf(stub))).rejects.toMatchObject({ status: 409 });
    await expect(bank.disconnectItem(alice, item.id, providerOf(stub))).rejects.toMatchObject({ status: 409 });
    release(); await done;
    expect(stub.removed).toBe(true);
    expect(await sql`select 1 from bank_item where id=${item.id}`).toHaveLength(0);
    expect(await sql`select 1 from bank_item_secret where item_id=${item.id}`).toHaveLength(0);
  });

  it("a failed Plaid removal releases the lease and keeps the item and token, so disconnect can be retried", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = plaidStub();
    const { item } = await connect(stub);
    stub.failures.push({ path: "/item/remove", code: "INTERNAL_SERVER_ERROR", status: 500 });
    await expect(bank.disconnectItem(alice, item.id, providerOf(stub))).rejects.toMatchObject({ status: 502 });
    const [row] = await sql`select syncing_since from bank_item where id=${item.id}`;
    expect(row.syncing_since).toBeNull();
    expect(await sql`select 1 from bank_item_secret where item_id=${item.id}`).toHaveLength(1);
    await bank.disconnectItem(alice, item.id, providerOf(stub));
    expect(stub.removed).toBe(true);
    expect(await sql`select 1 from bank_item where id=${item.id}`).toHaveLength(0);
  });

  it("rewraps the stored blob under the current key the first time the token is used after a rotation", async () => {
    const envelope = await import("@/lib/crypto/envelope");
    const stub = plaidStub();
    const { item } = await connect(stub);
    const [before] = await sql`select blob, kid from bank_item_secret where item_id=${item.id}`;
    const oldKey = process.env.TOKEN_ENC_KEY!;
    const newKey = randomBytes(32).toString("base64");
    process.env.TOKEN_ENC_KEY = newKey; process.env.TOKEN_ENC_KEY_PREVIOUS = oldKey;
    try {
      const newId = envelope.validateEncryptionEnv().currentKeyId;
      expect(newId).not.toBe(before.kid);
      await secrets.withAccessToken(alice, item.id, async t => { expect(t).toBe(stub.accessToken); });
      const [after] = await sql`select blob, kid from bank_item_secret where item_id=${item.id}`;
      expect(after.kid).toBe(newId);
      expect(Buffer.from(after.blob).toString("utf8").split(".")[1]).toBe(newId);
      expect(Buffer.from(after.blob).equals(Buffer.from(before.blob))).toBe(false);
      // The old key can now be retired.
      delete process.env.TOKEN_ENC_KEY_PREVIOUS;
      await secrets.withAccessToken(alice, item.id, async t => { expect(t).toBe(stub.accessToken); });
      // Rewrap is owner-scoped: another user's call can't touch the row.
      await expect(secrets.withAccessToken(bob, item.id, async t => t)).rejects.toMatchObject({ status: 409 });
    } finally { process.env.TOKEN_ENC_KEY = oldKey; delete process.env.TOKEN_ENC_KEY_PREVIOUS; }
  });
});

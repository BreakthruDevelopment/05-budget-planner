import "server-only";
import { randomUUID } from "node:crypto";
import { count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { errorInfo } from "@/lib/http";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { safeErrorFields } from "@/lib/safe-error";
import { advisoryLock, consumeRate, type Tx } from "@/lib/usage";
import { merchantKey, providerCategory } from "./categories";
import { demoBank } from "./demo";
import { PlaidError } from "./plaid";
import { providerFor, requirePlaid } from "./provider";
import { EnvelopeError } from "@/lib/crypto/envelope";
import { MissingSecretError, storeAccessToken, withAccessToken } from "./secrets";
import { type BankProvider, syncPage } from "./types";

const { bankItem, bankAccount, txn, categoryRule } = schema;
const uuid = z.uuid();
const permission = (actor: Actor, action: "read" | "create" | "update" | "delete") => assertCan(actor, action, { ownerId: actor.id });
export async function getItem(actor: Actor, id: string) {
  permission(actor, "read");
  const [item] = await db().select().from(bankItem).where(ownedBy(bankItem, actor, eq(bankItem.id, uuid.parse(id))));
  if (!item) throw new NotFoundError();
  return item;
}
export async function listBankItems(actor: Actor) {
  permission(actor, "read");
  const items = await db().select().from(bankItem).where(ownedBy(bankItem, actor));
  const accounts = await db().select().from(bankAccount).where(ownedBy(bankAccount, actor));
  return items.map(item => ({ ...item, accounts: accounts.filter(a => a.itemId === item.id) }));
}
export const connectInput = z.union([z.object({ demo: z.literal(true) }).strict(), z.object({ publicToken: z.literal("demo") }).strict()]);
export async function connectDemo(actor: Actor, input: unknown) {
  permission(actor, "create"); connectInput.parse(input);
  const item = await db().transaction(async tx => {
    await advisoryLock(tx, `items:${actor.id}`);
    const [{ n }] = await tx.select({ n: count() }).from(bankItem).where(ownedBy(bankItem, actor));
    if (n >= 3) throw new TooManyRequestsError("At most three bank items are allowed.");
    const exchanged = await demoBank.exchange("demo");
    const [row] = await tx.insert(bankItem).values({ ownerId: actor.id, provider: "demo", providerItemId: exchanged.itemId, institutionName: exchanged.institutionName }).returning();
    return row;
  });
  // Sync failure leaves a retryable item, never an unreachable orphan.
  const result = await syncItem(actor, item.id);
  return { item: await getItem(actor, item.id), sync: result };
}

/** Plaid sandbox public tokens only; anything else is rejected before a provider call. */
const plaidConnectInput = z.object({ publicToken: z.string().regex(/^public-sandbox-[A-Za-z0-9-]{8,200}$/) }).strict();
const bankConnectInput = z.union([...connectInput.options, plaidConnectInput]);
const MAX_ITEMS = 3;

/** Routes and actions call this: `{demo:true}` / `{publicToken:"demo"}` use the demo bank, a Plaid public token uses Plaid. */
export async function connectBank(actor: Actor, input: unknown, plaid?: BankProvider) {
  const parsed = bankConnectInput.parse(input);
  if ("publicToken" in parsed && parsed.publicToken !== "demo") return connectPlaid(actor, parsed, plaid);
  return connectDemo(actor, parsed);
}

export async function createLinkToken(actor: Actor, plaid?: BankProvider) {
  permission(actor, "create");
  const provider = plaid ?? requirePlaid();
  await db().transaction(tx => consumeRate(tx, actor.id, "link_token", 10, "Link limit reached. Try again later."));
  return provider.createLinkToken(actor);
}

/** Lambda's hard limit is 29 s; connect answers inside 24 s so the response always gets out. */
const CONNECT_BUDGET_MS = 24_000;
export async function connectPlaid(actor: Actor, input: unknown, plaid?: BankProvider) {
  const startedAt = Date.now();
  permission(actor, "create");
  const { publicToken } = plaidConnectInput.parse(input);
  const provider = plaid ?? requirePlaid();
  const checkRoom = async (tx: Tx) => {
    await advisoryLock(tx, `items:${actor.id}`);
    const [{ n }] = await tx.select({ n: count() }).from(bankItem).where(ownedBy(bankItem, actor));
    if (n >= MAX_ITEMS) throw new TooManyRequestsError("At most three bank items are allowed.");
  };
  // Short transactions only: the Plaid calls below run outside any of them.
  await db().transaction(async tx => {
    await checkRoom(tx);
    await consumeRate(tx, actor.id, "exchange", 5, "Connect limit reached. Try again later.");
  });
  const exchanged = await provider.exchange(publicToken);
  const token = exchanged.accessToken;
  if (!token) throw new PlaidError("MISSING_TOKEN", "CLIENT", null);
  const id = randomUUID();
  // The public token is single use, so the access token is stored (encrypted) straight after the exchange,
  // in its own short transaction, before any other call.
  try {
    await db().transaction(async tx => {
      await checkRoom(tx);
      await tx.insert(bankItem).values({ id, ownerId: actor.id, provider: "plaid", providerItemId: exchanged.itemId, institutionName: exchanged.institutionName.slice(0, 80) });
      await storeAccessToken(tx, actor, id, token);
    });
  } catch (err) {
    // An item that already exists must not be revoked by a duplicate exchange; any other failure leaves an orphan at Plaid.
    if (safeErrorFields(err).constraint === "bank_item_provider_unique") throw new ConflictError("That bank connection already exists.");
    await provider.remove(token).catch(() => log.warn("bank.item.orphan_remove_failed", { provider: "plaid" }));
    throw err;
  }
  // From here the item exists and is retryable: nothing below may fail the request.
  if (provider.lookupInstitution) {
    const name = await provider.lookupInstitution(token).catch(() => null);
    if (name) await db().update(bankItem).set({ institutionName: name.slice(0, 80) }).where(ownedBy(bankItem, actor, eq(bankItem.id, id))).catch(() => undefined);
  }
  let sync: Awaited<ReturnType<typeof syncItem>> & { error?: string; status?: number };
  const left = CONNECT_BUDGET_MS - (Date.now() - startedAt);
  if (left < 1_000) sync = { added: 0, modified: 0, removed: 0, more: true };
  else {
    try { sync = await syncItem(actor, id, provider, { budgetMs: left }); }
    catch (err) {
      // e.g. rate limit or a Plaid hiccup: report it, keep the item, let the UI continue with a refresh.
      const info = errorInfo(err);
      sync = { added: 0, modified: 0, removed: 0, more: true, error: info.body.error, status: info.status };
    }
  }
  return { item: await getItem(actor, id), sync };
}

/** Claim is short-lived and committed before calling the provider. A fencing timestamp protects reclaimed leases. */
async function claim(actor: Actor, id: string, opts: { rate?: boolean } = {}) {
  return db().transaction(async tx => {
    const locked = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`sync:${id}`}, 0)) as locked`);
    if (!locked[0].locked) throw new ConflictError("Already syncing");
    const [item] = await tx.select().from(bankItem).where(ownedBy(bankItem, actor, eq(bankItem.id, id))).for("update");
    if (!item) throw new NotFoundError();
    if (item.syncingSince && item.syncingSince.getTime() > Date.now() - 60_000) throw new ConflictError("Already syncing");
    if (opts.rate !== false) await consumeRate(tx, actor.id, "sync", 6, "Refresh limit reached. Try again later.");
    const [updated] = await tx.update(bankItem).set({ syncingSince: sql`clock_timestamp()` }).where(ownedBy(bankItem, actor, eq(bankItem.id, id))).returning();
    return updated;
  });
}

async function applyPage(tx: Tx, actor: Actor, item: typeof bankItem.$inferSelect, page: z.infer<typeof syncPage>) {
  const [lease] = await tx.select().from(bankItem).where(ownedBy(bankItem, actor, eq(bankItem.id, item.id), eq(bankItem.syncingSince, item.syncingSince!))).for("update");
  if (!lease) throw new ConflictError("Sync lease expired. Refresh again.");
  const accounts = new Map<string, string>();
  for (const a of page.accounts) {
    const [row] = await tx.insert(bankAccount).values({ ownerId: actor.id, itemId: item.id, providerAccountId: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype, currentCents: Math.round(a.current * 100), availableCents: a.available === null ? null : Math.round(a.available * 100) })
      .onConflictDoUpdate({ target: [bankAccount.itemId, bankAccount.providerAccountId], set: { name: a.name, currentCents: Math.round(a.current * 100), availableCents: a.available === null ? null : Math.round(a.available * 100) } }).returning();
    accounts.set(a.account_id, row.id);
  }
  const existingAccounts = await tx.select().from(bankAccount).where(ownedBy(bankAccount, actor, eq(bankAccount.itemId, item.id)));
  for (const a of existingAccounts) accounts.set(a.providerAccountId, a.id);
  const rules = await tx.select().from(categoryRule).where(ownedBy(categoryRule, actor));
  for (const t of [...page.added, ...page.modified]) {
    const accountId = accounts.get(t.account_id);
    if (!accountId) throw new ConflictError("Bank returned an unknown account.");
    const key = merchantKey(t.merchant_name || t.name);
    const [existing] = await tx.select().from(txn).where(ownedBy(txn, actor, eq(txn.itemId, item.id), eq(txn.providerTxnId, t.transaction_id)));
    const [pending] = t.pending_transaction_id ? await tx.select().from(txn).where(ownedBy(txn, actor, eq(txn.itemId, item.id), eq(txn.providerTxnId, t.pending_transaction_id))) : [];
    // Category edits take the same per-user lock as imports, so no user edit can be lost during a page write.
    const protectedRows = [existing, pending].filter(Boolean);
    const protectedRow = protectedRows.find(r => r.categorySource === "user") ?? protectedRows.find(r => r.categorySource === "rule");
    const rule = rules.find(r => r.merchantKey === key);
    const mapped = providerCategory(t.personal_finance_category?.primary ?? null);
    const category = protectedRow ? { categorySlug: protectedRow.categorySlug, categorySource: protectedRow.categorySource } : rule ? { categorySlug: rule.categorySlug, categorySource: "rule" as const } : mapped ? { categorySlug: mapped, categorySource: "provider" as const } : existing?.categorySource === "ai" ? { categorySlug: existing.categorySlug, categorySource: "ai" as const } : { categorySlug: null, categorySource: "none" as const };
    const data = { ownerId: actor.id, itemId: item.id, accountId, providerTxnId: t.transaction_id, pendingTxnId: t.pending_transaction_id, date: t.date, name: t.name, merchantName: t.merchant_name, merchantKey: key,
      amountCents: -Math.round(t.amount * 100), isoCurrency: t.iso_currency_code, pending: t.pending, providerCategory: t.personal_finance_category?.primary ?? null, ...category, aiConfidence: category.categorySource === "ai" ? existing?.aiConfidence ?? null : null, updatedAt: new Date() };
    if (!existing) {
      const [{ n }] = await tx.select({ n: count() }).from(txn).where(ownedBy(txn, actor));
      if (n >= 5000 && !pending) throw new TooManyRequestsError("Transaction limit reached (5,000).");
    }
    const changed = !existing || Object.entries(data).some(([key, value]) => key !== "updatedAt" && existing[key as keyof typeof existing] !== value);
    if (changed) await tx.insert(txn).values(data).onConflictDoUpdate({ target: [txn.itemId, txn.providerTxnId], set: data });
    if (t.pending_transaction_id && t.pending_transaction_id !== t.transaction_id) await tx.delete(txn).where(ownedBy(txn, actor, eq(txn.itemId, item.id), eq(txn.providerTxnId, t.pending_transaction_id)));
  }
  if (page.removed.length) await tx.delete(txn).where(ownedBy(txn, actor, eq(txn.itemId, item.id), inArray(txn.providerTxnId, page.removed.map(r => r.transaction_id))));
  await tx.update(bankItem).set({ cursor: page.next_cursor, status: "active", lastSyncedAt: new Date() }).where(ownedBy(bankItem, actor, eq(bankItem.id, item.id)));
}

/** Provider injection is server-only; requests cannot choose a provider or bypass ownership/rate limits. */
export async function syncItem(actor: Actor, id: string, provider?: BankProvider, opts: { budgetMs?: number } = {}) {
  permission(actor, "update"); id = uuid.parse(id);
  // Resolve ownership before touching shared locks (also prevents lock contention revealing foreign ids).
  const owned = await getItem(actor, id);
  const impl = provider ?? providerFor(owned.provider); // 409 when the item's provider isn't enabled
  const item = await claim(actor, id);
  const startedCursor = item.cursor;
  const totals = { added: 0, modified: 0, removed: 0, more: true };
  // 20 s by default; connect passes what is left of its own request budget.
  const budgetMs = Math.max(1, Math.min(opts.budgetMs ?? 20_000, 20_000));
  const deadline = Date.now() + budgetMs;
  const signal = AbortSignal.timeout(budgetMs);
  // Plaid's restart rule needs the cursor the loop began with. Pages applied before a mutation error moved the
  // stored cursor mid-loop, so put it back: whatever ends this sync (budget, restart limit, crash) the next one
  // starts from a cursor Plaid will accept.
  const resetCursor = () => db().update(bankItem).set({ cursor: startedCursor }).where(ownedBy(bankItem, actor, eq(bankItem.id, id), eq(bankItem.syncingSince, item.syncingSince!)));
  const loop = async (token: string | null) => {
    let cursor = startedCursor, more = true, restarts = 0;
    while (more && Date.now() < deadline) {
      let page;
      try {
        // Bound even providers that ignore AbortSignal; only this loop writes to the database.
        page = syncPage.parse(await boundedSync(impl, token, cursor, signal));
      } catch (err) {
        const code = err instanceof Error && "code" in err ? err.code : undefined;
        // Plaid's rule: on a mutation during pagination, restart from the cursor this sync began with. Re-applying
        // pages is harmless because every write is an upsert keyed on the provider id.
        if (code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
          await resetCursor();
          if (restarts++ < 2) { cursor = startedCursor; continue; }
        }
        if (code === "ITEM_LOGIN_REQUIRED") {
          await db().update(bankItem).set({ status: "login_required" }).where(ownedBy(bankItem, actor, eq(bankItem.id, id)));
          throw new ConflictError("The bank needs you to sign in again. Disconnect and reconnect it.");
        }
        throw err;
      }
      if (page.has_more && page.next_cursor === cursor) throw new ConflictError("Bank cursor did not advance.");
      await db().transaction(async tx => {
        await advisoryLock(tx, `categories:${actor.id}`);
        await applyPage(tx, actor, item, page);
      });
      totals.added += page.added.length; totals.modified += page.modified.length; totals.removed += page.removed.length;
      cursor = page.next_cursor; more = page.has_more;
    }
    return { ...totals, more };
  };
  try {
    // Demo items have no token. Plaid items get theirs from withAccessToken, the only decrypt path.
    return owned.provider === "plaid" ? await withAccessToken(actor, id, loop) : await loop(null);
  } finally {
    await db().update(bankItem).set({ syncingSince: null }).where(ownedBy(bankItem, actor, eq(bankItem.id, id), eq(bankItem.syncingSince, item.syncingSince!)));
  }
}
async function boundedSync(provider: BankProvider, token: string | null, cursor: string | null, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([provider.sync(token, cursor, 500, signal), new Promise<never>((_, reject) => {
      abort = () => reject(new ConflictError("Refresh timed out. Try again to continue."));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
/**
 * Deletes the item at the provider first (Plaid `/item/remove`), then the local rows; the cascade removes the stored
 * token. No transaction is open while Plaid is called and only one pool connection is in use at a time (the AWS pool
 * is 2): a short lease claims the item, the token is decrypted and the provider called with no transaction open, and
 * a second short transaction deletes the rows. A failure before the delete releases the lease and keeps everything.
 *
 * Two cases let the owner delete locally without revoking at Plaid, each logged without token material: the stored
 * token can't be decrypted (the key was lost or changed), or Plaid isn't enabled so there is nothing to call it with.
 */
export async function disconnectItem(actor: Actor, id: string, provider?: BankProvider) {
  permission(actor, "delete");
  id = uuid.parse(id);
  const owned = await getItem(actor, id);
  const lease = (await claim(actor, id, { rate: false })).syncingSince!;
  try {
    if (owned.provider === "plaid") {
      let impl = provider;
      if (!impl) {
        try { impl = providerFor("plaid"); }
        catch (err) {
          if (!(err instanceof ConflictError)) throw err;
          log.warn("bank.item.disconnect_without_revoke", { provider: "plaid", reason: "provider_disabled" });
        }
      }
      if (impl) {
        const revoke = impl;
        try { await withAccessToken(actor, id, token => revoke.remove(token)); }
        catch (err) {
          if (err instanceof MissingSecretError) { /* no stored token, nothing to revoke */ }
          else if (err instanceof EnvelopeError) log.warn("bank.item.disconnect_without_revoke", { provider: "plaid", reason: "token_undecryptable" });
          else throw err;
        }
      }
    } else await (provider ?? demoBank).remove(null);
    const deleted = await db().delete(bankItem).where(ownedBy(bankItem, actor, eq(bankItem.id, id), eq(bankItem.syncingSince, lease))).returning({ id: bankItem.id });
    if (!deleted.length) throw new ConflictError("Disconnect timed out. Try again.");
  } catch (err) {
    await db().update(bankItem).set({ syncingSince: null }).where(ownedBy(bankItem, actor, eq(bankItem.id, id), eq(bankItem.syncingSince, lease)));
    throw err;
  }
}

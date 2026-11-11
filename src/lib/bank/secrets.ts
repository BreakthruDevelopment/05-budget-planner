import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { decrypt, encrypt, needsRewrap, rewrap, rowAad, validateEncryptionEnv } from "@/lib/crypto/envelope";
import { db, schema } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import type { Tx } from "@/lib/usage";

/**
 * Access tokens live only in `bank_item_secret`, envelope-encrypted, with AAD binding each ciphertext to its row
 * (`budget-planner:bank_item_secret:<item_id>:<owner_id>`): a blob copied to another row or user fails to decrypt.
 * No list query joins this table, and `withAccessToken` is the only caller of `decrypt`.
 */
const AAD_TABLE = "budget-planner:bank_item_secret";
const secretAad = (itemId: string, ownerId: string) => rowAad(AAD_TABLE, itemId, ownerId);

export class MissingSecretError extends ConflictError {
  constructor() { super("This bank connection has no stored credentials. Disconnect and reconnect it."); }
}

/** Call inside the transaction that inserts the `bank_item` row (the item id is part of the AAD). */
export async function storeAccessToken(tx: Tx, actor: Actor, itemId: string, accessToken: string): Promise<void> {
  const blob = encrypt(accessToken, secretAad(itemId, actor.id));
  await tx.insert(schema.bankItemSecret).values({ itemId, ownerId: actor.id, blob: Buffer.from(blob, "utf8"), kid: validateEncryptionEnv().currentKeyId });
}

/**
 * Decrypts the item's token for the owner, hands it to `fn` and keeps no reference afterwards. Never log or
 * return the token from `fn`. Another user's item, admin included, looks like a missing secret (409), and the
 * callers have already turned that into 404 by loading the item through `ownedBy` first.
 */
export async function withAccessToken<T>(actor: Actor, itemId: string, fn: (token: string) => Promise<T>): Promise<T> {
  assertCan(actor, "read", { ownerId: actor.id });
  const id = z.uuid().parse(itemId);
  const { bankItemSecret } = schema;
  const [row] = await db().select({ itemId: bankItemSecret.itemId, ownerId: bankItemSecret.ownerId, blob: bankItemSecret.blob }).from(bankItemSecret)
    .where(ownedBy(bankItemSecret, actor, eq(bankItemSecret.itemId, id)));
  if (!row) throw new MissingSecretError();
  const stored = row.blob.toString("utf8");
  let token: string | undefined = decrypt(stored, secretAad(row.itemId, row.ownerId));
  await rewrapIfStale(actor, row.itemId, row.blob, stored);
  try {
    return await fn(token);
  } finally {
    token = undefined;
  }
}

/**
 * After a key rotation, move the blob's data key under the current KEK the first time the token is used, so old
 * keys can be retired without a batch job. Best effort and compare-and-set on the old blob: a failure or a
 * concurrent rewrite never blocks the caller, and the plaintext is not involved.
 */
async function rewrapIfStale(actor: Actor, itemId: string, oldBlob: Buffer, stored: string): Promise<void> {
  try {
    if (!needsRewrap(stored)) return;
    const next = rewrap(stored);
    const { bankItemSecret } = schema;
    await db().update(bankItemSecret).set({ blob: Buffer.from(next, "utf8"), kid: validateEncryptionEnv().currentKeyId })
      .where(and(ownedBy(bankItemSecret, actor, eq(bankItemSecret.itemId, itemId)), eq(bankItemSecret.blob, oldBlob)));
    log.info("bank.secret.rewrapped", { provider: "plaid" });
  } catch {
    log.warn("bank.secret.rewrap_failed", { provider: "plaid" });
  }
}

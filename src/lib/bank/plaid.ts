import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "@/lib/errors";
import { log } from "@/lib/log";
import { type BankProvider, type SyncPage, syncPage } from "./types";

/**
 * Plaid sandbox client. Plain `fetch` with a timeout and zod-validated responses (no SDK: smaller Lambda bundle).
 *
 * The base URL is a constant, not configuration: there is no PLAID_ENV, so no setting can point this code at a
 * billable Plaid environment. Calls happen on the server only; the access token never leaves it.
 *
 * Errors carry Plaid's `error_code`, `error_type` and `request_id` and nothing else. Response bodies are never
 * logged and never copied into an error message, so neither an access token nor upstream text can reach a log
 * line or a client response.
 */
export const PLAID_BASE_URL = "https://sandbox.plaid.com" as const;
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const COUNTRY_CODES = ["US"];

export class PlaidError extends HttpError {
  constructor(
    readonly code: string,
    readonly errorType: string,
    readonly requestId: string | null,
    status = 502,
  ) {
    super(status, "The bank provider could not complete the request. Try again later.");
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export type PlaidDeps = { fetch?: Fetch; timeoutMs?: number };
export type PlaidCredentials = { clientId: string; secret: string };

const errorBody = z.object({ error_type: z.string().optional(), error_code: z.string().optional(), request_id: z.string().optional() });
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const linkTokenResponse = z.object({ link_token: z.string().min(1).max(500) });
const exchangeResponse = z.object({ access_token: z.string().min(1).max(500), item_id: z.string().min(1).max(200) });
const itemGetResponse = z.object({ item: z.object({ institution_id: z.string().nullish() }) });
const institutionResponse = z.object({ institution: z.object({ name: z.string() }) });
const plaidTxn = z.object({
  transaction_id: z.string(), account_id: z.string(), pending_transaction_id: z.string().nullish(), date: z.string(),
  name: z.string().nullish(), merchant_name: z.string().nullish(), amount: z.number(), iso_currency_code: z.string().nullish(),
  pending: z.boolean(), personal_finance_category: z.object({ primary: z.string() }).nullish(),
});
const plaidAccount = z.object({
  account_id: z.string(), name: z.string().nullish(), mask: z.string().nullish(), type: z.string().nullish(), subtype: z.string().nullish(),
  balances: z.object({ current: z.number().nullish(), available: z.number().nullish() }),
});
const syncResponse = z.object({
  accounts: z.array(plaidAccount), added: z.array(plaidTxn), modified: z.array(plaidTxn),
  removed: z.array(z.object({ transaction_id: z.string() })), next_cursor: z.string(), has_more: z.boolean(),
});

const clip = (value: string | null | undefined, max: number) => (value ?? "").slice(0, max);

/** Plaid's own wording is kept out of everything but this mapper, which clips each field to what the schema accepts. */
function toPage(r: z.infer<typeof syncResponse>): SyncPage {
  const txn = (t: z.infer<typeof plaidTxn>) => ({
    transaction_id: t.transaction_id, account_id: t.account_id, pending_transaction_id: t.pending_transaction_id ?? null, date: t.date,
    name: clip(t.name || t.merchant_name, 200) || "Unknown", merchant_name: t.merchant_name ? clip(t.merchant_name, 120) : null, amount: t.amount,
    iso_currency_code: t.iso_currency_code && t.iso_currency_code.length === 3 ? t.iso_currency_code : "XXX", pending: t.pending,
    personal_finance_category: t.personal_finance_category ? { primary: clip(t.personal_finance_category.primary, 64) } : null,
  });
  return {
    accounts: r.accounts.map((a) => ({
      account_id: a.account_id, name: clip(a.name, 80) || "Account", mask: a.mask && /^\d{4}$/.test(a.mask) ? a.mask : "0000",
      type: clip(a.type, 40), subtype: clip(a.subtype, 40), current: a.balances.current ?? 0, available: a.balances.available ?? null,
    })),
    added: r.added.map(txn), modified: r.modified.map(txn), removed: r.removed, next_cursor: r.next_cursor, has_more: r.has_more,
  };
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new PlaidError("RESPONSE_TOO_LARGE", "CLIENT", null);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new PlaidError("RESPONSE_TOO_LARGE", "CLIENT", null);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createPlaidProvider(creds: PlaidCredentials, deps: PlaidDeps = {}): BankProvider {
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;

  async function call<S extends z.ZodType>(path: string, body: Record<string, unknown>, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${PLAID_BASE_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "PLAID-CLIENT-ID": creds.clientId, "PLAID-SECRET": creds.secret },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "error", // the credentials are in headers; never follow them anywhere else
      });
      text = await readCapped(res);
    } catch (err) {
      if (err instanceof PlaidError) throw err;
      const code = timeout.aborted ? "TIMEOUT" : "NETWORK";
      log.warn("plaid.request.failed", { endpoint: path, error_code: code });
      throw new PlaidError(code, "CLIENT", null, code === "TIMEOUT" ? 504 : 502);
    }
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (!res.ok) {
      const parsed = errorBody.safeParse(json);
      const e = parsed.success ? parsed.data : {};
      const code = e.error_code && SAFE_CODE.test(e.error_code) ? e.error_code : "UNKNOWN";
      const type = e.error_type && SAFE_CODE.test(e.error_type) ? e.error_type : "UNKNOWN";
      const requestId = e.request_id && SAFE_ID.test(e.request_id) ? e.request_id : null;
      log.warn("plaid.request.failed", { endpoint: path, status: res.status, error_code: code, error_type: type, request_id: requestId });
      throw new PlaidError(code, type, requestId);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      log.warn("plaid.request.failed", { endpoint: path, error_code: "INVALID_RESPONSE" });
      throw new PlaidError("INVALID_RESPONSE", "CLIENT", null);
    }
    return parsed.data;
  }

  return {
    name: "plaid",
    async createLinkToken(actor) {
      // An opaque, app-scoped hash: Plaid never receives our user id, name or email.
      const clientUserId = createHash("sha256").update(`budget-planner:${actor.id}`).digest("hex");
      const r = await call("/link/token/create", {
        client_name: "Personal Budget Planner", language: "en", country_codes: COUNTRY_CODES, user: { client_user_id: clientUserId }, products: ["transactions"],
      }, linkTokenResponse);
      return { linkToken: r.link_token };
    },
    async exchange(publicToken) {
      const r = await call("/item/public_token/exchange", { public_token: publicToken }, exchangeResponse);
      // The name is cosmetic: any failure here must not lose the item we just created.
      let institutionName = "Plaid Sandbox";
      try {
        const item = await call("/item/get", { access_token: r.access_token }, itemGetResponse);
        if (item.item.institution_id) {
          const inst = await call("/institutions/get_by_id", { institution_id: item.item.institution_id, country_codes: COUNTRY_CODES }, institutionResponse);
          institutionName = clip(inst.institution.name, 80) || institutionName;
        }
      } catch { /* already logged with codes only */ }
      return { itemId: r.item_id, institutionName, accessToken: r.access_token };
    },
    async sync(accessToken, cursor, count, signal) {
      if (!accessToken) throw new PlaidError("MISSING_TOKEN", "CLIENT", null, 500);
      const r = await call("/transactions/sync", {
        access_token: accessToken, count: Math.min(Math.max(count, 1), 500), ...(cursor ? { cursor } : {}), options: { include_personal_finance_category: true },
      }, syncResponse, signal);
      const page = syncPage.safeParse(toPage(r));
      if (!page.success) {
        log.warn("plaid.request.failed", { endpoint: "/transactions/sync", error_code: "INVALID_RESPONSE" });
        throw new PlaidError("INVALID_RESPONSE", "CLIENT", null);
      }
      return page.data;
    },
    async remove(accessToken) {
      if (!accessToken) throw new PlaidError("MISSING_TOKEN", "CLIENT", null, 500);
      try {
        await call("/item/remove", { access_token: accessToken }, z.object({}));
      } catch (err) {
        // Already gone at Plaid: the goal (no live item, no stored token) is met.
        if (err instanceof PlaidError && err.code === "ITEM_NOT_FOUND") return;
        throw err;
      }
    },
  };
}

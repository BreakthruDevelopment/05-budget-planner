import "server-only";
import { validateEncryptionEnv } from "@/lib/crypto/envelope";
import { ConflictError } from "@/lib/errors";
import { log } from "@/lib/log";
import { demoBank } from "./demo";
import { createPlaidProvider } from "./plaid";
import type { BankProvider } from "./types";

export type BankMode = "demo" | "plaid";

/**
 * Which bank backs new connections. The Plaid keys ARE the flag: `apps.yaml` has no plain env field, and
 * secrets that aren't set are skipped. Plaid is used only when PLAID_CLIENT_ID, PLAID_SECRET and a valid
 * TOKEN_ENC_KEY (exactly 32 bytes, base64) are all present; BANK_PROVIDER=demo forces the demo bank. Anything
 * else falls back to demo and logs `bank.provider.fallback` once, naming variables but never values.
 */
function resolve(): { mode: "plaid"; clientId: string; secret: string } | { mode: "demo"; reason: "forced" | "unconfigured" | "partial"; missing: string[]; invalid: string[] } {
  const clientId = process.env.PLAID_CLIENT_ID?.trim();
  const secret = process.env.PLAID_SECRET?.trim();
  const rawKey = process.env.TOKEN_ENC_KEY?.trim();
  if (process.env.BANK_PROVIDER?.trim() === "demo") return { mode: "demo", reason: "forced", missing: [], invalid: [] };
  const missing = [!clientId && "PLAID_CLIENT_ID", !secret && "PLAID_SECRET", !rawKey && "TOKEN_ENC_KEY"].filter((v): v is string => !!v);
  const invalid: string[] = [];
  if (rawKey) {
    try { validateEncryptionEnv(); } catch (err) {
      // The error names the variable at fault (current or previous key); log that name, never a value.
      const named = err instanceof Error ? /^(TOKEN_ENC_KEY(?:_PREVIOUS)?)\b/.exec(err.message)?.[1] : undefined;
      invalid.push(named ?? "TOKEN_ENC_KEY");
    }
  }
  if (missing.length || invalid.length) {
    return { mode: "demo", reason: missing.length === 3 ? "unconfigured" : "partial", missing, invalid };
  }
  return { mode: "plaid", clientId: clientId!, secret: secret! };
}

// On globalThis because Next bundles instrumentation and route handlers separately; a module variable would log once per bundle.
const state = globalThis as typeof globalThis & { __bankFallbackLogged?: boolean };
/** For tests only. */
export function resetProviderLog() { state.__bankFallbackLogged = false; }

export function bankMode(): BankMode {
  const r = resolve();
  if (r.mode === "demo" && !state.__bankFallbackLogged) {
    state.__bankFallbackLogged = true;
    const fields = { reason: r.reason, missing: r.missing, invalid: r.invalid };
    if (r.reason === "partial") log.warn("bank.provider.fallback", fields);
    else log.info("bank.provider.fallback", fields);
  }
  return r.mode;
}

/** The Plaid provider, or a 409 when Plaid isn't enabled (never a silent switch to another bank). */
export function requirePlaid(): BankProvider {
  const r = resolve();
  if (r.mode !== "plaid") { bankMode(); throw new ConflictError("Plaid is not enabled."); }
  return createPlaidProvider({ clientId: r.clientId, secret: r.secret });
}

export function providerFor(name: "demo" | "plaid"): BankProvider {
  return name === "demo" ? demoBank : requirePlaid();
}

import { z } from "zod";
import type { Actor } from "@/lib/auth/rbac";
export const bankTransaction = z.object({
  transaction_id: z.string().min(1).max(200), account_id: z.string().min(1).max(200), pending_transaction_id: z.string().max(200).nullable().default(null),
  date: z.iso.date(), name: z.string().min(1).max(200), merchant_name: z.string().max(120).nullable(), amount: z.number().finite().min(-1e9).max(1e9),
  iso_currency_code: z.string().length(3), pending: z.boolean(), personal_finance_category: z.object({ primary: z.string().max(64) }).nullable(),
});
export const bankAccountInput = z.object({ account_id: z.string().min(1).max(200), name: z.string().max(80), mask: z.string().regex(/^\d{4}$/), type: z.string().max(40), subtype: z.string().max(40), current: z.number().finite().min(-1e9).max(1e9), available: z.number().finite().min(-1e9).max(1e9).nullable() });
export const syncPage = z.object({ accounts: z.array(bankAccountInput).max(100), added: z.array(bankTransaction).max(500), modified: z.array(bankTransaction).max(500), removed: z.array(z.object({ transaction_id: z.string().min(1).max(200) })).max(500), next_cursor: z.string().max(500), has_more: z.boolean() });
export type BankTransaction = z.infer<typeof bankTransaction>;
export type SyncPage = z.infer<typeof syncPage>;
export interface BankProvider {
  name: "demo" | "plaid";
  createLinkToken(actor: Actor): Promise<{ linkToken: string }>;
  exchange(publicToken: string): Promise<{ itemId: string; institutionName: string; accessToken: string | null }>;
  sync(accessToken: string | null, cursor: string | null, count: number, signal?: AbortSignal): Promise<SyncPage>;
  remove(accessToken: string | null): Promise<void>;
}

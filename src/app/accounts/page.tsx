import type { Metadata } from "next";
import { GET as healthGet } from "@/app/api/health/route";
import { AccountsManager } from "@/components/budget/accounts-manager";
import { asInt } from "@/components/budget/format";
import type { BankItemView } from "@/components/budget/types";
import { PageIntro } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listBankItems } from "@/lib/bank/items";

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

async function bankProvider(): Promise<"demo" | "plaid"> {
  const body = (await (await healthGet()).json()) as { bank?: unknown };
  return body.bank === "plaid" ? "plaid" : "demo";
}

export default async function Page() {
  const actor = await requireUserOrRedirect();
  const [items, bank] = await Promise.all([listBankItems(actor), bankProvider()]);
  const view: BankItemView[] = items.map((item) => ({
    id: item.id,
    provider: item.provider,
    institutionName: item.institutionName,
    status: item.status,
    lastSyncedAt: item.lastSyncedAt ? item.lastSyncedAt.toISOString() : null,
    accounts: item.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      mask: account.mask,
      type: account.type,
      subtype: account.subtype,
      currentCents: asInt(account.currentCents),
      availableCents: account.availableCents === null ? null : asInt(account.availableCents),
    })),
  }));

  return (
    <>
      <PageIntro section="Budget planner" title="Accounts" description="Demo and sandbox data only. Never connect a real bank." />
      <AccountsManager items={view} bank={bank} />
    </>
  );
}

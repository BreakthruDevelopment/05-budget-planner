import { requireUserOrRedirect } from "@/lib/auth/session";
import { listBankItems } from "@/lib/bank/items";
import { PageIntro, Panel } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function Page() {
  const actor = await requireUserOrRedirect();
  const data = await listBankItems(actor);
  return <><PageIntro section="Budget planner" title="Accounts" description="Demo and sandbox data only. Never connect a real bank." /><Panel title="Accounts data"><pre className="max-w-full overflow-x-auto text-xs">{JSON.stringify(data, null, 2)}</pre></Panel></>;
}

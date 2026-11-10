import { requireUserOrRedirect } from "@/lib/auth/session";
import { listTransactions } from "@/lib/budget";
import { PageIntro, Panel } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function Page() {
  const actor = await requireUserOrRedirect();
  const data = await listTransactions(actor);
  return <><PageIntro section="Budget planner" title="Transactions" description="Demo and sandbox data only. Never connect a real bank." /><Panel title="Transactions data"><pre className="max-w-full overflow-x-auto text-xs">{JSON.stringify(data, null, 2)}</pre></Panel></>;
}

import { requireUserOrRedirect } from "@/lib/auth/session";
import { listBudgets } from "@/lib/budget";
import { PageIntro, Panel } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function Page() {
  const actor = await requireUserOrRedirect();
  const data = await listBudgets(actor);
  return <><PageIntro section="Budget planner" title="Budgets" description="Demo and sandbox data only. Never connect a real bank." /><Panel title="Budgets data"><pre className="max-w-full overflow-x-auto text-xs">{JSON.stringify(data, null, 2)}</pre></Panel></>;
}

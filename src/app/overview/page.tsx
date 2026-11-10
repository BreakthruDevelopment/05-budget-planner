import { requireUserOrRedirect } from "@/lib/auth/session";
import { cashFlow, currentMonth } from "@/lib/budget";
import { PageIntro, Panel } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function Page() {
  const actor = await requireUserOrRedirect();
  const data = await cashFlow(actor, currentMonth());
  return <><PageIntro section="Budget planner" title="Overview" description="Demo and sandbox data only. Never connect a real bank." /><Panel title="Overview data"><pre className="max-w-full overflow-x-auto text-xs">{JSON.stringify(data, null, 2)}</pre></Panel></>;
}

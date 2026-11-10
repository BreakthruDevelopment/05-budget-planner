import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { explainCashflow, getCachedExplanation } from "@/lib/budget-ai";
import { currentMonth } from "@/lib/budget";
import { errorResponse, readJson } from "@/lib/http";
export const dynamic = "force-dynamic";
export const maxDuration = 25;
/** The cached explanation for `?month=` (default: this month), or `{ explanation: null }`. No model call. */
export async function GET(request: Request) {
  try {
    const actor = await requireUser();
    const month = new URL(request.url).searchParams.get("month") ?? currentMonth();
    return Response.json({ month, explanation: await getCachedExplanation(actor, month) });
  } catch (err) { return errorResponse(err); }
}
/** Generate (or return the unchanged cached) explanation: `{ month, regenerate? }`. */
export async function POST(request: Request) {
  try {
    const actor = await requireUser();
    requireSameOrigin(request);
    const explanation = await explainCashflow(actor, await readJson(request, 1024));
    return Response.json({ month: explanation.month, explanation });
  } catch (err) { return errorResponse(err); }
}

import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { getTransaction, recategorizeTransaction } from "@/lib/budget";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser();
    
    const { id } = await context.params;
    return Response.json(await getTransaction(actor, id));
  } catch (err) { return errorResponse(err); }
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser();
    requireSameOrigin(request);
    const { id } = await context.params;
    return Response.json(await recategorizeTransaction(actor, id, await readJson(request, 16384)));
  } catch (err) { return errorResponse(err); }
}

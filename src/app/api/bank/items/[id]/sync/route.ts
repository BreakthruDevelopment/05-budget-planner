import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { syncItem } from "@/lib/bank/items";
export const dynamic = "force-dynamic";
export const maxDuration = 25;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser();
    requireSameOrigin(request);
    const { id } = await context.params;
    return Response.json(await syncItem(actor, id));
  } catch (err) { return errorResponse(err); }
}

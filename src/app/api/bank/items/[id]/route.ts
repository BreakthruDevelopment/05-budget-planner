import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { getItem, disconnectItem } from "@/lib/bank/items";
export const dynamic = "force-dynamic";
export const maxDuration = 25;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser();
    
    const { id } = await context.params;
    return Response.json(await getItem(actor, id));
  } catch (err) { return errorResponse(err); }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireUser();
    requireSameOrigin(request);
    const { id } = await context.params;
    await disconnectItem(actor, id); return new Response(null, { status: 204 });
  } catch (err) { return errorResponse(err); }
}

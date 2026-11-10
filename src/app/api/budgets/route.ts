import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { listBudgets, replaceBudgets } from "@/lib/budget";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const actor = await requireUser();
    
    
    return Response.json(await listBudgets(actor));
  } catch (err) { return errorResponse(err); }
}
export async function PUT(request: Request) {
  try {
    const actor = await requireUser();
    requireSameOrigin(request);
    
    return Response.json(await replaceBudgets(actor, await readJson(request, 16384)));
  } catch (err) { return errorResponse(err); }
}

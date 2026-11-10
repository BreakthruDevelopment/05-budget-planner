import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const actor = await requireRole("admin");
    requireSameOrigin(request);
    
    return Response.json(await loadDemoWorkspace(actor));
  } catch (err) { return errorResponse(err); }
}

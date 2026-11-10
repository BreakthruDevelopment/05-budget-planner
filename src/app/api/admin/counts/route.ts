import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { adminCounts } from "@/lib/budget";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const actor = await requireRole("admin");
    
    
    return Response.json(await adminCounts(actor));
  } catch (err) { return errorResponse(err); }
}

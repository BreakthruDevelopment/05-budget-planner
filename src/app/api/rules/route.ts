import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { listRules } from "@/lib/budget";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const actor = await requireUser();
    
    
    return Response.json(await listRules(actor));
  } catch (err) { return errorResponse(err); }
}

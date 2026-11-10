import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { listCategories } from "@/lib/budget";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const actor = await requireUser();
    
    
    return Response.json(await listCategories(actor));
  } catch (err) { return errorResponse(err); }
}

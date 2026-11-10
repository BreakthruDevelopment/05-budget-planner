import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { listTransactions } from "@/lib/budget";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = await requireUser();
    
    
    return Response.json(await listTransactions(actor, Object.fromEntries(new URL(request.url).searchParams)));
  } catch (err) { return errorResponse(err); }
}

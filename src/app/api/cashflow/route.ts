import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { cashFlow, currentMonth } from "@/lib/budget";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = await requireUser();
    
    
    return Response.json(await cashFlow(actor, new URL(request.url).searchParams.get("month") ?? currentMonth()));
  } catch (err) { return errorResponse(err); }
}

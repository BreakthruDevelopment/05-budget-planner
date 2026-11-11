import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { connectBank, listBankItems } from "@/lib/bank/items";
export const dynamic = "force-dynamic";
export const maxDuration = 25;
export async function GET() {
  try {
    const actor = await requireUser();
    
    
    return Response.json(await listBankItems(actor));
  } catch (err) { return errorResponse(err); }
}
export async function POST(request: Request) {
  try {
    const actor = await requireUser();
    requireSameOrigin(request);
    
    return Response.json(await connectBank(actor, await readJson(request, 16384)), { status: 201 });
  } catch (err) { return errorResponse(err); }
}

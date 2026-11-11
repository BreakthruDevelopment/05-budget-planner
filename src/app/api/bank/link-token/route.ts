import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { createLinkToken } from "@/lib/bank/items";
import { errorResponse, readBodyCapped, parseJsonBody } from "@/lib/http";
export const dynamic = "force-dynamic";
export const maxDuration = 25;
const noInput = z.object({}).strict();
/** Plaid only: a short-lived link token for Plaid Link. Takes no input; an optional body must be `{}`. */
export async function POST(request: Request) {
  try {
    const actor = await requireUser();
    requireSameOrigin(request);
    const bytes = await readBodyCapped(request, 1024);
    if (bytes.length) noInput.parse(parseJsonBody(bytes));
    return Response.json(await createLinkToken(actor));
  } catch (err) { return errorResponse(err); }
}

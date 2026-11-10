import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { categorizeTransactions } from "@/lib/budget-ai";
import { errorResponse, parseJsonBody, readBodyCapped } from "@/lib/http";
export const dynamic = "force-dynamic";
// Provider timeout is AI_TIMEOUT_MS (20 s), inside Lambda's 29 s limit.
export const maxDuration = 25;
/** Categorize up to 50 of the caller's own uncategorized or low-confidence transactions. The body, if any, must be `{}`. */
export async function POST(request: Request) {
  try {
    const actor = await requireUser();
    requireSameOrigin(request);
    const bytes = await readBodyCapped(request, 1024);
    if (bytes.length > 0) {
      const body = parseJsonBody(bytes);
      if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
        return Response.json({ error: "Invalid input" }, { status: 400 });
      }
    }
    return Response.json(await categorizeTransactions(actor));
  } catch (err) { return errorResponse(err); }
}

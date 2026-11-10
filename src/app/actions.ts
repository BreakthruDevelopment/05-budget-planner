"use server";
import { headers } from "next/headers";
import { requireUser, requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorInfo, readJson } from "@/lib/http";
import { connectDemo, disconnectItem, syncItem } from "@/lib/bank/items";
import { recategorizeTransaction, replaceBudgets } from "@/lib/budget";
import { loadDemoWorkspace } from "@/lib/demo-workspace";
async function mutation<T>(fn: (actor: Awaited<ReturnType<typeof requireUser>>) => Promise<T>, admin = false) {
  try {
    const actor = admin ? await requireRole("admin") : await requireUser();
    requireSameOrigin(new Request("http://localhost", { headers: await headers() }));
    return { data: await fn(actor) };
  } catch (err) { return { error: errorInfo(err).body.error }; }
}
async function capped(input: unknown) {
  return readJson(new Request("http://localhost", { method: "POST", body: JSON.stringify(input) }), 16384);
}
export async function connectDemoAction(input: unknown) { return mutation(async actor => connectDemo(actor, await capped(input))); }
export async function syncItemAction(id: string) { return mutation(actor => syncItem(actor, id)); }
export async function disconnectItemAction(id: string) { return mutation(actor => disconnectItem(actor, id)); }
export async function recategorizeAction(id: string, input: unknown) { return mutation(async actor => recategorizeTransaction(actor, id, await capped(input))); }
export async function budgetsAction(input: unknown) { return mutation(async actor => replaceBudgets(actor, await capped(input))); }
export async function loadDemoAction() { return mutation(actor => loadDemoWorkspace(actor), true); }

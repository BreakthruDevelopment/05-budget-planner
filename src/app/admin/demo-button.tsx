"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { loadDemoAction } from "@/app/actions";
import { buttonSecondary } from "@/components/ui";
export function DemoButton() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  return <div><button className={buttonSecondary} disabled={pending} onClick={async () => {
    setPending(true);
    const result = await loadDemoAction();
    setMessage("error" in result ? result.error ?? "Unable to load demo" : "Demo workspace loaded: three demo users, bank records and budgets.");
    setPending(false); router.refresh();
  }}>{pending ? "Loading…" : "Load demo workspace"}</button><p aria-live="polite" className="mt-2 text-sm">{message}</p></div>;
}

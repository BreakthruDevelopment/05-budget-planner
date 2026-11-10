"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { loadDemoAction } from "@/app/actions";
import { buttonSecondary } from "@/components/ui";
export function DemoButton() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <div>
      <button
        className={buttonSecondary}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setMessage("");
          try {
            const result = await loadDemoAction();
            if (!result.ok) {
              setFailed(true);
              setMessage(result.error || "Unable to load demo");
            } else {
              setFailed(false);
              setMessage("Demo workspace loaded: three demo users, bank records and budgets.");
            }
            router.refresh();
          } catch {
            setFailed(true);
            setMessage("Unable to load demo");
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Loading…" : "Load demo workspace"}
      </button>
      {message && (
        <p aria-live="polite" role={failed ? "alert" : undefined} className={failed ? "mt-2 text-sm font-medium text-danger" : "mt-2 text-sm"}>
          {message}
        </p>
      )}
      {pending && (
        <p aria-live="polite" className="mt-2 text-sm text-muted">
          Loading…
        </p>
      )}
    </div>
  );
}

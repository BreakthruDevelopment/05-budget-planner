"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { categorizeAction } from "@/app/actions";
import { DemoBadge } from "@/components/ui";
import { buttonPrimary } from "@/components/ui/styles";

export function CategorizeButton({ count }: { count: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ applied: number; suggested: number; unchanged: number; disclaimer: string; demo: boolean } | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const response = await categorizeAction();
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setResult(response.data);
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mb-4 space-y-2">
      <button type="button" className={buttonPrimary} disabled={pending || count === 0} onClick={run}>
        {pending ? "Categorizing…" : `Categorize with AI (${count})`}
      </button>
      {count === 0 && !result && !error && <p className="text-sm text-muted">No transactions need an AI category.</p>}
      {pending && (
        <p aria-live="polite" className="text-sm text-muted">
          Categorizing…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {result && (
        <p aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm">
          {result.demo && <DemoBadge />}
          <span>
            Applied {result.applied}. Suggested {result.suggested}. Unchanged {result.unchanged}. {result.disclaimer}
          </span>
        </p>
      )}
    </div>
  );
}

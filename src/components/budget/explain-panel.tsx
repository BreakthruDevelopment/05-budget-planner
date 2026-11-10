"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { explainAction } from "@/app/actions";
import { DemoBadge, Panel } from "@/components/ui";
import { buttonPrimary } from "@/components/ui/styles";
import { explainIsLimit } from "./feedback";
import type { CashflowExplanation } from "./types";

const DISCLAIMER = "AI summary, not financial advice";

export function ExplainPanel({
  month,
  initial,
  canExplain,
  names,
}: {
  month: string;
  initial: CashflowExplanation | null;
  canExplain: boolean;
  names: Record<string, string>;
}) {
  const router = useRouter();
  const [override, setOverride] = useState<CashflowExplanation | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitNote, setLimitNote] = useState<string | null>(null);
  const view = override === undefined ? initial : override;
  const name = (slug: string) => names[slug] ?? slug;

  async function run(regenerate: boolean) {
    setPending(true);
    setError(null);
    setLimitNote(null);
    const hadSummary = view !== null;
    try {
      const result = await explainAction({ month, regenerate });
      if (!result.ok) {
        if (explainIsLimit(result.status, hadSummary)) setLimitNote(result.error);
        else setError(result.error);
        return;
      }
      setOverride(result.data);
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel title="Explain this month" action={view?.demo ? <DemoBadge /> : undefined}>
      <div aria-busy={pending} className="space-y-3">
        {view ? (
          <div className="space-y-3">
            {view.stale && (
              <p className="text-sm text-building">The numbers changed since this summary. Update it to refresh.</p>
            )}
            <h3 className="font-display text-2xl font-semibold break-words">{view.data.headline}</h3>
            <p className="break-words leading-relaxed">{view.data.summary}</p>
            {view.data.highlights.length > 0 && (
              <ul className="list-disc space-y-1 pl-5">
                {view.data.highlights.map((item) => (
                  <li key={`${item.category}-${item.text}`} className="break-words">
                    <span className="font-medium">{name(item.category)}. </span>
                    {item.text}
                  </li>
                ))}
              </ul>
            )}
            {view.data.overBudget.length > 0 && (
              <ul className="space-y-1">
                {view.data.overBudget.map((item) => (
                  <li key={`${item.category}-${item.text}`} className="break-words text-danger">
                    <span className="font-medium">{name(item.category)}. </span>
                    {item.text}
                  </li>
                ))}
              </ul>
            )}
            {view.data.tip && <p className="break-words">{view.data.tip}</p>}
          </div>
        ) : (
          <p className="text-muted">
            {canExplain
              ? "No summary for this month yet."
              : "A summary is available for the current month and the two before it."}
          </p>
        )}
        {pending && (
          <p aria-live="polite" className="text-sm text-muted">
            Writing the summary…
          </p>
        )}
        {limitNote && (
          <p aria-live="polite" className="text-sm">
            {limitNote}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}
        {canExplain && !view && (
          <button type="button" className={buttonPrimary} disabled={pending} onClick={() => run(false)}>
            {pending ? "Explaining…" : "Explain this month"}
          </button>
        )}
        {canExplain && view && (
          <button type="button" className={buttonPrimary} disabled={pending} onClick={() => run(true)}>
            {pending ? "Updating…" : "Update summary"}
          </button>
        )}
        <p className="text-sm text-muted">{view?.disclaimer ?? DISCLAIMER}</p>
      </div>
    </Panel>
  );
}

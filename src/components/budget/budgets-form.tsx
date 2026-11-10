"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { budgetsAction } from "@/app/actions";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { centsToInput, formatMoney, parseMoneyToCents } from "./format";
import type { CategoryOption } from "./types";

export function BudgetsForm({
  categories,
}: {
  categories: (CategoryOption & { spendCents: number; limitCents: number | null })[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextErrors: Record<string, string> = {};
    const budgets: { categorySlug: string; monthlyLimitCents: number }[] = [];
    for (const category of categories) {
      const raw = String(data.get(category.slug) ?? "");
      if (!raw.trim()) continue;
      const cents = parseMoneyToCents(raw);
      if (cents === null) nextErrors[category.slug] = `Enter a monthly limit from $0.01 to $100,000.00.`;
      else budgets.push({ categorySlug: category.slug, monthlyLimitCents: cents });
    }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setError("Fix the highlighted limits before saving.");
      setNotice(null);
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await budgetsAction({ budgets });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(budgets.length === 0 ? "Budgets cleared." : "Budgets saved.");
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setPending(false);
    }
  }

  if (categories.length === 0) {
    return <p className="text-sm text-muted">No expense categories yet.</p>;
  }

  return (
    <form onSubmit={onSubmit} aria-busy={pending} className="space-y-4">
      <p className="text-sm text-muted">Leave a limit blank to remove it. Actuals are posted USD spending for the month above.</p>
      <ul className="divide-y divide-border">
        {categories.map((category) => {
          const over = category.limitCents !== null && category.spendCents > category.limitCents;
          return (
            <li
              key={category.slug}
              data-category={category.slug}
              data-spend-cents={category.spendCents}
              data-limit-cents={category.limitCents ?? 0}
              className="flex flex-wrap items-end justify-between gap-3 py-3"
            >
              <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                <p className="font-medium">{category.name}</p>
                <p className="text-sm text-muted">This month {formatMoney(category.spendCents)}</p>
                {over && category.limitCents !== null && (
                  <p className="text-sm font-medium text-danger">Over by {formatMoney(category.spendCents - category.limitCents)}</p>
                )}
              </div>
              <label className={`${labelClass} w-full sm:w-48`}>
                <span>Monthly limit for {category.name}</span>
                <input
                  name={category.slug}
                  inputMode="decimal"
                  autoComplete="off"
                  defaultValue={category.limitCents === null ? "" : centsToInput(category.limitCents)}
                  placeholder="No limit"
                  disabled={pending}
                  aria-invalid={fieldErrors[category.slug] ? true : undefined}
                  className={inputClass}
                />
                {fieldErrors[category.slug] && (
                  <span role="alert" className="text-sm font-medium text-danger">
                    {fieldErrors[category.slug]}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p aria-live="polite" className="text-sm">
          {notice}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Saving…" : "Save budgets"}
      </button>
    </form>
  );
}

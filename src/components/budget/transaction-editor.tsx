"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { recategorizeAction } from "@/app/actions";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { confirmedCategory, suggestionSlug } from "./format";
import type { CategoryOption, TransactionRow } from "./types";

export function TransactionEditor({ row, categories }: { row: TransactionRow; categories: CategoryOption[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const suggestion = suggestionSlug(row.categorySource, row.categorySlug, row.aiConfidence);
  const suggestionName = categories.find((category) => category.slug === suggestion)?.name ?? suggestion;
  const label = row.merchantName || row.name;

  async function save(categorySlug: string, always: boolean) {
    if (!categorySlug) {
      setError("Choose a category.");
      setNotice(null);
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await recategorizeAction(row.id, { categorySlug, always });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Category saved.");
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void save(String(data.get("categorySlug") ?? ""), data.get("always") === "on");
  }

  return (
    <form onSubmit={onSubmit} aria-busy={pending} className="space-y-2">
      <label className={labelClass}>
        <span>Category</span>
        <select
          name="categorySlug"
          defaultValue={confirmedCategory(row.categorySource, row.categorySlug, row.aiConfidence)}
          disabled={pending}
          aria-label={`Category for ${label}`}
          className={`${inputClass} min-w-40`}
        >
          <option value="">Needs review</option>
          {categories.map((category) => (
            <option key={category.slug} value={category.slug}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      {suggestion && suggestionName && (
        <button
          type="button"
          disabled={pending}
          onClick={(event) => {
            const form = event.currentTarget.form;
            const always = form?.elements.namedItem("always");
            void save(suggestion, always instanceof HTMLInputElement && always.checked);
          }}
          className="inline-flex min-h-11 items-center rounded-md bg-building-soft px-3 text-sm font-medium text-building"
        >
          Suggested: {suggestionName}
        </button>
      )}
      <label className="inline-flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" name="always" disabled={pending} className="size-5" />
        Always use for this merchant
      </label>
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Saving…" : "Save category"}
      </button>
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
    </form>
  );
}

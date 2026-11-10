import Link from "next/link";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { shiftMonth } from "./format";

export function MonthPicker({ path, month }: { path: string; month: string }) {
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  return (
    <form method="get" action={path} aria-label="Choose a month" className="mb-6 flex flex-wrap items-end gap-3">
      <label className={`${labelClass} min-w-0 flex-1 basis-full sm:max-w-xs`}>
        <span>Month</span>
        <input
          type="month"
          name="month"
          defaultValue={month}
          min="2000-01"
          max="2100-12"
          required
          className={inputClass}
        />
      </label>
      <button type="submit" className={buttonPrimary}>
        Show month
      </button>
      {prev >= "2000-01" && (
        <Link href={`${path}?month=${prev}`} className={buttonSecondary}>
          Previous month
        </Link>
      )}
      {next <= "2100-12" && (
        <Link href={`${path}?month=${next}`} className={buttonSecondary}>
          Next month
        </Link>
      )}
    </form>
  );
}

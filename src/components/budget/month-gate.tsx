import { PageIntro } from "@/components/ui";
import { buttonPrimary } from "@/components/ui/styles";
import { EnsureMonth } from "./ensure-month";
import { UseLocalMonth } from "./use-local-month";

const description = "Demo and sandbox data only. Never connect a real bank.";

export function MonthLoading({ path, title }: { path: string; title: string }) {
  return (
    <>
      <PageIntro section="Budget planner" title={title} description={description} />
      <EnsureMonth path={path} />
      <p aria-live="polite" className="text-muted">
        Loading this month…
      </p>
    </>
  );
}

export function MonthInvalid({ path }: { path: string }) {
  return (
    <>
      <PageIntro section="Budget planner" title="Choose a month" description={description} />
      <p role="alert" className="text-sm font-medium text-danger">
        That month isn&apos;t valid. Choose a month from January 2000 through December 2100.
      </p>
      <UseLocalMonth path={path} className={`${buttonPrimary} mt-4`} />
    </>
  );
}

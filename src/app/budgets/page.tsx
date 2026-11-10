import type { Metadata } from "next";
import { BudgetsForm } from "@/components/budget/budgets-form";
import { asInt, firstParam, monthLabel } from "@/components/budget/format";
import { MonthInvalid, MonthLoading } from "@/components/budget/month-gate";
import { MonthPicker } from "@/components/budget/month-picker";
import { PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { cashFlow, listBudgets, listCategories, monthInput } from "@/lib/budget";

export const metadata: Metadata = { title: "Budgets" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const actor = await requireUserOrRedirect();
  const raw = firstParam((await searchParams).month);
  if (!raw) return <MonthLoading path="/budgets" title="Budgets" />;
  const parsed = monthInput.safeParse(raw);
  if (!parsed.success) return <MonthInvalid path="/budgets" />;
  const month = parsed.data;

  const [categories, limits, flow] = await Promise.all([
    listCategories(actor),
    listBudgets(actor),
    cashFlow(actor, month),
  ]);
  const limitBySlug = new Map(limits.map((row) => [row.categorySlug, row.monthlyLimitCents]));
  const spendBySlug = new Map(flow.categories.map((row) => [row.categorySlug, asInt(row.spendCents)]));
  const rows = categories
    .filter((category) => category.kind === "expense")
    .map((category) => ({
      slug: category.slug,
      name: category.name,
      kind: category.kind,
      spendCents: spendBySlug.get(category.slug) ?? 0,
      limitCents: limitBySlug.get(category.slug) ?? null,
    }));

  return (
    <>
      <PageIntro
        section="Budget planner"
        title="Budgets"
        description={`Monthly limits for expense categories. Actual spending is for ${monthLabel(month)}. Demo and sandbox data only. Never connect a real bank.`}
      />
      <MonthPicker path="/budgets" month={month} />
      <Panel title="Expense limits" count={rows.length}>
        <BudgetsForm key={`${month}:${rows.map((row) => `${row.slug}:${row.limitCents ?? ""}`).join()}`} categories={rows} />
      </Panel>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ExplainPanel } from "@/components/budget/explain-panel";
import { asInt, barWidth, exclusionNote, firstParam, formatMoney, monthLabel, reviewLabel, transactionQuery } from "@/components/budget/format";
import { MonthInvalid, MonthLoading } from "@/components/budget/month-gate";
import { MonthPicker } from "@/components/budget/month-picker";
import { PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { explainableMonths, getCachedExplanation } from "@/lib/budget-ai";
import { cashFlow, listCategories, monthInput } from "@/lib/budget";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const actor = await requireUserOrRedirect();
  const raw = firstParam((await searchParams).month);
  if (!raw) return <MonthLoading path="/overview" title="Overview" />;
  const parsed = monthInput.safeParse(raw);
  if (!parsed.success) return <MonthInvalid path="/overview" />;
  const month = parsed.data;

  const [flow, categories, explanation] = await Promise.all([
    cashFlow(actor, month),
    listCategories(actor),
    getCachedExplanation(actor, month),
  ]);
  const names = Object.fromEntries(categories.map((category) => [category.slug, category.name]));
  const bySlug = new Map(flow.categories.map((category) => [category.categorySlug, category]));
  const bars = categories
    .filter((category) => category.kind === "expense")
    .map((category) => {
      const row = bySlug.get(category.slug);
      return {
        slug: category.slug,
        name: category.name,
        spend: asInt(row?.spendCents),
        budget: asInt(row?.budgetCents),
        previous: asInt(row?.previousCents),
      };
    })
    .filter((bar) => bar.spend > 0 || bar.budget > 0);
  const income = asInt(flow.incomeCents);
  const spend = asInt(flow.spendCents);
  const net = asInt(flow.netCents);
  const needsReview = asInt(flow.counts.needsReview);
  const excluded = exclusionNote(asInt(flow.counts.pending), asInt(flow.counts.nonUsd));

  return (
    <>
      <PageIntro
        section="Budget planner"
        title={monthLabel(month)}
        description="Demo and sandbox data only. Never connect a real bank."
        actions={
          <Link href={transactionQuery({ month, review: "true" })} className={buttonSecondary}>
            {reviewLabel(needsReview)}
          </Link>
        }
      />
      <MonthPicker path="/overview" month={month} />
      <div data-income-cents={income} data-spend-cents={spend} data-net-cents={net} data-needs-review={needsReview}>
        <StatGrid>
          <StatTile value={formatMoney(income)} label="Income" tone="live" />
          <StatTile value={formatMoney(spend)} label="Spend" />
          <StatTile value={formatMoney(net)} label="Net" tone={net < 0 ? "blocked" : "accent"} />
        </StatGrid>
      </div>
      {excluded && <p className="mb-6 text-sm text-muted">{excluded}</p>}
      <Panel title="Budgets" count={bars.length}>
        {bars.length === 0 ? (
          <p className="text-sm text-muted">No spending or budgets this month.</p>
        ) : (
          <ul className="space-y-4">
            {bars.map((bar) => {
              const over = bar.budget > 0 && bar.spend > bar.budget;
              const max = Math.max(bar.budget, bar.spend, 1);
              return (
                <li key={bar.slug}>
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{bar.name}</span>
                    <span className="text-sm">
                      {formatMoney(bar.spend)}
                      {bar.budget > 0 && <span className="text-muted"> of {formatMoney(bar.budget)}</span>}
                    </span>
                  </div>
                  <div
                    role="meter"
                    aria-label={`${bar.name} spending`}
                    aria-valuemin={0}
                    aria-valuemax={max}
                    aria-valuenow={bar.spend}
                    aria-valuetext={
                      bar.budget > 0
                        ? `${formatMoney(bar.spend)} of ${formatMoney(bar.budget)}`
                        : `${formatMoney(bar.spend)}, no budget`
                    }
                    className="h-2 overflow-hidden rounded-full bg-background"
                  >
                    <div
                      className={`h-full rounded-full ${over ? "bg-danger" : "bg-accent"}`}
                      style={{ width: `${barWidth(bar.spend, bar.budget)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-sm text-muted">Last month {formatMoney(bar.previous)}</p>
                  {over && <p className="text-sm font-medium text-danger">Over by {formatMoney(bar.spend - bar.budget)}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <Panel title="Top merchants" count={flow.topMerchants.length}>
        {flow.topMerchants.length === 0 ? (
          <p className="text-sm text-muted">No merchant spending this month.</p>
        ) : (
          <ul>
            {flow.topMerchants.map((merchant) => (
              <li key={merchant.merchantName} className="flex min-h-11 items-baseline justify-between gap-3">
                <span className="min-w-0 break-words">{merchant.merchantName}</span>
                <span className="shrink-0">{formatMoney(asInt(merchant.spendCents))}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <ExplainPanel
        month={month}
        initial={explanation}
        canExplain={explainableMonths().includes(month)}
        names={names}
      />
    </>
  );
}

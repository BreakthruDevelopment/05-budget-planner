import type { Metadata } from "next";
import Link from "next/link";
import { ZodError } from "zod";
import { CategorizeButton } from "@/components/budget/categorize-button";
import { asInt, firstParam, formatDate, formatMoney, monthChoices, transactionQuery } from "@/components/budget/format";
import { MonthInvalid, MonthLoading } from "@/components/budget/month-gate";
import { TransactionEditor } from "@/components/budget/transaction-editor";
import type { CategoryOption, TransactionRow } from "@/components/budget/types";
import { type Column, DataList, FilterBar, PageIntro, Panel } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { countCategorizable } from "@/lib/budget-ai";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listBankItems } from "@/lib/bank/items";
import { currentMonth, listCategories, listTransactions, monthInput, transactionFilters } from "@/lib/budget";
import { NotFoundError } from "@/lib/errors";

export const metadata: Metadata = { title: "Transactions" };
export const dynamic = "force-dynamic";

const description = "Demo and sandbox data only. Never connect a real bank.";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string | string[]; account?: string | string[]; category?: string | string[]; review?: string | string[]; cursor?: string | string[] }>;
}) {
  const actor = await requireUserOrRedirect();
  const params = await searchParams;
  const rawMonth = firstParam(params.month);
  if (!rawMonth) return <MonthLoading path="/transactions" title="Transactions" />;
  if (rawMonth !== "all" && !monthInput.safeParse(rawMonth).success) return <MonthInvalid path="/transactions" />;

  const account = firstParam(params.account) || undefined;
  const category = firstParam(params.category) || undefined;
  const review = firstParam(params.review) || undefined;
  const cursor = firstParam(params.cursor) || undefined;
  const parsed = transactionFilters.safeParse({
    month: rawMonth === "all" ? undefined : rawMonth,
    account,
    category,
    review,
    cursor,
  });
  if (!parsed.success) {
    return (
      <>
        <PageIntro section="Budget planner" title="Transactions" description={description} />
        <p role="alert" className="text-sm font-medium text-danger">
          Those filters aren&apos;t valid.
        </p>
        <Link href="/transactions?month=all" className={`${buttonSecondary} mt-4`}>
          Clear filters
        </Link>
      </>
    );
  }

  const txPromise = listTransactions(actor, parsed.data).then(
    (data) => ({ ok: true as const, data }),
    (err: unknown) => {
      if (err instanceof NotFoundError) return { ok: false as const, reason: "account" as const };
      if (err instanceof ZodError) return { ok: false as const, reason: "filter" as const };
      throw err;
    },
  );
  const [tx, categories, bankItems, reviewCount] = await Promise.all([
    txPromise,
    listCategories(actor),
    listBankItems(actor),
    countCategorizable(actor),
  ]);
  if (!tx.ok) {
    return (
      <>
        <PageIntro section="Budget planner" title="Transactions" description={description} />
        <p role="alert" className="text-sm font-medium text-danger">
          {tx.reason === "account" ? "That account isn't on your profile." : "Those filters aren't valid."}
        </p>
        <Link href={tx.reason === "account" ? transactionQuery({ month: rawMonth }) : "/transactions?month=all"} className={`${buttonSecondary} mt-4`}>
          {tx.reason === "account" ? "Clear account filter" : "Clear filters"}
        </Link>
      </>
    );
  }

  const categoryOptions: CategoryOption[] = categories.map((row) => ({ slug: row.slug, name: row.name, kind: row.kind }));
  const accounts = bankItems
    .flatMap((item) => item.accounts)
    .map((row) => ({ id: row.id, name: row.name, mask: row.mask.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.mask.localeCompare(b.mask));
  const accountName = new Map(accounts.map((row) => [row.id, `${row.name} ····${row.mask}`]));
  const rows: TransactionRow[] = tx.data.items.map((row) => ({
    id: row.id,
    date: row.date,
    name: row.name,
    merchantName: row.merchantName,
    amountCents: asInt(row.amountCents),
    isoCurrency: row.isoCurrency,
    pending: row.pending,
    categorySlug: row.categorySlug,
    categorySource: row.categorySource,
    aiConfidence: row.aiConfidence,
    accountId: row.accountId,
  }));
  const columns: Column<TransactionRow>[] = [
    {
      key: "name",
      header: "Transaction",
      primary: true,
      cell: (row) => (
        <span className="break-words">
          {row.merchantName || row.name}
          {row.pending && <span className="ml-2 text-sm font-normal text-muted">Pending</span>}
        </span>
      ),
    },
    { key: "date", header: "Date", className: "whitespace-nowrap", cell: (row) => formatDate(row.date) },
    {
      key: "account",
      header: "Account",
      cell: (row) => <span className="break-words">{accountName.get(row.accountId) ?? "Account"}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      className: "whitespace-nowrap",
      cell: (row) => (
        <span className={row.amountCents < 0 ? undefined : "text-live"}>
          {formatMoney(row.amountCents)}
          {row.isoCurrency !== "USD" && <span className="ml-1 text-building">{row.isoCurrency}</span>}
        </span>
      ),
    },
    {
      key: "category",
      header: "Category",
      hideLabel: true,
      cell: (row) => (
        <TransactionEditor
          key={`${row.id}-${row.categorySlug ?? ""}-${row.categorySource}-${row.aiConfidence ?? ""}`}
          row={row}
          categories={categoryOptions}
        />
      ),
    },
  ];
  const filters = { month: rawMonth, account, category, review };

  return (
    <>
      <PageIntro section="Budget planner" title="Transactions" description={description} />
      <FilterBar
        label="Filter transactions"
        filters={[
          { name: "month", label: "Month", value: rawMonth, options: monthChoices(rawMonth, rawMonth === "all" ? currentMonth() : rawMonth) },
          {
            name: "account",
            label: "Account",
            value: account ?? "",
            options: [{ value: "", label: "All accounts" }, ...accounts.map((row) => ({ value: row.id, label: `${row.name} ····${row.mask}` }))],
          },
          {
            name: "category",
            label: "Category",
            value: category ?? "",
            options: [{ value: "", label: "All categories" }, ...categoryOptions.map((row) => ({ value: row.slug, label: row.name }))],
          },
          {
            name: "review",
            label: "Review",
            value: review === "true" ? "true" : "",
            options: [
              { value: "", label: "All transactions" },
              { value: "true", label: "Needs review" },
            ],
          },
        ]}
      />
      <CategorizeButton count={reviewCount} />
      <Panel title="Transactions" count={rows.length}>
        <DataList
          caption="Transactions"
          rows={rows}
          rowKey={(row) => row.id}
          columns={columns}
          empty={
            bankItems.length === 0 ? (
              <>
                No transactions yet.{" "}
                <Link href="/accounts" className="inline-flex min-h-11 items-center font-semibold text-accent underline">
                  Connect a bank
                </Link>
              </>
            ) : review === "true" ? (
              "Nothing needs review."
            ) : (
              "No transactions for this filter."
            )
          }
        />
        <div className="mt-4 flex flex-wrap gap-3">
          {cursor && (
            <Link href={transactionQuery(filters)} className={buttonSecondary}>
              First page
            </Link>
          )}
          {tx.data.nextCursor && (
            <Link href={transactionQuery({ ...filters, cursor: tx.data.nextCursor })} className={buttonSecondary}>
              Next page
            </Link>
          )}
        </div>
      </Panel>
    </>
  );
}

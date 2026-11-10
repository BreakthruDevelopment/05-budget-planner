export type CategoryOption = { slug: string; name: string; kind: "income" | "expense" | "transfer" };

export type TransactionRow = {
  id: string;
  date: string;
  name: string;
  merchantName: string | null;
  amountCents: number;
  isoCurrency: string;
  pending: boolean;
  categorySlug: string | null;
  categorySource: "user" | "rule" | "provider" | "ai" | "none";
  aiConfidence: string | null;
  accountId: string;
};

export type AccountView = {
  id: string;
  name: string;
  mask: string;
  type: string;
  subtype: string;
  currentCents: number;
  availableCents: number | null;
};

export type BankItemView = {
  id: string;
  provider: "demo" | "plaid";
  institutionName: string;
  status: "active" | "login_required" | "error";
  lastSyncedAt: string | null;
  accounts: AccountView[];
};

export type CashflowExplanation = {
  data: {
    headline: string;
    summary: string;
    highlights: { category: string; text: string }[];
    overBudget: { category: string; text: string }[];
    tip: string;
  };
  mode: string;
  demo: boolean;
  stale: boolean;
  disclaimer: string;
};

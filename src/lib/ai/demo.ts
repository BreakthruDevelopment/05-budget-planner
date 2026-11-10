/**
 * Recorded answers keyed by task name. Demo mode keeps live demos working when the
 * free model quota is used up, and lets tests run without a network or API key.
 * Each app adds a fixture for each AI task it defines.
 */
export const demoFixtures: Record<string, unknown> = {
  "summarize-items": {
    summary:
      "You have a few open items. The most recent ones focus on setup work; nothing looks overdue.",
    highlights: ["Setup tasks are the largest group", "No items are flagged urgent"],
  },
  // The recorded answers below are what generate() returns in demo mode. They can't know the user's rows, so
  // budget-tasks.ts replaces them with output built from the user's own rows and numbers (demoCategorize and
  // demoExplanation); the fixtures keep the plumbing honest and are what a stub-free demo run validates against.
  "categorize-transactions": {
    items: [
      { id: "T1", category: "groceries", confidence: 0.9 },
      { id: "T2", category: "dining", confidence: 0.8 },
      { id: "T3", category: "other", confidence: 0.4 },
    ],
  },
  "explain-cash-flow": {
    headline: "Spending held steady this month",
    summary: "This is a sample summary (recorded, not from a live model). Your real totals appear here once a live model is connected.",
    highlights: [{ category: "groceries", text: "Groceries was one of the larger categories this month." }],
    overBudget: [],
    tip: "Pick one category to watch next month and check it weekly.",
  },
};

/** Shown on every summary that did not come from a live model. */
export const DEMO_LABEL = "(recorded, not from a live model) ";

const KEYWORDS: [category: string, pattern: RegExp][] = [
  ["groceries", /\b(market|grocery|groceries|whole foods|trader joe|safeway|kroger|aldi|costco|supermarket)\b/i],
  ["dining", /\b(cafe|coffee|restaurant|pizza|burger|starbucks|diner|grill|bistro|taqueria|doordash|bar)\b/i],
  ["transport", /\b(uber|lyft|transit|shell|chevron|exxon|gas station|parking|metro|taxi|fuel)\b/i],
  ["subscriptions", /\b(netflix|spotify|hulu|subscription|icloud|prime video|disney)\b/i],
  ["housing", /\b(rent|mortgage|landlord|hoa)\b/i],
  ["utilities", /\b(electric|water|internet|comcast|verizon|utility|utilities|power|at&t)\b/i],
  ["entertainment", /\b(cinema|theater|theatre|movie|concert|steam)\b/i],
  ["health", /\b(pharmacy|cvs|walgreens|clinic|dental|dentist|gym|doctor)\b/i],
  ["travel", /\b(airlines?|airbnb|hotel|delta|united|expedia)\b/i],
  ["shopping", /\b(amazon|target|walmart|best buy|ikea)\b/i],
  ["fees", /\b(fee|fees|overdraft)\b/i],
  ["transfer", /\b(transfer|payment thank you|autopay)\b/i],
];
const INCOME = /\b(payroll|salary|direct dep|deposit|paycheck|wages)\b/i;

/** Keyword categorizer used in demo mode: deterministic, offline, and built only from the user's own rows. */
export function demoCategorize(rows: { name: string; merchantName: string | null; amountCents: number }[]): { category: string; confidence: number }[] {
  return rows.map((r) => {
    const text = `${r.merchantName ?? ""} ${r.name}`;
    if (r.amountCents > 0) return INCOME.test(text) ? { category: "income", confidence: 0.9 } : /transfer/i.test(text) ? { category: "transfer", confidence: 0.7 } : { category: "other", confidence: 0.4 };
    const hit = KEYWORDS.find(([, pattern]) => pattern.test(text));
    return hit ? { category: hit[0], confidence: 0.8 } : { category: "other", confidence: 0.4 };
  });
}

export function demoAnswer(task: string): string {
  const fixture = demoFixtures[task];
  if (fixture === undefined) {
    throw new Error(`No demo fixture for AI task "${task}". Add one to src/lib/ai/demo.ts.`);
  }
  return JSON.stringify(fixture);
}

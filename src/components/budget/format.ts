/** Client-safe money and month helpers. Amounts in this app are integer cents. */

/** Below this, an AI category stays a suggestion chip and the row still needs review. */
export const LOW_CONFIDENCE = 0.6;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function asInt(value: number | string | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) ? n : 0;
}

/** Local calendar month. The API's default month is UTC, which is already next month on a US evening of the 31st. */
export function localMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1] ?? month} ${y}`;
}

export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return `${SHORT_MONTHS[m - 1] ?? isoDate} ${d}, ${y}`;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min} UTC`;
}

export function formatMoney(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rem = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${rem}`;
}

/** Blank is "no limit". Anything else must be $0.01–$100,000.00. */
export function parseMoneyToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [dollars, fraction = ""] = trimmed.split(".");
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 10_000_000) return null;
  return cents;
}

export function centsToInput(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function isLowConfidence(source: string, confidence: string | number | null): boolean {
  if (source !== "ai" || confidence == null || confidence === "") return false;
  const n = Number(confidence);
  return Number.isFinite(n) && n < LOW_CONFIDENCE;
}

export function confirmedCategory(source: string, slug: string | null, confidence: string | number | null): string {
  if (!slug || source === "none" || isLowConfidence(source, confidence)) return "";
  return slug;
}

export function suggestionSlug(source: string, slug: string | null, confidence: string | number | null): string | null {
  if (!slug || !isLowConfidence(source, confidence)) return null;
  return slug;
}

export function reviewLabel(count: number): string {
  return count === 1 ? "1 needs review" : `${count} need review`;
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function transactionQuery(filters: {
  month: string;
  account?: string;
  category?: string;
  review?: string;
  cursor?: string;
}): string {
  const q = new URLSearchParams();
  q.set("month", filters.month);
  if (filters.account) q.set("account", filters.account);
  if (filters.category) q.set("category", filters.category);
  if (filters.review) q.set("review", filters.review);
  if (filters.cursor) q.set("cursor", filters.cursor);
  return `/transactions?${q.toString()}`;
}

export function monthChoices(selected: string, anchor: string): { value: string; label: string }[] {
  const values = new Set<string>();
  for (let delta = -1; delta <= 17; delta += 1) values.add(shiftMonth(anchor, -delta));
  if (selected !== "all") values.add(selected);
  const months = [...values].sort().reverse();
  return [{ value: "all", label: "All months" }, ...months.map((month) => ({ value: month, label: monthLabel(month) }))];
}

export function barWidth(spend: number, budget: number): number {
  if (spend <= 0) return 0;
  if (budget <= 0) return 100;
  return Math.min(100, Math.round((spend / budget) * 100));
}

export function exclusionNote(pending: number, nonUsd: number): string | null {
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending} pending`);
  if (nonUsd > 0) parts.push(`${nonUsd} non-USD`);
  if (parts.length === 0) return null;
  const total = pending + nonUsd;
  return `${parts.join(" and ")} ${total === 1 ? "transaction is" : "transactions are"} not included in these totals.`;
}

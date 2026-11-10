import { randomUUID } from "node:crypto";
import type { BankProvider, BankTransaction } from "./types";
const accounts = [
  { account_id: "checking", name: "Demo Checking", mask: "1234", type: "depository", subtype: "checking", current: 4200, available: 4100 },
  { account_id: "credit", name: "Demo Credit Card", mask: "5678", type: "credit", subtype: "credit card", current: 320, available: 4680 },
];
/** Seeded and date-anchored by the first cursor, so pagination/replays remain deterministic across midnight. */
export function demoTransactions(anchor: string): BankTransaction[] {
  let seed = 5101;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const merchants = [["Demo Market", "GROCERIES"], ["Demo Cafe", "FOOD_AND_DRINK"], ["Demo Transit", "TRANSPORTATION"], ["Demo Rent", "RENT"], ["Demo Cinema", "ENTERTAINMENT"], ["Demo Payroll", "INCOME"]];
  return Array.from({ length: 150 }, (_, i) => {
    const [name, primary] = merchants[i % merchants.length];
    const date = new Date(anchor + "T12:00:00Z"); date.setUTCDate(date.getUTCDate() - Math.floor(i * 90 / 150));
    return { transaction_id: `demo-${i}`, account_id: i % 3 ? "checking" : "credit", pending_transaction_id: null, date: date.toISOString().slice(0, 10), name, merchant_name: name,
      amount: primary === "INCOME" ? -2500 : Math.round((5 + rand() * 140) * 100) / 100, iso_currency_code: "USD", pending: i === 0,
      personal_finance_category: rand() < 0.6 ? { primary } : null };
  });
}
export const demoBank: BankProvider = {
  name: "demo",
  async createLinkToken() { return { linkToken: "demo" }; },
  async exchange(publicToken) {
    if (publicToken !== "demo") throw new Error("Invalid demo token");
    return { itemId: `demo-${randomUUID()}`, institutionName: "Breakthru Demo Bank", accessToken: null };
  },
  async sync(_token, cursor) {
    const [anchor, offsetText] = cursor?.split(":") ?? [new Date().toISOString().slice(0, 10), "0"];
    const offset = Number(offsetText); const rows = demoTransactions(anchor);
    const added = rows.slice(offset, offset + 50);
    const modified: BankTransaction[] = offset === 50 ? [{ ...rows[0], transaction_id: "demo-posted-0", pending_transaction_id: "demo-0", pending: false }] : [];
    return { accounts, added, modified, removed: offset === 50 ? [{ transaction_id: "demo-1" }] : [], next_cursor: `${anchor}:${Math.min(offset + 50, 150)}`, has_more: offset + 50 < rows.length };
  },
  async remove() {},
};

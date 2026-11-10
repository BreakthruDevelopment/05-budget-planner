import { SLUGS } from "@/lib/db/schema";
export { SLUGS };
export function merchantKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 120);
}
const mappings: Record<string, typeof SLUGS[number]> = {
  INCOME: "income", TRANSFER_IN: "transfer", TRANSFER_OUT: "transfer", LOAN_PAYMENTS: "other", BANK_FEES: "fees", ENTERTAINMENT: "entertainment",
  FOOD_AND_DRINK: "dining", GENERAL_MERCHANDISE: "shopping", HOME_IMPROVEMENT: "housing", MEDICAL: "health", PERSONAL_CARE: "health",
  GENERAL_SERVICES: "other", GOVERNMENT_AND_NON_PROFIT: "other", TRANSPORTATION: "transport", TRAVEL: "travel", RENT_AND_UTILITIES: "utilities",
  GROCERIES: "groceries", RENT: "housing", SUBSCRIPTIONS: "subscriptions",
};
export function providerCategory(primary: string | null): typeof SLUGS[number] | null { return primary ? mappings[primary] ?? null : null; }

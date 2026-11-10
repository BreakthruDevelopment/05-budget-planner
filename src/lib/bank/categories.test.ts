import { describe, expect, it } from "vitest";
import { merchantKey, providerCategory, SLUGS } from "./categories";
import { demoBank } from "./demo";
describe("bank categories and demo fixture", () => {
  it.each([ ["INCOME","income"], ["TRANSFER_IN","transfer"], ["TRANSFER_OUT","transfer"], ["BANK_FEES","fees"], ["ENTERTAINMENT","entertainment"], ["FOOD_AND_DRINK","dining"], ["GENERAL_MERCHANDISE","shopping"], ["HOME_IMPROVEMENT","housing"], ["MEDICAL","health"], ["PERSONAL_CARE","health"], ["TRANSPORTATION","transport"], ["TRAVEL","travel"], ["RENT_AND_UTILITIES","utilities"], ["GROCERIES","groceries"], ["RENT","housing"], ["SUBSCRIPTIONS","subscriptions"], ["GENERAL_SERVICES","other"], ["GOVERNMENT_AND_NON_PROFIT","other"], ["LOAN_PAYMENTS","other"] ])("maps %s to %s", (primary, slug) => expect(providerCategory(primary)).toBe(slug));
  it("leaves unknown categories for review", () => { expect(providerCategory(null)).toBeNull(); expect(providerCategory("unknown")).toBeNull(); expect(SLUGS).toHaveLength(14); });
  it("normalizes merchant keys consistently and bounds length", () => { expect(merchantKey("  Demo Café *123 ")).toBe("demo café 123"); expect(merchantKey("ＡＢＣ")).toBe("abc"); expect(merchantKey("x".repeat(200))).toHaveLength(120); });
  it("serves repeatable pages of 50 with pending-to-posted and removed on page 2", async () => {
    const a = await demoBank.sync(null, "2026-06-15:0", 500);
    const b = await demoBank.sync(null, a.next_cursor, 500);
    const c = await demoBank.sync(null, b.next_cursor, 500);
    expect(a.added).toHaveLength(50); expect(a.added[0].pending).toBe(true);
    expect(b.added).toHaveLength(50); expect(b.modified[0].pending_transaction_id).toBe(a.added[0].transaction_id); expect(b.removed).toHaveLength(1);
    expect(c.added).toHaveLength(50); expect(c.has_more).toBe(false);
    expect(await demoBank.sync(null, a.next_cursor, 500)).toEqual(b);
    expect((await demoBank.sync(null, c.next_cursor, 500)).added).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { CONNECTED_LATER, connectNotice, explainIsLimit } from "./feedback";
import {
  centsToInput,
  confirmedCategory,
  formatMoney,
  isLowConfidence,
  localMonth,
  monthLabel,
  parseMoneyToCents,
  shiftMonth,
  suggestionSlug,
} from "./format";

describe("money and months", () => {
  it("formats cents and parses dollar input", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(25000)).toBe("$250.00");
    expect(formatMoney(-123)).toBe("-$1.23");
    expect(formatMoney(100000)).toBe("$1,000.00");
    expect(formatMoney(10_000_000)).toBe("$100,000.00");
    expect(parseMoneyToCents("250")).toBe(25000);
    expect(parseMoneyToCents("250.5")).toBe(25050);
    expect(parseMoneyToCents("0.01")).toBe(1);
    expect(parseMoneyToCents("100000")).toBe(10_000_000);
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("0")).toBeNull();
    expect(parseMoneyToCents("100000.01")).toBeNull();
    expect(parseMoneyToCents("12.345")).toBeNull();
    expect(centsToInput(25050)).toBe("250.50");
  });

  it("shifts months and labels them without using the machine zone", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthLabel("2026-11")).toBe("November 2026");
  });

  it("uses the local calendar month, not the UTC month", () => {
    const local = new Date(2026, 0, 31, 20, 0, 0);
    expect(localMonth(local)).toBe("2026-01");
    if (local.getTimezoneOffset() > 0) {
      expect(local.toISOString().slice(0, 7)).toBe("2026-02");
    }
  });

  it("keeps a low-confidence AI category as a suggestion", () => {
    expect(isLowConfidence("ai", "0.40")).toBe(true);
    expect(isLowConfidence("ai", "0.60")).toBe(false);
    expect(isLowConfidence("user", "0.10")).toBe(false);
    expect(confirmedCategory("ai", "other", "0.40")).toBe("");
    expect(confirmedCategory("ai", "groceries", "0.90")).toBe("groceries");
    expect(suggestionSlug("ai", "other", "0.40")).toBe("other");
    expect(suggestionSlug("none", null, null)).toBeNull();
  });
});

describe("connect and summary messages", () => {
  it("treats a refresh-cap connect as connected, and other failures as errors", () => {
    expect(connectNotice({ error: "Refresh limit reached. Try again later.", status: 429 })).toEqual({
      alert: false,
      text: CONNECTED_LATER,
    });
    expect(connectNotice({ error: "At most three bank items are allowed.", status: 429 }).alert).toBe(true);
    expect(connectNotice({ syncMore: true }).text).toMatch(/Continue/);
    expect(connectNotice({ syncMore: false }).text).toMatch(/Demo bank connected/);
  });

  it("shows a regeneration limit beside the existing summary", () => {
    expect(explainIsLimit(429, true)).toBe(true);
    expect(explainIsLimit(429, false)).toBe(false);
    expect(explainIsLimit(500, true)).toBe(false);
  });
});

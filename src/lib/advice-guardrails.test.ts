import { describe, expect, it } from "vitest";
import { findAdvice, hasAdvice } from "./advice-guardrails";

describe("advice guardrails", () => {
  it.each([
    "Consider a balance-transfer credit card to cut your interest.",
    "You should invest the surplus in an index fund.",
    "Moving money into crypto could help.",
    "A personal loan would lower your payments.",
    "Talk to a lawyer about it.",
    "Refinancing your mortgage may save money.",
    "Check your credit score first.",
    "This will affect your taxes.",
    "What is your APR?",
    "Open a high-yield savings account.",
    "You are reckless with money.",
  ])("flags %s", (text) => {
    expect(hasAdvice(text)).toBe(true);
  });

  it.each([
    "Dining was over budget this month.",
    "Spending on groceries was lower than last month.",
    "Groceries stayed under the $400.00 budget.",
    "Pick one category to watch next month and check it weekly.",
    "Utilities, rent and shopping made up most of the spending.",
  ])("passes %s", (text) => {
    expect(findAdvice(text)).toEqual([]);
  });

  it("reports a code for each kind of hit", () => {
    expect(findAdvice("Invest in stocks, then see a lawyer.").map((h) => h.code)).toEqual(["investing", "tax_legal"]);
  });
});

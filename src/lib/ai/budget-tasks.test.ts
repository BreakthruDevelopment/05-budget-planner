import { describe, expect, it } from "vitest";
import { buildCategorizePrompt, buildExplainPrompt, CATEGORIZE_PROMPT_LIMIT, clean, EXPLAIN_PROMPT_LIMIT, type FlowStats, guardProposals, numbersMatch } from "./budget-tasks";

const row = (i: number, name: string, amountCents = -2500) => ({ id: `r${i}`, name, merchantName: name, amountCents, providerCategory: "FOOD_AND_DRINK" });

describe("clean", () => {
  it("strips brackets, backticks, control characters and line breaks, and bounds the length", () => {
    expect(clean("a<b>c`d\ne\u0000f g")).toBe("a b c d e f g");
    expect(clean("x".repeat(500), 120)).toHaveLength(120);
    expect(clean(null)).toBe("");
  });
});

describe("categorize prompt", () => {
  it("shows bands, not exact amounts, and maps ids server-side", () => {
    const { prompt, included } = buildCategorizePrompt([row(1, "Shop", -1234), row(2, "Pay", 250000)], [{ merchantKey: "shop", categorySlug: "shopping" }]);
    expect(prompt).toContain('"id":"T1"');
    expect(prompt).toContain('"amount":"<$20"');
    expect(prompt).toContain('"amount":">$2000"');
    expect(prompt).toContain('"direction":"inflow"');
    expect(prompt).not.toMatch(/12\.34|1234|250000/);
    expect(prompt).not.toContain("r1");
    expect(included.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(prompt).toContain("<rule_examples>");
  });
  it("stays under the cap for 50 long rows by shrinking names, then dropping rules", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i, `${"MERCHANT ".repeat(20)}${i}`));
    const rules = Array.from({ length: 30 }, (_, i) => ({ merchantKey: `merchant ${i}`, categorySlug: "dining" }));
    const { prompt, included } = buildCategorizePrompt(rows, rules);
    expect(prompt.length).toBeLessThanOrEqual(CATEGORIZE_PROMPT_LIMIT);
    expect(included).toHaveLength(50);
  });
  it("uses at most 20 rule examples", () => {
    const rules = Array.from({ length: 30 }, (_, i) => ({ merchantKey: `m${i}`, categorySlug: "dining" }));
    const { prompt } = buildCategorizePrompt([row(1, "Shop")], rules);
    expect(prompt.match(/"merchant":"m\d+"/g)).toHaveLength(20);
  });
});

describe("guardProposals", () => {
  const included = [row(1, "A"), row(2, "B", 5000)];
  it("drops unknown ids and duplicates, and enforces direction rules", () => {
    const { proposals, dropped } = guardProposals([
      { id: "T1", category: "dining", confidence: 0.9 }, { id: "T1", category: "groceries", confidence: 0.9 }, { id: "T9", category: "dining", confidence: 0.9 },
      { id: "T2", category: "dining", confidence: 0.9 },
    ], included);
    expect(proposals).toEqual([{ id: "r1", category: "dining", confidence: 0.9 }]);
    expect(dropped).toBe(3);
  });
  it("allows income only for inflows and never for outflows", () => {
    const { proposals } = guardProposals([{ id: "T1", category: "income", confidence: 1 }, { id: "T2", category: "income", confidence: 1 }], included);
    expect(proposals.map((p) => p.id)).toEqual(["r2"]);
  });
});

const stats: FlowStats = {
  month: "2026-10", incomeCents: 500000, spendCents: 100000, netCents: 400000,
  categories: [{ categorySlug: "dining", spendCents: 41200, budgetCents: 25000, remainingCents: -16200, previousCents: 30000 }],
  topMerchants: [{ merchantName: "Store #123", spendCents: 41200 }],
  counts: { transactions: 12, needsReview: 1, pending: 0, nonUsd: 0 },
};
describe("explanation numbers", () => {
  it("accepts server figures within a dollar and merchant names containing digits", () => {
    expect(numbersMatch("Dining was $412.00 against a $250 budget, $162 over, at Store #123.", stats)).toBe(true);
    expect(numbersMatch("You earned $5,000.00 and had 12 transactions in 2026.", stats)).toBe(true);
  });
  it("rejects figures the server did not compute", () => {
    for (const text of ["You spent $9,999.", "Dining rose 37%.", "About 450 dollars on dining.", "Roughly 7 purchases."]) expect(numbersMatch(text, stats), text).toBe(false);
  });
  it("keeps the explain prompt within its cap, with merchant names stripped", () => {
    const many = { ...stats, topMerchants: Array.from({ length: 5 }, (_, i) => ({ merchantName: `<b>M${i}</b>\n${"x".repeat(300)}`, spendCents: 100 })) };
    const prompt = buildExplainPrompt(many);
    expect(prompt.length).toBeLessThanOrEqual(EXPLAIN_PROMPT_LIMIT);
    expect(prompt).not.toMatch(/<b>/);
    expect(prompt).toContain('"spent":"$412.00"');
  });
});

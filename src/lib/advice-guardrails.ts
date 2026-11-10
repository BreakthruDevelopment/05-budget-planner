/**
 * Financial-advice filter for model text. The app sorts and explains; it never advises on investing, credit,
 * debt, taxes or legal matters, and never recommends products. Matching is deliberately broad: a false positive
 * swaps one sentence for neutral text built from the user's own numbers, a false negative is advice on screen.
 */
const TERMS: [code: string, pattern: RegExp][] = [
  ["investing", /\b(invest\w*|stocks?|equit(?:y|ies)|etfs?|index funds?|mutual funds?|bonds?|brokerage|portfolio|dividends?|crypto\w*|bitcoin|ethereum|retirement|401\s?\(?k\)?|roth|ira)\b/i],
  ["credit_debt", /\b(debts?|borrow\w*|line of credit|pay (?:off|down)|bnpl|buy now,? pay later|klarna|affirm|afterpay|loans?|lenders?|lending|mortgages?|refinanc\w*|credit scores?|credit cards?|credit limit|credit report|apr|interest rates?|balance[- ]transfers?|debt consolidation|consolidat\w* (?:your )?debt|payday|overdraft protection|bankrupt\w*)\b/i],
  ["tax_legal", /\b(accountants?|financial (?:advis[eo]rs?|planners?)|deductible|tax|taxes|taxable|deductions?|irs|lawyers?|attorneys?|legal advice|lawsuit)\b/i],
  ["product_recommendation", /\b(you should (?:buy|sell|open|switch|apply|get|consider)|switch to|consider (?:opening|switching|applying|using|getting|trying|a |an )|insurance|i recommend|we recommend|recommended (?:card|account|app|lender)|sign up for|apply for|high[- ]yield|savings account|money market|cd rates?)\b/i],
  ["character", /\b(irresponsible|reckless|careless|lazy|wasteful|foolish|stupid|bad with money|you are (?:bad|terrible))\b/i],
];

export type AdviceHit = { code: string; term: string };

/** Every advice or judgement phrase found in `text`. Empty means the text is clean. */
export function findAdvice(text: string): AdviceHit[] {
  const hits: AdviceHit[] = [];
  for (const [code, pattern] of TERMS) {
    const m = text.match(pattern);
    if (m) hits.push({ code, term: m[0].toLowerCase() });
  }
  return hits;
}

export function hasAdvice(text: string): boolean {
  return findAdvice(text).length > 0;
}

export const AI_DISCLAIMER = "AI summary, not financial advice";

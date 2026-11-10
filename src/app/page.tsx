import Link from "next/link";
import { PageIntro, Panel, buttonPrimary } from "@/components/ui";
export default function Home() {
  return <><PageIntro section="Personal Budget Planner" title="See where your money went." description="Demo data only. Connect the sandbox bank, never a real one." actions={<Link href="/sign-in" className={buttonPrimary}>Sign in or create account</Link>} /><Panel title="Your monthly picture"><p>Import transactions from Breakthru Demo Bank, set category budgets and compare monthly cash flow. Your financial records stay private, including from administrators.</p></Panel></>;
}

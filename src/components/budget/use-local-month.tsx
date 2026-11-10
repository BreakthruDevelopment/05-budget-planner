"use client";

import { useRouter } from "next/navigation";
import { localMonth } from "./format";

export function UseLocalMonth({ path, className, label = "Use this month" }: { path: string; className?: string; label?: string }) {
  const router = useRouter();
  return (
    <button type="button" className={className} onClick={() => router.push(`${path}?month=${localMonth()}`)}>
      {label}
    </button>
  );
}

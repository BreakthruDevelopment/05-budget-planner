"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { localMonth } from "./format";

/** Puts the browser's calendar month on the URL before the page asks the API for numbers. */
export function EnsureMonth({ path }: { path: string }) {
  const router = useRouter();
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("month")) return;
    url.searchParams.set("month", localMonth());
    router.replace(`${path}?${url.searchParams.toString()}`);
  }, [path, router]);
  return null;
}

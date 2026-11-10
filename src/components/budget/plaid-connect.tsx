"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from "react-plaid-link";
import { buttonPrimary } from "@/components/ui/styles";

/**
 * Shown only when /api/health reports bank "plaid".
 * The link-token route arrives with the Plaid provider; until then this stays unmounted.
 */
export function PlaidConnect({
  disabled,
  pending,
  onPublicToken,
}: {
  disabled: boolean;
  pending: boolean;
  onPublicToken: (publicToken: string) => Promise<void>;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch("/api/bank/link-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const body = (await res.json().catch(() => null)) as { linkToken?: unknown; error?: unknown } | null;
        if (cancel) return;
        if (!res.ok || !body || typeof body.linkToken !== "string") {
          setError(body && typeof body.error === "string" ? body.error : "Couldn't start the bank connection.");
          return;
        }
        setToken(body.linkToken);
      } catch {
        if (!cancel) setError("Couldn't start the bank connection.");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    (publicToken) => {
      if (!publicToken) {
        setError("The bank didn't return a connection token.");
        return;
      }
      void onPublicToken(publicToken);
    },
    [onPublicToken],
  );

  const onExit = useCallback<PlaidLinkOnExit>((exitError) => {
    if (!exitError) return;
    setError(exitError.display_message || "The bank connection was closed.");
  }, []);

  const { open, ready } = usePlaidLink({ token, onSuccess, onExit });

  return (
    <div className="space-y-2">
      {loading && (
        <p aria-live="polite" className="text-sm text-muted">
          Preparing the bank connection…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <button
        type="button"
        className={buttonPrimary}
        disabled={disabled || pending || !ready}
        onClick={() => open()}
      >
        {pending ? "Connecting…" : "Connect a bank"}
      </button>
    </div>
  );
}

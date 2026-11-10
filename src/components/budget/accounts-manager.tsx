"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { connectDemoAction, disconnectItemAction, syncItemAction } from "@/app/actions";
import { DemoBadge, Panel, StatusBadge, type Status } from "@/components/ui";
import { buttonDanger, buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { connectNotice } from "./feedback";
import { formatMoney, formatTimestamp } from "./format";
import { PlaidConnect } from "./plaid-connect";
import type { BankItemView } from "./types";

const statusView: Record<BankItemView["status"], { status: Status; label: string }> = {
  active: { status: "healthy", label: "Active" },
  login_required: { status: "degraded", label: "Sign-in needed" },
  error: { status: "down", label: "Needs attention" },
};

export function AccountsManager({ items, bank }: { items: BankItemView[]; bank: "demo" | "plaid" }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const atLimit = items.length >= 3;

  const connectWith = useCallback(
    async (input: { demo: true } | { publicToken: string }) => {
      setPending("connect");
      setError(null);
      setNotice(null);
      try {
        const result = await connectDemoAction(input);
        if (!result.ok) {
          const message = connectNotice(result);
          if (message.alert) setError(message.text);
          else setNotice(message.text);
          return;
        }
        if (result.data.sync.more) setMore((current) => ({ ...current, [result.data.item.id]: true }));
        setNotice(connectNotice({ syncMore: result.data.sync.more }).text);
      } catch {
        setError("Something went wrong");
      } finally {
        setPending(null);
        router.refresh();
      }
    },
    [router],
  );

  async function sync(id: string) {
    setPending(id);
    setError(null);
    setNotice(null);
    try {
      const result = await syncItemAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMore((current) => ({ ...current, [id]: result.data.more }));
      setNotice(
        result.data.more
          ? "Import paused. Choose Continue to fetch the rest."
          : `Refresh finished. ${result.data.added} new, ${result.data.modified} updated, ${result.data.removed} removed.`,
      );
    } catch {
      setError("Something went wrong");
    } finally {
      setPending(null);
      router.refresh();
    }
  }

  async function disconnect(id: string) {
    setPending(`disconnect:${id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await disconnectItemAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirmId(null);
      setMore((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setNotice("Bank disconnected.");
    } catch {
      setError("Something went wrong");
    } finally {
      setPending(null);
      router.refresh();
    }
  }

  return (
    <div data-bank={bank} className="space-y-2">
      <Panel title="Connect a bank">
        <div className="space-y-3">
          <p className="text-sm text-muted">Sandbox and demo only. Never connect a real bank.</p>
          {atLimit ? (
            <p>Three banks is the limit. Disconnect one to connect another.</p>
          ) : bank === "plaid" ? (
            <PlaidConnect disabled={pending !== null} pending={pending === "connect"} onPublicToken={(publicToken) => connectWith({ publicToken })} />
          ) : (
            <button
              type="button"
              className={buttonPrimary}
              disabled={pending !== null}
              onClick={() => connectWith({ demo: true })}
            >
              {pending === "connect" ? "Connecting…" : "Connect demo bank"}
            </button>
          )}
          {pending === "connect" && (
            <p aria-live="polite" className="text-sm text-muted">
              Connecting…
            </p>
          )}
        </div>
      </Panel>
      {error && (
        <p role="alert" className="mb-4 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p aria-live="polite" className="mb-4 text-sm">
          {notice}
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted">No bank connected yet.</p>
      ) : (
        items.map((item) => {
          const badge = statusView[item.status];
          const working = pending === item.id || pending === `disconnect:${item.id}`;
          return (
            <Panel
              key={item.id}
              title={item.institutionName}
              action={
                <span className="flex flex-wrap items-center gap-2">
                  {item.provider === "demo" && <DemoBadge />}
                  <StatusBadge status={badge.status} label={badge.label} />
                </span>
              }
            >
              <div className="space-y-4">
                <p className="text-sm text-muted">
                  {item.lastSyncedAt ? `Last refreshed ${formatTimestamp(item.lastSyncedAt)}` : "Not refreshed yet"}
                </p>
                {item.accounts.length === 0 ? (
                  <p className="text-sm text-muted">No accounts yet. Refresh when one is available.</p>
                ) : (
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {item.accounts.map((account) => (
                      <li key={account.id} data-balance-cents={account.currentCents} className="rounded-card border border-border px-4 py-3">
                        <p className="font-medium break-words">
                          {account.name} ····{account.mask.trim()}
                        </p>
                        <p className="text-sm text-muted">
                          {account.subtype} · {account.type}
                        </p>
                        <p className="mt-1 font-medium">{formatMoney(account.currentCents)}</p>
                        {account.availableCents !== null && (
                          <p className="text-sm text-muted">{formatMoney(account.availableCents)} available</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {confirmId === item.id && (
                  <p className="text-sm">
                    Disconnect {item.institutionName}? Accounts and transactions from this bank will be deleted.
                  </p>
                )}
                <div className="flex flex-wrap gap-3">
                  <button type="button" className={buttonPrimary} disabled={pending !== null} onClick={() => sync(item.id)}>
                    {pending === item.id ? "Working…" : more[item.id] ? "Continue" : "Refresh"}
                  </button>
                  {confirmId === item.id ? (
                    <>
                      <button
                        type="button"
                        className={buttonDanger}
                        disabled={pending !== null}
                        onClick={() => disconnect(item.id)}
                      >
                        {pending === `disconnect:${item.id}` ? "Disconnecting…" : "Confirm disconnect"}
                      </button>
                      <button type="button" className={buttonSecondary} disabled={pending !== null} onClick={() => setConfirmId(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" className={buttonDanger} disabled={pending !== null} onClick={() => setConfirmId(item.id)}>
                      Disconnect
                    </button>
                  )}
                </div>
                {working && (
                  <p aria-live="polite" className="text-sm text-muted">
                    Working…
                  </p>
                )}
              </div>
            </Panel>
          );
        })
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { IconCheck, IconAlertTriangle } from "@tabler/icons-react";
import {
  TOKEN_EXPIRY_CHOICES,
  type TokenExpiryChoice,
  type TokenLifecycleStatus,
} from "@/lib/token-lifecycle";
import { TokenLifecycleNote } from "@/components/TokenLifecycle";
import { TokenRow } from "@/components/TokenRow";
import { connectHealthConnect, disconnect } from "./actions";

const EXPIRY_LABEL: Record<TokenExpiryChoice, string> = {
  never: "Never expires",
  "90d": "Expires in 90 days",
  "1y": "Expires in 1 year",
};

// A controlled expiry dropdown (client state feeds the server action call), mirroring
// the calendar-feed config picker.
function ExpiryPicker({
  value,
  onChange,
  disabled,
}: {
  value: TokenExpiryChoice;
  onChange: (v: TokenExpiryChoice) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="label">Expiry</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as TokenExpiryChoice)}
        className="input"
        data-testid="token-expiry-select"
      >
        {TOKEN_EXPIRY_CHOICES.map((c) => (
          <option key={c} value={c}>
            {EXPIRY_LABEL[c]}
          </option>
        ))}
      </select>
    </label>
  );
}

// The Health Connect ingest-token panel (issue #1209). The token is HASHED at rest,
// so the plaintext is shown EXACTLY ONCE — at generate/rotate, from the action's
// return value held in local `revealedToken` state (which survives the post-action
// revalidate since this client component instance persists). A plain page load of an
// already-connected profile shows NO token, just a Rotate button (the share-link /
// calendar-feed reveal-once model). The env-fallback token is operator config, so
// it's still displayed directly.
export default function HealthConnectSetup({
  endpoint,
  connected,
  source,
  envToken,
  status,
  createdAt,
  lastUsedAt,
  expiresAt,
  lastSummary,
  lastSyncAt,
}: {
  endpoint: string;
  connected: boolean;
  source: "db" | "env" | "none";
  envToken: string | null;
  status: TokenLifecycleStatus;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  lastSummary: Record<string, number> | null;
  lastSyncAt: string | null;
}) {
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<TokenExpiryChoice>("never");

  // Show the connected/token view the moment a token is minted, even before the RSC
  // revalidate flips `connected` (the local reveal is the source of truth for "just
  // created").
  const isConnected = connected || revealedToken != null;

  async function onGenerateOrRotate() {
    setBusy(true);
    setError(null);
    const res = await connectHealthConnect(expiry);
    setBusy(false);
    if (res.ok) setRevealedToken(res.token);
    else setError(res.error);
  }

  async function onDisconnect() {
    setBusy(true);
    setError(null);
    setRevealedToken(null);
    await disconnect();
    setBusy(false);
  }

  if (!isConnected) {
    return (
      <div className="card max-w-2xl space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Generate a token to enable the ingest endpoint, then paste it into the
          exporter app on your phone. For your security the token is shown{" "}
          <strong>only once</strong> — copy it right away.
        </p>
        <div className="max-w-xs">
          <ExpiryPicker value={expiry} onChange={setExpiry} disabled={busy} />
        </div>
        {error && (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        )}
        <button
          className="btn"
          disabled={busy}
          onClick={onGenerateOrRotate}
          data-testid="health-connect-generate"
        >
          {busy ? "Generating…" : "Generate token & enable"}
        </button>
      </div>
    );
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-2">
        {status === "expired" ? (
          <span
            className="badge inline-flex items-center gap-1 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
            data-testid="health-connect-status"
          >
            <IconAlertTriangle className="h-3.5 w-3.5" /> Expired
          </span>
        ) : (
          <span
            className="badge inline-flex items-center gap-1 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
            data-testid="health-connect-status"
          >
            <IconCheck className="h-3.5 w-3.5" /> Connected
          </span>
        )}
        {lastSyncAt && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Last sync: {lastSyncAt} UTC
          </span>
        )}
      </div>

      <TokenRow label="Endpoint URL" value={endpoint} />

      {revealedToken ? (
        <div>
          <TokenRow
            label="Bearer token"
            value={revealedToken}
            secret
            testid="health-connect-token"
          />
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Copy this now — for your security the token is shown only once. You
            can always rotate to a new one below.
          </p>
        </div>
      ) : source === "env" && envToken ? (
        <div>
          <TokenRow
            label="Bearer token"
            value={envToken}
            secret
            testid="health-connect-token"
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            This token comes from the{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 dark:bg-ink-800">
              HEALTH_CONNECT_TOKEN
            </code>{" "}
            environment fallback — it&apos;s a static value with no expiry or
            last-used tracking. Rotate below to switch to a managed, DB-backed
            token.
          </p>
        </div>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          The endpoint is active. For security the bearer token is only shown at
          the moment it&apos;s created, so it can&apos;t be displayed again. If
          you need the token, <strong>Rotate</strong> it (this replaces the old
          token — update your phone exporter afterward).
        </p>
      )}

      {source === "db" && (
        <TokenLifecycleNote
          status={status}
          createdAt={createdAt}
          lastUsedAt={lastUsedAt}
          expiresAt={expiresAt}
        />
      )}

      {lastSummary && (
        <div>
          <label className="label">Last sync</label>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(lastSummary).map(([k, v]) => (
              <span
                key={k}
                className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
              >
                {k}: {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
      )}

      <div className="flex flex-wrap items-end gap-3 border-t border-black/5 pt-4 dark:border-white/5">
        <div className="w-40">
          <ExpiryPicker value={expiry} onChange={setExpiry} disabled={busy} />
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onGenerateOrRotate}
          className="rounded-lg border border-black/10 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800"
          data-testid="health-connect-rotate"
        >
          {busy ? "Rotating…" : "Rotate token"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDisconnect}
          className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

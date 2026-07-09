"use client";

import { useState } from "react";
import {
  IconCopy,
  IconCheck,
  IconRefresh,
  IconAlertTriangle,
  IconUsersGroup,
} from "@tabler/icons-react";
import {
  TOKEN_EXPIRY_CHOICES,
  type TokenExpiryChoice,
  type TokenLifecycleStatus,
} from "@/lib/token-lifecycle";
import { TokenLifecycleNote } from "@/components/TokenLifecycle";
import {
  enableConsolidatedCalendarFeedAction,
  disableConsolidatedCalendarFeedAction,
} from "./actions";

// Compose the absolute subscribe URL: prefer the server-provided base (the
// configured public URL, reachable by an external calendar client), falling back
// to the current origin for a plain localhost/dev setup.
function absoluteUrl(base: string, path: string): string {
  const b =
    base || (typeof window !== "undefined" ? window.location.origin : "");
  return `${b}${path}`;
}

const EXPIRY_LABEL: Record<TokenExpiryChoice, string> = {
  never: "Never expires",
  "90d": "Expires in 90 days",
  "1y": "Expires in 1 year",
};

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
        data-testid="family-token-expiry-select"
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

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — URL is shown for manual copy */
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800"
      aria-label="Copy"
    >
      {copied ? (
        <IconCheck className="h-3.5 w-3.5" />
      ) : (
        <IconCopy className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// Enable/rotate/disable UI for the CONSOLIDATED (per-login) "family" calendar feed.
// Mirrors CalendarFeedConfig's token lifecycle, minus the detail toggle — the
// family feed honors each profile's OWN detail level, so there's nothing to set here.
export default function ConsolidatedFeedConfig({
  enabled,
  baseUrl,
  status,
  createdAt,
  lastUsedAt,
  expiresAt,
  profileCount,
}: {
  enabled: boolean;
  baseUrl: string;
  status: TokenLifecycleStatus;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  profileCount: number;
}) {
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<TokenExpiryChoice>("never");

  async function onEnableOrRotate() {
    setBusy(true);
    setError(null);
    const res = await enableConsolidatedCalendarFeedAction(expiry);
    setBusy(false);
    if (res.ok && res.path) {
      setCreatedUrl(absoluteUrl(baseUrl, res.path));
    } else if (!res.ok) {
      setError(res.error);
    }
  }

  async function onDisable() {
    setBusy(true);
    setError(null);
    setCreatedUrl(null);
    const res = await disableConsolidatedCalendarFeedAction();
    setBusy(false);
    if (!res.ok) setError(res.error);
  }

  const spanNote = `Spans ${profileCount} ${
    profileCount === 1 ? "profile" : "profiles"
  } you can access.`;

  if (!enabled) {
    return (
      <div
        className="card max-w-2xl space-y-4"
        data-testid="family-feed-config"
      >
        <div className="flex items-center gap-2">
          <IconUsersGroup className="h-5 w-5 text-slate-400 dark:text-slate-500" />
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Family calendar — one feed for everyone
          </h2>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Enable a single subscribe link that merges the upcoming appointments
          of <strong>every profile you can access</strong> into one calendar —
          each event labeled with the profile&apos;s name. {spanNote} Each
          profile keeps its own detail level, so a profile set to minimal still
          shows only &ldquo;Medical appointment&rdquo;.
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
          onClick={onEnableOrRotate}
          data-testid="family-feed-enable"
        >
          {busy ? "Enabling…" : "Enable family feed"}
        </button>
      </div>
    );
  }

  return (
    <div className="card max-w-3xl space-y-4" data-testid="family-feed-config">
      <div className="flex items-center gap-2">
        <IconUsersGroup className="h-5 w-5 text-slate-400 dark:text-slate-500" />
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Family calendar
        </h2>
        {status === "expired" ? (
          <span
            className="badge inline-flex items-center gap-1 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
            data-testid="family-feed-status"
          >
            <IconAlertTriangle className="h-3.5 w-3.5" /> Expired
          </span>
        ) : (
          <span
            className="badge inline-flex items-center gap-1 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
            data-testid="family-feed-status"
          >
            <IconCheck className="h-3.5 w-3.5" /> Enabled
          </span>
        )}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">{spanNote}</p>

      {createdUrl ? (
        <div>
          <label className="label">Subscribe URL</label>
          <div className="flex items-center gap-2">
            <code
              className="input min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs"
              data-testid="family-feed-url"
            >
              {createdUrl}
            </code>
            <CopyButton value={createdUrl} />
          </div>
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Copy this now — for your security the link is shown only once. You
            can always rotate to a new one below.
          </p>
        </div>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          The family feed is active. For security the subscribe link is only
          shown at the moment it&apos;s created. If you need the link,{" "}
          <strong>Rotate</strong> it (this replaces the old link — update your
          calendar subscription afterward).
        </p>
      )}

      <TokenLifecycleNote
        status={status}
        createdAt={createdAt}
        lastUsedAt={lastUsedAt}
        expiresAt={expiresAt}
      />

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
          onClick={onEnableOrRotate}
          className="inline-flex items-center gap-1 rounded-lg border border-black/10 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800"
          data-testid="family-feed-rotate"
        >
          <IconRefresh className="h-4 w-4" /> Rotate link
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDisable}
          className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
          data-testid="family-feed-disable"
        >
          Disable family feed
        </button>
      </div>
    </div>
  );
}

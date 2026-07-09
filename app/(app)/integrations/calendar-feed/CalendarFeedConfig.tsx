"use client";

import { useState } from "react";
import {
  IconCopy,
  IconCheck,
  IconRefresh,
  IconAlertTriangle,
} from "@tabler/icons-react";
import type { CalendarFeedDetail } from "@/lib/settings";
import {
  enableCalendarFeedAction,
  disableCalendarFeedAction,
  setCalendarFeedDetailAction,
} from "./actions";

// Compose the absolute subscribe URL: prefer the server-provided base (the
// configured public URL, reachable by an external calendar client), falling back
// to the current origin for a plain localhost/dev setup.
function absoluteUrl(base: string, path: string): string {
  const b =
    base || (typeof window !== "undefined" ? window.location.origin : "");
  return `${b}${path}`;
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

export default function CalendarFeedConfig({
  enabled,
  detail,
  baseUrl,
}: {
  enabled: boolean;
  detail: CalendarFeedDetail;
  baseUrl: string;
}) {
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [curDetail, setCurDetail] = useState<CalendarFeedDetail>(detail);

  async function onEnableOrRegenerate() {
    setBusy(true);
    setError(null);
    const res = await enableCalendarFeedAction();
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
    const res = await disableCalendarFeedAction();
    setBusy(false);
    if (!res.ok) setError(res.error);
  }

  async function onSetDetail(next: CalendarFeedDetail) {
    if (next === curDetail) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("detail", next);
    const res = await setCalendarFeedDetailAction(fd);
    setBusy(false);
    if (res.ok) setCurDetail(next);
    else setError(res.error);
  }

  if (!enabled) {
    return (
      <div className="card max-w-2xl space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Enable the feed to get a private subscribe link. Add it to Google,
          Apple, or Outlook Calendar and your upcoming medical appointments —
          with 1-day and 1-hour reminders — will appear automatically and stay
          in sync.
        </p>
        {error && (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        )}
        <button className="btn" disabled={busy} onClick={onEnableOrRegenerate}>
          {busy ? "Enabling…" : "Enable feed"}
        </button>
      </div>
    );
  }

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="card space-y-4">
        <div className="flex items-center gap-2">
          <span className="badge inline-flex items-center gap-1 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
            <IconCheck className="h-3.5 w-3.5" /> Enabled
          </span>
        </div>

        {createdUrl ? (
          <div>
            <label className="label">Subscribe URL</label>
            <div className="flex items-center gap-2">
              <code className="input min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
                {createdUrl}
              </code>
              <CopyButton value={createdUrl} />
            </div>
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              Copy this now — for your security the link is shown only once. You
              can always regenerate a new one below.
            </p>
          </div>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            The feed is active. For security the subscribe link is only shown at
            the moment it&apos;s created, so it can&apos;t be displayed again.
            If you need the link, <strong>Regenerate</strong> it (this replaces
            the old link — update your calendar subscription afterward).
          </p>
        )}

        {error && (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        )}

        <div>
          <label className="label">Detail level</label>
          <div className="inline-flex overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
            {(["minimal", "full"] as const).map((d) => (
              <button
                key={d}
                type="button"
                disabled={busy}
                onClick={() => onSetDetail(d)}
                className={`px-3 py-1.5 text-sm font-medium capitalize ${
                  curDetail === d
                    ? "bg-brand-600 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            <strong>Minimal</strong> (recommended): each event is just
            &ldquo;Medical appointment&rdquo; (plus location) — no provider or
            reason leaves this app.
          </p>
          {curDetail === "full" && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Full detail sends the <strong>provider name and reason</strong>{" "}
                of each visit to your calendar provider
                (Google/Apple/Microsoft). Only use it if you&apos;re comfortable
                with that PHI leaving the app.
              </span>
            </p>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={onEnableOrRegenerate}
            className="inline-flex items-center gap-1 rounded-lg border border-black/10 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800"
          >
            <IconRefresh className="h-4 w-4" /> Regenerate link
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDisable}
            className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
          >
            Disable feed
          </button>
        </div>
      </div>
    </div>
  );
}

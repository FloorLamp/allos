"use client";

import { useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import type { SessionSummary } from "@/lib/auth";
import { deviceLabel } from "@/lib/user-agent-label";
import { revokeSessionAction, signOutOtherSessions } from "./actions";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatTimestamp } from "@/lib/format-date";

// Active sessions (#1451.A). The list used to render every live session
// uncollapsed with its RAW user-agent truncated to the same
// "Mozilla/5.0 (X11; Linux x…" on every row — 22 rows, ~2,000px tall on a phone,
// and no way to tell which one you were revoking. Four changes fix that:
//
//   1. Rows are labelled by a parsed "Chrome · Linux" device label
//      (lib/user-agent-label.ts, unit tested) instead of the raw UA. The raw string
//      stays available as the element's title for the rare case it matters.
//   2. Signed-in / last-seen are promoted to their own line rather than being the
//      only thing that distinguished a row.
//   3. The list collapses to the most recent few with a "Show all N" — the recent
//      handful is what anyone actually acts on.
//   4. "Sign out everywhere else" sits at the TOP, because it's the action you
//      reach for when the list is long and you don't want to read it.
//
// canRevoke=false (demo mode, #278) keeps the list readable but drops the revoke
// buttons — the SHARED demo login's "other sessions" are other visitors, and the
// actions refuse server-side anyway (requireLoginWriteAccess).

const COLLAPSED_COUNT = 5;

export default function ActiveSessions({
  sessions,
  canRevoke = true,
}: {
  sessions: SessionSummary[];
  canRevoke?: boolean;
}) {
  // One admin-ops timestamp shape, read as UTC (issue #1448) — the same
  // formatter the Audit / Errors / AI-log tables use.
  const formatPrefs = useFormatPrefs();
  const fmt = (ts: string) => formatTimestamp(ts, formatPrefs, { zone: "utc" });
  const otherCount = sessions.filter((s) => !s.current).length;
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, sessions.length - COLLAPSED_COUNT);
  const shown = expanded ? sessions : sessions.slice(0, COLLAPSED_COUNT);

  return (
    <div className="card space-y-4" data-testid="active-sessions">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Active sessions
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {sessions.length} device{sessions.length === 1 ? "" : "s"} signed in
            to your login.
          </p>
        </div>
        {otherCount > 0 && canRevoke && (
          <form action={signOutOtherSessions} className="shrink-0">
            <SubmitButton className="btn-ghost" pendingLabel="Signing out…">
              Sign out everywhere else
            </SubmitButton>
          </form>
        )}
      </div>

      <ul className="space-y-2">
        {shown.map((s) => {
          const device = deviceLabel(s.userAgent);
          return (
            <li
              key={s.id}
              data-testid="session-row"
              className="flex items-start justify-between gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="text-sm font-medium text-slate-800 dark:text-slate-100"
                    title={s.userAgent ?? undefined}
                    data-testid="session-device"
                  >
                    {device.label}
                  </span>
                  {s.current && (
                    <span className="badge shrink-0 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                      This device
                    </span>
                  )}
                </div>
                <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                  <div className="flex gap-1">
                    <dt>Last seen</dt>
                    <dd className="font-medium text-slate-700 dark:text-slate-200">
                      {fmt(s.lastSeenAt)} UTC
                    </dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>Signed in</dt>
                    <dd>{fmt(s.createdAt)} UTC</dd>
                  </div>
                </dl>
              </div>
              {!s.current && canRevoke && (
                <form action={revokeSessionAction} className="shrink-0">
                  <input type="hidden" name="session_id" value={s.id} />
                  <SubmitButton className="btn-ghost text-sm" pendingLabel="…">
                    Revoke
                  </SubmitButton>
                </form>
              )}
            </li>
          );
        })}
      </ul>

      {hidden > 0 && (
        <button
          type="button"
          className="btn-ghost text-sm"
          onClick={() => setExpanded((v) => !v)}
          data-testid="sessions-show-all"
        >
          {expanded ? "Show fewer" : `Show all ${sessions.length}`}
        </button>
      )}
    </div>
  );
}

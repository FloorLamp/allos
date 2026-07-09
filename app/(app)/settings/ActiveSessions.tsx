"use client";

import SubmitButton from "@/components/SubmitButton";
import type { SessionSummary } from "@/lib/auth";
import { revokeSessionAction, signOutOtherSessions } from "./actions";

// Format a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") in the viewer's locale.
// Rendered client-side so it reflects the reader's own zone.
function fmt(ts: string): string {
  const d = new Date(ts.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

// Active-sessions view (issue #132, Phase B). Lists every live session for the
// signed-in login with per-session revoke, plus a standalone "sign out
// everywhere else". The current device is labelled and can't be revoked from
// here (use logout for that) so the list can't leave you with nothing.
export default function ActiveSessions({
  sessions,
}: {
  sessions: SessionSummary[];
}) {
  const otherCount = sessions.filter((s) => !s.current).length;

  return (
    <div className="card mt-6 max-w-lg space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Active sessions
        </h2>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Devices currently signed in to your login ({sessions.length}). Revoke
          any you don&apos;t recognize.
        </p>
      </div>

      <ul className="space-y-2">
        {sessions.map((s) => (
          <li
            key={s.id}
            className="flex items-start justify-between gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                  {s.userAgent ?? "Unknown device"}
                </span>
                {s.current && (
                  <span className="badge shrink-0 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                    This device
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 dark:text-slate-500">
                Signed in {fmt(s.createdAt)} · Last seen {fmt(s.lastSeenAt)}
              </p>
            </div>
            {!s.current && (
              <form action={revokeSessionAction} className="shrink-0">
                <input type="hidden" name="session_id" value={s.id} />
                <SubmitButton className="btn-ghost text-sm" pendingLabel="…">
                  Revoke
                </SubmitButton>
              </form>
            )}
          </li>
        ))}
      </ul>

      {otherCount > 0 && (
        <form action={signOutOtherSessions}>
          <SubmitButton className="btn-ghost" pendingLabel="Signing out…">
            Sign out everywhere else
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

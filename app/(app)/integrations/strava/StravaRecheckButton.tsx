"use client";

import { useTransition } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { recheckStravaEmptySessions } from "./actions";

// The explicit re-ask (#3037). Storing what Strava answered is what lets the
// backfill badge reach zero; this is the affordance that keeps the answer
// reversible, so a session made public again — or one whose upload has since
// finished processing — is never abandoned, only set aside until someone asks.
export default function StravaRecheckButton({
  answeredNone,
}: {
  answeredNone: number;
}) {
  const [pending, start] = useTransition();
  const toast = useToast();

  if (answeredNone === 0) return null;

  function run() {
    start(async () => {
      const result = await recheckStravaEmptySessions();
      toast(result.message, {
        tone: result.status === "error" ? "error" : "success",
      });
    });
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={pending}
      data-testid="strava-recheck-empty"
      className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-2.5 py-1 text-sm font-medium text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-slate-300 dark:hover:border-brand-800 dark:hover:text-brand-400"
    >
      <IconRefresh className="h-4 w-4" stroke={1.75} />
      {pending ? "Re-checking…" : "Re-check sessions with no details"}
      <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-600 dark:bg-ink-800 dark:text-slate-300">
        {answeredNone}
      </span>
    </button>
  );
}

"use client";

import { useTransition } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { syncStravaNow } from "@/app/(app)/integrations/strava/actions";
import { syncOuraNow } from "@/app/(app)/integrations/oura/actions";
import { syncWithingsNow } from "@/app/(app)/integrations/withings/actions";
import { useToast } from "@/components/Toast";

// Per-provider "Sync now" for the Data → Review "Connected sources" section (issue
// #208). Pulls the recurring stream on demand (the same idempotent sync the hourly
// tick runs) and toasts the outcome; the action revalidates /data so the source
// card's latest-state line refreshes. Only rendered for a provider with a pull path
// (Strava and Oura today — Health Connect is push-only and shows an explainer
// instead), gated on the button's provider id.
export default function SyncNowButton({ provider }: { provider: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();

  function run() {
    const sync =
      provider === "strava"
        ? syncStravaNow
        : provider === "oura"
          ? syncOuraNow
          : provider === "withings"
            ? syncWithingsNow
            : null;
    if (!sync) return;
    start(async () => {
      const res = await sync();
      toast(res.message, {
        tone: res.status === "error" ? "error" : "success",
      });
    });
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-sm font-medium text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-ink-700 dark:text-slate-300 dark:hover:border-brand-800 dark:hover:text-brand-400"
    >
      <IconRefresh
        className={`h-4 w-4 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`}
        stroke={1.75}
      />
      {pending ? "Syncing…" : "Sync now"}
    </button>
  );
}

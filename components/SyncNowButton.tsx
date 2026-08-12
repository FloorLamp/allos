"use client";

import { useTransition } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { syncNow } from "@/app/(app)/integrations/sync-actions";
import { useToast } from "@/components/Toast";
import type { IntegrationId } from "@/lib/types";

// THE per-source "Sync now" (#208, unified in #1772). Pulls the recurring stream on
// demand — the same idempotent sync the hourly tick runs — and toasts the outcome;
// the action revalidates the surfaces it feeds (including /data and the source's own
// setup page), so nothing here refreshes the router by hand. Rendered by BOTH the
// setup page and Review's Connected sources: those used to offer different sync
// affordances for the same run (a redirecting <form> here, this button there). Only
// for a source with a pull path — Health Connect is push-only and shows an
// explainer instead, and the action refuses an id with no pull facet (#2040), so this
// button no longer keeps its own list of which four sources can sync.
export default function SyncNowButton({
  sourceId,
}: {
  sourceId: IntegrationId;
}) {
  const [pending, start] = useTransition();
  const toast = useToast();

  function run() {
    start(async () => {
      const res = await syncNow(sourceId);
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
      data-testid={`sync-now-${sourceId}`}
      className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-2.5 py-1 text-sm font-medium text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-slate-300 dark:hover:border-brand-800 dark:hover:text-brand-400"
    >
      <IconRefresh
        className={`h-4 w-4 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`}
        stroke={1.75}
      />
      {pending ? "Syncing…" : "Sync now"}
    </button>
  );
}

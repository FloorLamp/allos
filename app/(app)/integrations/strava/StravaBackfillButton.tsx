"use client";

import { useTransition } from "react";
import { IconDatabaseImport } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { backfillStravaRideDetails } from "./actions";

export default function StravaBackfillButton({ missing }: { missing: number }) {
  const [pending, start] = useTransition();
  const toast = useToast();

  function run() {
    start(async () => {
      const result = await backfillStravaRideDetails();
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
      data-testid="strava-backfill-details"
      className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-2.5 py-1 text-sm font-medium text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-slate-300 dark:hover:border-brand-800 dark:hover:text-brand-400"
    >
      <IconDatabaseImport className="h-4 w-4" stroke={1.75} />
      {pending ? "Backfilling…" : "Backfill ride details"}
      {missing > 0 && (
        <span className="rounded-full bg-brand-50 px-1.5 text-xs text-brand-700 dark:bg-brand-950 dark:text-brand-300">
          {missing}
        </span>
      )}
    </button>
  );
}

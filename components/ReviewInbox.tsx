import Link from "next/link";
import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react";
import type { IntegrationSyncEvent, IntegrationId } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import { getIntegration } from "@/lib/integrations/registry";
import { formatWindow, formatSplitLabel } from "@/lib/integrations/sync-log";
import RelativeTime from "@/components/RelativeTime";
import RawPayloadViewer from "@/components/RawPayloadViewer";
import DuplicateReview from "@/components/DuplicateReview";
import type {
  ActivityDupRow,
  BodyMetricConflictRow,
} from "@/lib/queries/integrations";
import type {
  ActivityDupPair,
  BodyMetricConflictPair,
} from "@/lib/import-review/detect";

// Data → Review: a per-profile inbox for background integration imports.
// Surfaces (a) integrations that are currently failing ("Needs attention"),
// (b) DETECTED duplicate/conflict pairs with merge/keep-both/dismiss actions
// (issue #10, Phase 2), and (c) a newest-first feed of recent syncs with their
// written/skipped counts and data window. Server component — the page reads
// everything via lib/queries and hands it in.

function providerName(id: string): string {
  return getIntegration(id as IntegrationId)?.name ?? id;
}

// Only providers with a real setup page are linkable (/integrations/<id>).
function providerHref(id: string): string | null {
  return getIntegration(id as IntegrationId) ? `/integrations/${id}` : null;
}

function CountBits({ ev }: { ev: IntegrationSyncEvent }) {
  const { primary, muted } = formatSplitLabel(ev);
  const skipped = ev.skipped ?? 0;
  return (
    <>
      <span
        className={muted ? "text-slate-400 dark:text-slate-500" : undefined}
      >
        {primary}
      </span>
      {skipped > 0 && (
        <span className="text-amber-600 dark:text-amber-400">
          {" "}
          · {skipped} skipped
        </span>
      )}
    </>
  );
}

export default function ReviewInbox({
  issues,
  recent,
  activityPairs = [],
  bodyMetricPairs = [],
  units,
  isAdmin = false,
}: {
  issues: IntegrationSyncEvent[];
  recent: IntegrationSyncEvent[];
  // Detected, still-unresolved duplicate/conflict pairs (issue #10).
  activityPairs?: ActivityDupPair<ActivityDupRow>[];
  bodyMetricPairs?: BodyMetricConflictPair<BodyMetricConflictRow>[];
  units: UnitPrefs;
  // Admins can inspect the raw provider payload captured per sync (issue #9). The
  // "View raw" affordance is only rendered for admins on events that carry a
  // raw_ref; the route it hits is itself admin-gated + profile-scoped.
  isAdmin?: boolean;
}) {
  return (
    <div className="space-y-6" data-testid="review-inbox">
      <DuplicateReview
        activityPairs={activityPairs}
        bodyMetricPairs={bodyMetricPairs}
        units={units}
      />

      {issues.length > 0 && (
        <div className="card border-rose-200 dark:border-rose-900/50">
          <div className="mb-3 flex items-center gap-2">
            <IconAlertTriangle
              className="h-5 w-5 text-rose-500"
              stroke={1.75}
            />
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Needs attention
            </h2>
          </div>
          <ul className="space-y-3">
            {issues.map((ev) => {
              const href = providerHref(ev.provider);
              return (
                <li
                  key={ev.id}
                  className="rounded-lg border border-rose-200 bg-rose-50/50 p-3 dark:border-rose-900/50 dark:bg-rose-950/20"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {providerName(ev.provider)} sync failed
                    </span>
                    <RelativeTime
                      value={ev.at}
                      className="text-xs text-slate-500 dark:text-slate-400"
                    />
                  </div>
                  {ev.error && (
                    <p className="mt-1 break-words text-sm text-rose-700 dark:text-rose-300">
                      {ev.error}
                    </p>
                  )}
                  {href && (
                    <Link
                      href={href}
                      className="mt-2 inline-block text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
                    >
                      Check {providerName(ev.provider)} settings →
                    </Link>
                  )}
                  {isAdmin && ev.raw_ref && <RawPayloadViewer id={ev.id} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="mb-1">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Recent imports
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            What your connected devices and services have synced, newest first.
          </p>
        </div>
        {recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            No imports yet. Connect a device or service on the Import tab to
            sync data automatically.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-black/5 dark:divide-white/5">
            {recent.map((ev) => (
              <li
                key={ev.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
              >
                {ev.ok ? (
                  <IconCircleCheck
                    className="h-4 w-4 shrink-0 text-emerald-500"
                    stroke={1.75}
                  />
                ) : (
                  <IconAlertTriangle
                    className="h-4 w-4 shrink-0 text-rose-500"
                    stroke={1.75}
                  />
                )}
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {providerName(ev.provider)}
                </span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  <CountBits ev={ev} />
                </span>
                <span className="text-sm text-slate-400 dark:text-slate-500">
                  {formatWindow(ev.window_start, ev.window_end)}
                </span>
                <RelativeTime
                  value={ev.at}
                  className="ml-auto text-xs text-slate-400 dark:text-slate-500"
                />
                {isAdmin && ev.raw_ref && <RawPayloadViewer id={ev.id} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

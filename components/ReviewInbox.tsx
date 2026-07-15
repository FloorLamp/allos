import Link from "next/link";
import { IconAlertTriangle } from "@tabler/icons-react";
import type { IntegrationSyncEvent, IntegrationId } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import { getIntegration } from "@/lib/integrations/registry";
import { integrationDetailHref, type AppRoute } from "@/lib/hrefs";
import type { FeedEntry } from "@/lib/import-feed";
import RelativeTime from "@/components/RelativeTime";
import RawPayloadViewer from "@/components/RawPayloadViewer";
import DuplicateReview from "@/components/DuplicateReview";
import UnitMislabelReview from "@/components/UnitMislabelReview";
import ConnectedSources from "@/components/ConnectedSources";
import ImportFeed from "@/components/ImportFeed";
import type {
  ActivityDupRow,
  BodyMetricConflictRow,
  ConnectedSource,
} from "@/lib/queries/integrations";
import type { UnitMislabelReview as UnitMislabelReviewRow } from "@/lib/queries/medical";
import type {
  ActivityDupPair,
  BodyMetricConflictPair,
} from "@/lib/import-review/detect";

// Data → Review: the single "all my imported data" surface for a profile. Two
// mental models, split into two sections (issue #208), with a shared strip on top:
// (a) integrations currently failing ("Needs attention") and (b) DETECTED
// duplicate/conflict pairs (issue #10, Phase 2) span both, then
// (c) "Connected sources" (<ConnectedSources>) — the RECURRING per-provider streams
// collapsed to latest-state with a Sync now / push explainer — and
// (d) "Imports" (<ImportFeed>) — the chronological one-off feed of documents +
// paste jobs. Server component — the page reads everything via lib/queries.

function providerName(id: string): string {
  return getIntegration(id as IntegrationId)?.name ?? id;
}

// Only providers with a real setup page are linkable (/integrations/<id>).
function providerHref(id: string): AppRoute | null {
  return integrationDetailHref(id as IntegrationId);
}

export default function ReviewInbox({
  issues,
  sources,
  feed,
  knownNames,
  activityPairs = [],
  bodyMetricPairs = [],
  unitMislabels = [],
  units,
  isAdmin = false,
}: {
  issues: IntegrationSyncEvent[];
  // The recurring per-provider streams for the "Connected sources" section.
  sources: ConnectedSource[];
  // The one-off "Imports" feed (documents + paste jobs), newest-first.
  feed: FeedEntry[];
  // The active profile's own name(s), for the document provenance-mismatch flag.
  knownNames: (string | null | undefined)[];
  // Detected, still-unresolved duplicate/conflict pairs (issue #10).
  activityPairs?: ActivityDupPair<ActivityDupRow>[];
  bodyMetricPairs?: BodyMetricConflictPair<BodyMetricConflictRow>[];
  // Probable power-of-ten unit mislabels (issue #761), each a one-click correction.
  unitMislabels?: UnitMislabelReviewRow[];
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

      <UnitMislabelReview items={unitMislabels} />

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

      <ConnectedSources sources={sources} isAdmin={isAdmin} />

      <ImportFeed feed={feed} knownNames={knownNames} isAdmin={isAdmin} />
    </div>
  );
}

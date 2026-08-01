import Link from "next/link";
import { IconAlertTriangle } from "@tabler/icons-react";
import type { IntegrationSyncEvent, IntegrationId } from "@/lib/types";
import type { UnitPrefs } from "@/lib/settings";
import { getIntegration } from "@/lib/integrations/registry";
import { isStaleSyncEvent } from "@/lib/integrations/staleness";
import { integrationDetailHref, type AppRoute } from "@/lib/hrefs";
import type { FeedEntry } from "@/lib/import-feed";
import type { DocumentTombstone } from "@/lib/document-tombstones";
import RelativeTime from "@/components/RelativeTime";
import RawPayloadViewer from "@/components/RawPayloadViewer";
import DuplicateReview from "@/components/DuplicateReview";
import UnitMislabelReview from "@/components/UnitMislabelReview";
import BulkCorrectionCard from "@/app/(app)/data/BulkCorrectionCard";
import type { CorrectionFieldId } from "@/lib/bulk-correction";
import type { CorrectionSourcesByField } from "@/lib/bulk-correction-db";
import BlockedDocuments from "@/components/BlockedDocuments";
import ConnectedSources from "@/components/ConnectedSources";
import ImportFeed from "@/components/ImportFeed";
import type {
  ActivityDupRow,
  BodyMetricConflictRow,
  ConnectedSource,
} from "@/lib/queries/integrations";
import type { UnitMislabelReview as UnitMislabelReviewRow } from "@/lib/queries/medical";
import type {
  ActivityDupCluster,
  BodyMetricConflictPair,
} from "@/lib/import-review/detect";

// Data → Review: the single "all my imported data" surface for a profile. Two
// mental models, split into two sections (issue #208), with a shared strip on top:
// (a) integrations currently failing ("Needs attention") and (b) DETECTED
// duplicate/conflict pairs (issue #10, Phase 2) span both, then
// (c) "Connected sources" (<ConnectedSources>) — the RECURRING per-provider streams
// as an INBOX since #1772: a provider needing attention expanded with the reason and
// the action, a healthy one collapsed to a single line linking to its own page (which
// owns its controls and its full sync history) — and
// (d) "Imports" (<ImportFeed>) — the chronological one-off feed of documents,
// archive imports, and paste jobs. Server component — the page reads everything via
// lib/queries.

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
  blockedDocuments = [],
  activityClusters = [],
  bodyMetricPairs = [],
  unitMislabels = [],
  correctionSources,
  initialCorrectionField = null,
  units,
  isAdmin = false,
}: {
  issues: IntegrationSyncEvent[];
  // The recurring per-provider streams for the "Connected sources" section.
  sources: ConnectedSource[];
  // The one-off "Imports" feed (documents + paste jobs), newest-first.
  feed: FeedEntry[];
  // Content-hash tombstones for this profile (#1777) — documents whose re-acquisition is
  // blocked, each reversible with a tap. Empty for the household that never deleted one.
  blockedDocuments?: DocumentTombstone[];
  // The active profile's own name(s), for the document provenance-mismatch flag.
  knownNames: (string | null | undefined)[];
  // Detected, still-unresolved duplicate ACTIVITY clusters (#10/#1081) + body-metric
  // conflict pairs.
  activityClusters?: ActivityDupCluster<ActivityDupRow>[];
  bodyMetricPairs?: BodyMetricConflictPair<BodyMetricConflictRow>[];
  // Probable power-of-ten unit mislabels (issue #761), each a one-click correction.
  unitMislabels?: UnitMislabelReviewRow[];
  // Bulk corrections (#1603): which source runs exist per correctable field, for
  // the "Fix a run of data" panel's pickers.
  correctionSources: CorrectionSourcesByField;
  // Pre-selected field from a contextual "Fix a range…" link (?fix=), or null.
  initialCorrectionField?: CorrectionFieldId | null;
  units: UnitPrefs;
  // Admins can inspect the raw provider payload captured per sync (issue #9). The
  // "View raw" affordance is only rendered for admins on events that carry a
  // raw_ref; the route it hits is itself admin-gated + profile-scoped.
  isAdmin?: boolean;
}) {
  return (
    <div className="space-y-6" data-testid="review-inbox">
      <DuplicateReview
        activityClusters={activityClusters}
        bodyMetricPairs={bodyMetricPairs}
        units={units}
      />

      <UnitMislabelReview items={unitMislabels} />

      {/* Fix a bad RUN of data in one pass (#1603) — the corrections neighborhood's
          bulk sibling to the per-row cards above. */}
      <BulkCorrectionCard
        sources={correctionSources}
        initialField={initialCorrectionField}
        units={{
          weightUnit: units.weightUnit,
          distanceUnit: units.distanceUnit,
        }}
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
              // The silent-stop signal (#1685) is a synthetic issue with no recorded
              // failure behind it, so "sync failed" would be a claim we can't support:
              // nothing failed, nothing arrived. Say what we actually observed. Its `at`
              // is the last SUCCESSFUL sync, which is what the relative time should read.
              const stale = isStaleSyncEvent(ev);
              return (
                <li
                  // Synthetic issues share a sentinel id across providers, so the row key
                  // must include the provider or two stopped sources would collide.
                  key={`${ev.provider}:${ev.id}`}
                  data-testid={`import-issue-${ev.provider}`}
                  className="rounded-lg border border-rose-200 bg-rose-50/50 p-3 dark:border-rose-900/50 dark:bg-rose-950/20"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {providerName(ev.provider)}{" "}
                      {stale ? "sync has stopped" : "sync failed"}
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

      {/* Documents the user deleted, which an acquirer is therefore refused when it
          offers them again (#1777) — with the one-tap way to change that mind. A
          SIBLING of the portal source card rather than nested in it: that card is
          rendered conditionally, so nesting would hide the only allow-again affordance
          for a household with deleted documents and no live portal connection. Renders
          nothing when nothing is blocked. */}
      <BlockedDocuments tombstones={blockedDocuments} />

      <ImportFeed feed={feed} knownNames={knownNames} isAdmin={isAdmin} />
    </div>
  );
}

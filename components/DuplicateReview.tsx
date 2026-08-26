import type { UnitPrefs } from "@/lib/settings";
import type { IntegrationId } from "@/lib/types";
import { getIntegration } from "@/lib/integrations/registry";
import { fmtDistance, fmtWeight } from "@/lib/units";
import {
  preferActivityKeeper,
  preferActivityKeeperId,
  BODY_METRIC_DOMAIN,
  type ActivityDupCluster,
  type BodyMetricConflictPair,
} from "@/lib/import-review/detect";
import { pickFoldValues } from "@/lib/import-review/conflicts";
import { disambiguationLabels } from "@/lib/import-review/disambiguate";
import ActivityMergeControls from "@/components/ActivityMergeControls";
import ActivityClusterControls, {
  type ClusterMemberView,
} from "@/components/ActivityClusterControls";
import DuplicateResolutionActions from "@/components/DuplicateResolutionActions";
import type {
  ActivityDupRow,
  BodyMetricConflictRow,
} from "@/lib/queries/integrations";
import {
  mergeBodyMetricPair,
  resolvePair,
} from "@/app/(app)/data/review-actions";

// Friendly provenance label for a row's `source`: an integration's display name
// when it maps to a known provider, "Manual entry" for a NULL source, else the raw
// source string (e.g. 'document:5').
function sourceLabel(source: string | null): string {
  if (!source) return "Manual entry";
  return getIntegration(source as IntegrationId)?.name ?? source;
}

function ConfidenceChip({ confidence }: { confidence: "high" | "medium" }) {
  const high = confidence === "high";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        high
          ? "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
          : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
      }`}
    >
      {high ? "High" : "Medium"} confidence
    </span>
  );
}

// A read-only summary line for one candidate row (used by both domains). `badge`
// is the on-card A/B (or 1/2) marker shown when the two candidates' source labels
// collide (#531) — the visible referent for the "keep A / keep B" affordances,
// correct in both the stacked and side-by-side layouts (unlike a spatial label).
function RowSummary({
  source,
  title,
  facts,
  isKeeper,
  badge,
}: {
  source: string | null;
  title: string;
  facts: string[];
  isKeeper: boolean;
  badge?: string;
}) {
  return (
    <div
      className={`rounded-lg border p-2.5 text-sm ${
        isKeeper
          ? "border-brand-300 bg-brand-50/50 dark:border-brand-800 dark:bg-brand-950/20"
          : "border-black/10 dark:border-white/10"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {badge && (
          <span
            data-testid="dup-candidate-badge"
            aria-label={`Option ${badge}`}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-xs font-bold text-white dark:bg-slate-200 dark:text-slate-900"
          >
            {badge}
          </span>
        )}
        <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-ink-800 dark:text-slate-300">
          {sourceLabel(source)}
        </span>
        <span className="font-medium text-slate-800 dark:text-slate-100">
          {title}
        </span>
        {isKeeper && (
          <span className="text-xs font-medium text-brand-600 dark:text-brand-400">
            keeps by default
          </span>
        )}
      </div>
      {facts.length > 0 && (
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {facts.join(" · ")}
        </div>
      )}
    </div>
  );
}

function activityFacts(row: ActivityDupRow, units: UnitPrefs): string[] {
  const facts: string[] = [];
  if (row.start_time)
    facts.push(
      row.end_time ? `${row.start_time}–${row.end_time}` : row.start_time
    );
  if (row.duration_min != null) facts.push(`${row.duration_min} min`);
  if (row.distance_km != null)
    facts.push(fmtDistance(row.distance_km, units.distanceUnit));
  return facts;
}

export default function DuplicateReview({
  activityClusters,
  bodyMetricPairs,
  units,
}: {
  activityClusters: ActivityDupCluster<ActivityDupRow>[];
  bodyMetricPairs: BodyMetricConflictPair<BodyMetricConflictRow>[];
  units: UnitPrefs;
}) {
  if (activityClusters.length === 0 && bodyMetricPairs.length === 0)
    return null;
  const total = activityClusters.length + bodyMetricPairs.length;

  return (
    <div className="card" data-testid="duplicate-review">
      <div className="mb-1">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Possible duplicates ({total})
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Two records that look like the same thing from different sources.
          Merge to keep one (folding in the other&apos;s details), or keep both
          if they&apos;re genuinely different.
        </p>
      </div>

      <ul className="mt-3 space-y-3">
        {activityClusters.map((cluster) => {
          if (cluster.members.length <= 2) {
            const a = cluster.members[0];
            const b = cluster.members[1];
            const keepId = preferActivityKeeper(a, b);
            const keeper = a.id === keepId ? a : b;
            const other = a.id === keepId ? b : a;
            const dis = disambiguationLabels(
              sourceLabel(keeper.source),
              sourceLabel(other.source)
            );
            return (
              <li
                key={`act:${cluster.signature}`}
                data-testid="dup-activity-pair"
                className="rounded-lg border border-black/10 p-3 dark:border-white/10"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <ConfidenceChip confidence={cluster.confidence} />
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {cluster.date} · {cluster.reason}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <RowSummary
                    source={keeper.source}
                    title={keeper.title}
                    facts={activityFacts(keeper, units)}
                    isKeeper
                    badge={dis.usedFallback ? "A" : undefined}
                  />
                  <RowSummary
                    source={other.source}
                    title={other.title}
                    facts={activityFacts(other, units)}
                    isKeeper={false}
                    badge={dis.usedFallback ? "B" : undefined}
                  />
                </div>
                <ActivityMergeControls
                  signature={cluster.signature}
                  aId={keeper.id}
                  bId={other.id}
                  aLabel={dis.a}
                  bLabel={dis.b}
                  // Both rows' fold values — the shared picker (#100/#1431)
                  // computes and orients the conflicts per pressed keeper.
                  aFoldValues={pickFoldValues(
                    keeper as unknown as Record<string, unknown>
                  )}
                  bFoldValues={pickFoldValues(
                    other as unknown as Record<string, unknown>
                  )}
                  units={units}
                />
              </li>
            );
          }

          // N ≥ 3: cluster card. Label by source; when two members' source labels
          // collide, fall back to ordinal on-card badges (#531).
          const labels = cluster.members.map((m) => sourceLabel(m.source));
          const collision = new Set(labels).size < labels.length;
          const memberViews: ClusterMemberView[] = cluster.members.map(
            (m, i) => ({
              id: m.id,
              sourceLabel: labels[i],
              title: m.title,
              facts: activityFacts(m, units),
              foldValues: pickFoldValues(
                m as unknown as Record<string, unknown>
              ),
              badge: collision ? String(i + 1) : undefined,
            })
          );
          return (
            <li
              key={`act:${cluster.signature}`}
              data-testid="dup-activity-cluster"
              className="rounded-lg border border-black/10 p-3 dark:border-white/10"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <ConfidenceChip confidence={cluster.confidence} />
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {cluster.date} · {cluster.members.length} copies ·{" "}
                  {cluster.reason}
                </span>
              </div>
              <ActivityClusterControls
                clusterSignature={cluster.signature}
                pairSignatures={cluster.pairSignatures}
                members={memberViews}
                defaultKeeperId={preferActivityKeeperId(cluster.members)}
                units={units}
              />
            </li>
          );
        })}

        {bodyMetricPairs.map((pair) => {
          // Keeper = a, other = b. Two manual weigh-ins both read "Manual entry",
          // so label by source when they differ, else A/B with an on-card badge
          // (#531) — the same shared disambiguator as the activity path.
          const { a, b, signature } = pair;
          const dis = disambiguationLabels(
            sourceLabel(a.source),
            sourceLabel(b.source)
          );
          const merge = mergeBodyMetricPair;
          const resolve = resolvePair;
          const mergePayload = (keep_id: number, drop_id: number) => ({
            keep_id,
            drop_id,
            signature,
          });
          const resolutionPayload = (decision: "kept-both" | "dismissed") => ({
            domain: BODY_METRIC_DOMAIN,
            decision,
            signature,
          });
          return (
            <li
              key={`bm:${signature}`}
              data-testid="dup-body-metric-pair"
              className="rounded-lg border border-black/10 p-3 dark:border-white/10"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                  Conflict
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {a.date} · {pair.reason}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <RowSummary
                  source={a.source}
                  title={sourceLabel(a.source)}
                  facts={bodyMetricFacts(a, units)}
                  isKeeper
                  badge={dis.usedFallback ? "A" : undefined}
                />
                <RowSummary
                  source={b.source}
                  title={sourceLabel(b.source)}
                  facts={bodyMetricFacts(b, units)}
                  isKeeper={false}
                  badge={dis.usedFallback ? "B" : undefined}
                />
              </div>
              <DuplicateResolutionActions
                actions={[
                  ["keeper", dis.a, merge, mergePayload(a.id, b.id)],
                  ["alternate-keeper", dis.b, merge, mergePayload(b.id, a.id)],
                  ["keep-both", null, resolve, resolutionPayload("kept-both")],
                  ["dismiss", null, resolve, resolutionPayload("dismissed")],
                ]}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function bodyMetricFacts(
  row: BodyMetricConflictRow,
  units: UnitPrefs
): string[] {
  const facts: string[] = [];
  if (row.weight_kg != null)
    facts.push(fmtWeight(row.weight_kg, units.weightUnit));
  if (row.body_fat_pct != null) facts.push(`${row.body_fat_pct}% BF`);
  if (row.resting_hr != null) facts.push(`${row.resting_hr} bpm`);
  return facts;
}

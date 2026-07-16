import { IconGitMerge, IconCopyCheck, IconEyeOff } from "@tabler/icons-react";
import type { UnitPrefs } from "@/lib/settings";
import type { IntegrationId } from "@/lib/types";
import { getIntegration } from "@/lib/integrations/registry";
import { fmtDistance, fmtWeight } from "@/lib/units";
import {
  preferActivityKeeper,
  ACTIVITY_DOMAIN,
  BODY_METRIC_DOMAIN,
  type ActivityDupPair,
  type BodyMetricConflictPair,
} from "@/lib/import-review/detect";
import { detectFieldConflicts } from "@/lib/import-review/conflicts";
import { disambiguationLabels } from "@/lib/import-review/disambiguate";
import ActivityMergeControls from "@/components/ActivityMergeControls";
import type {
  ActivityDupRow,
  BodyMetricConflictRow,
} from "@/lib/queries/integrations";
import {
  mergeBodyMetricPair,
  resolvePair,
} from "@/app/(app)/data/review-actions";

// Data → Review, Phase 2 (issue #10): the duplicate/conflict resolver. Renders each
// DETECTED pair with both rows' details + a confidence chip, and the three terminal
// actions — Merge (keep one row, folding the other's missing fields in), Keep both,
// Dismiss. Server component: the buttons are plain server-action <form>s (the same
// pattern as the Upcoming snooze/dismiss controls), so no client JS is needed. We
// NEVER auto-merge — every resolution is an explicit press.

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
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-ink-800 dark:text-slate-300">
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

// The three action buttons for one pair: a Merge form per candidate keeper, then
// Keep-both and Dismiss. Rendered for both domains — the merge action differs, so
// the caller passes the domain + the two ids + the merge server action.
function PairActions({
  domain,
  signature,
  keepId,
  dropId,
  mergeAction,
  keepLabelA,
  keepLabelB,
}: {
  domain: string;
  signature: string;
  // The default keeper (primary merge) and the other row.
  keepId: number;
  dropId: number;
  mergeAction: (formData: FormData) => void;
  keepLabelA: string;
  keepLabelB: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <form action={mergeAction}>
        <input type="hidden" name="keep_id" value={keepId} />
        <input type="hidden" name="drop_id" value={dropId} />
        <input type="hidden" name="signature" value={signature} />
        <button
          type="submit"
          data-testid="dup-merge-primary"
          className="btn btn-sm"
        >
          <IconGitMerge className="h-4 w-4" stroke={1.75} />
          Merge, keep {keepLabelA}
        </button>
      </form>
      <form action={mergeAction}>
        <input type="hidden" name="keep_id" value={dropId} />
        <input type="hidden" name="drop_id" value={keepId} />
        <input type="hidden" name="signature" value={signature} />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
        >
          Keep {keepLabelB} instead
        </button>
      </form>
      <form action={resolvePair}>
        <input type="hidden" name="domain" value={domain} />
        <input type="hidden" name="decision" value="kept-both" />
        <input type="hidden" name="signature" value={signature} />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
        >
          <IconCopyCheck className="h-4 w-4" stroke={1.75} />
          Keep both
        </button>
      </form>
      <form action={resolvePair}>
        <input type="hidden" name="domain" value={domain} />
        <input type="hidden" name="decision" value="dismissed" />
        <input type="hidden" name="signature" value={signature} />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-750"
        >
          <IconEyeOff className="h-4 w-4" stroke={1.75} />
          Dismiss
        </button>
      </form>
    </div>
  );
}

export default function DuplicateReview({
  activityPairs,
  bodyMetricPairs,
  units,
}: {
  activityPairs: ActivityDupPair<ActivityDupRow>[];
  bodyMetricPairs: BodyMetricConflictPair<BodyMetricConflictRow>[];
  units: UnitPrefs;
}) {
  if (activityPairs.length === 0 && bodyMetricPairs.length === 0) return null;
  const total = activityPairs.length + bodyMetricPairs.length;

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
        {activityPairs.map((pair) => {
          const keepId = preferActivityKeeper(pair.a, pair.b);
          const keeper = pair.a.id === keepId ? pair.a : pair.b;
          const other = pair.a.id === keepId ? pair.b : pair.a;
          // Keeper = A, other = B. Label by source when they differ, else A/B with
          // an on-card badge (#531).
          const dis = disambiguationLabels(
            sourceLabel(keeper.source),
            sourceLabel(other.source)
          );
          return (
            <li
              key={`act:${pair.signature}`}
              data-testid="dup-activity-pair"
              className="rounded-lg border border-black/10 p-3 dark:border-white/10"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <ConfidenceChip confidence={pair.confidence} />
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {pair.a.date} · {pair.reason}
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
                signature={pair.signature}
                aId={keeper.id}
                bId={other.id}
                aLabel={dis.a}
                bLabel={dis.b}
                // Oriented with the default keeper as A; the dialog flips values
                // for the "keep other" button (issue #100).
                conflicts={detectFieldConflicts(
                  keeper as unknown as Record<string, unknown>,
                  other as unknown as Record<string, unknown>
                )}
                units={units}
              />
            </li>
          );
        })}

        {bodyMetricPairs.map((pair) => {
          // Keeper = a, other = b. Two manual weigh-ins both read "Manual entry",
          // so label by source when they differ, else A/B with an on-card badge
          // (#531) — the same shared disambiguator as the activity path.
          const dis = disambiguationLabels(
            sourceLabel(pair.a.source),
            sourceLabel(pair.b.source)
          );
          return (
            <li
              key={`bm:${pair.signature}`}
              data-testid="dup-body-metric-pair"
              className="rounded-lg border border-black/10 p-3 dark:border-white/10"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                  Conflict
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {pair.a.date} · {pair.reason}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <RowSummary
                  source={pair.a.source}
                  title={sourceLabel(pair.a.source)}
                  facts={bodyMetricFacts(pair.a, units)}
                  isKeeper
                  badge={dis.usedFallback ? "A" : undefined}
                />
                <RowSummary
                  source={pair.b.source}
                  title={sourceLabel(pair.b.source)}
                  facts={bodyMetricFacts(pair.b, units)}
                  isKeeper={false}
                  badge={dis.usedFallback ? "B" : undefined}
                />
              </div>
              <PairActions
                domain={BODY_METRIC_DOMAIN}
                signature={pair.signature}
                keepId={pair.a.id}
                dropId={pair.b.id}
                mergeAction={mergeBodyMetricPair}
                keepLabelA={dis.a}
                keepLabelB={dis.b}
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

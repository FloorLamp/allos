import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getDisplayFormatPrefs,
  getUnitPrefs,
  getUserAge,
  getUserBirthdate,
  type WeightUnit,
} from "@/lib/settings";
import {
  formatLongDate,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { groupChartValue } from "@/lib/chart-format";
import { ageInMonthsFromBirthdate } from "@/lib/date";
import {
  showHeadCircEntry,
  showBodyFat,
  showGrowthQuickAdd,
} from "@/lib/growth-metrics";
import { getGoals } from "@/lib/queries";
import { dispWeight, round } from "@/lib/units";
import { filterSeriesByRange } from "@/lib/trends";
import {
  buildTrendAnnotations,
  buildProtocolTrendWindows,
} from "@/lib/trends-series";
import { bodyMetricSeriesFold } from "@/lib/body-metric-series";
import { projectGoal, describeEta } from "@/lib/trend-projection";
import { isGoalLive } from "@/lib/goals";
import {
  ALL_TIME_RANGE_PARAM,
  ALL_TIME_RANGE_VALUE,
  isAllTimeRange,
  isCustomRange,
  normalizeTimelineRange,
  resolveTrendsRange,
  timelineDateFromParam,
  type DateRange,
} from "@/lib/timeline-format";
import { rangeSummaryLabel } from "@/lib/trends";
import {
  BODY_METRIC_META,
  isBodyMetricSlug,
  resolveBodyMetricUnit,
  bodyChartScale,
  bodyMetricPeriodStats,
  savedMetricIdForBodySlug,
  seriesCoverageNote,
  type BodyMetricSlug,
  type PeriodStat,
} from "@/lib/trends-body-metrics";
import { anxietyDisplaySlot } from "@/lib/mood";
import { isAnxietyScaleRelevant } from "@/lib/queries/mood-anxiety";
import { metricSeriesKey } from "@/lib/saved-items";
import { isItemSaved } from "@/lib/queries/saved";
import type { AppRoute } from "@/lib/hrefs";
import {
  METRIC_READING_STORE,
  METRIC_READINGS_LIMIT,
  getMetricReadings,
  metricReadingTarget,
} from "@/lib/metric-readings";
import { readingTarget, readingTargetToken } from "@/lib/reading-placement";
import { getPanelSiblings } from "@/lib/queries/panel-siblings";
import { pediatricBpContextFor } from "@/lib/queries/bp-context";
import { getMetricJudgment } from "@/lib/queries/metric-judgment";
import type { Reading } from "@/lib/reading-model";
import { PanelSiblingsCard } from "@/components/PanelSiblingsCard";
import { PediatricBpCard } from "@/components/PediatricBpCard";
import { MetricJudgmentCard } from "@/components/MetricJudgmentCard";
import type { BodyMetricKind, Goal } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/ui";
import StarButton from "@/components/StarButton";
import PageContainer from "@/components/PageContainer";
import DateRangeControl from "@/components/DateRangeControl";
import {
  TrendAnnotationControls,
  TrendAnnotationProvider,
} from "@/components/TrendAnnotationToggles";
import BodyTrendCharts, {
  type BodyChartSpec,
} from "@/components/BodyTrendCharts";
import MetricReadingsTable, {
  type MetricReadingRow,
} from "@/components/MetricReadingsTable";
import SourceComparison from "../../SourceComparison";
import MetricMeasurementPanel from "./MetricMeasurementPanel";
import {
  isMeasurementEntryAllowed,
  type MeasurementEntryMetric,
} from "@/lib/measurement-entry";

export const dynamic = "force-dynamic";

// The detailed-page home for the source controls that used to live below the
// entire desktop Body chart stack. Only metrics backed by the source-priority
// system map here; single-source metrics render no comparison at all.
const SOURCE_COMPARISON_KEY: Partial<Record<BodyMetricSlug, string>> = {
  weight: "weight",
  "body-fat": "body_fat",
  "resting-hr": "resting_hr",
  steps: "steps",
  "active-calories": "active_kcal",
  hrv: "hrv_ms",
  hr: "heart_rate",
};

const MEASUREMENT_ENTRY_METRIC: Partial<
  Record<BodyMetricSlug, MeasurementEntryMetric>
> = {
  systolic: "blood-pressure",
  diastolic: "blood-pressure",
  spo2: "spo2",
  hrv: "hrv",
  temperature: "temperature",
  weight: "weight",
  "body-fat": "body-fat",
  "resting-hr": "resting-hr",
  height: "height",
  "head-circ": "head-circ",
};

// A body-metric detail page (#1067 Phase 2) — the per-metric surface reached from a
// Trends → Body sparkline tile, mirroring the biomarker series view (/biomarkers/view)
// that labs have always had but body metrics never did: a big chart with the shared
// range control + med/situation annotations + a goal overlay, trailing 7/30/90-day
// period stats, and (for a manually-enterable metric) that metric's single quick-add.
//
// The series is re-derived through the SAME queries the Body tab's chart stack uses
// (the biomarker-view precedent — a separate surface re-deriving via the shared query
// layer), then windowed here; the metadata (label/unit/color/goal/quick-add) comes
// from the ONE registry (BODY_METRIC_META) so this page and the tile can't disagree.

// Why a DERIVED metric shows no readings table: there is no row to edit. Said out
// loud on the page, because an empty table would read as "your data is missing"
// rather than "this number is computed from other numbers you CAN fix".
const DERIVED_READING_REASON: Partial<Record<BodyMetricSlug, string>> = {
  bmi: "BMI is computed from your weight and height — correct a reading on either of those to change it.",
  hr: "Daily average heart rate is computed from your recorded per-minute heart rate, so there is no single reading to edit here.",
  sun: "Outdoor daylight is computed from your logged outdoor sessions and the solar day at your home location — edit the session to change it.",
};

// The detail page's readings table rows: the metric's own store rows, formatted in
// the page's display unit. The ONE unit boundary is the same one the series crosses
// (weight in the login's preference); every other metric is stored in the unit it is
// charted in, so its value passes through rounded to the metric's decimals.
function readingRowsFor(
  slug: BodyMetricSlug,
  profileId: number,
  decimals: number,
  weightUnit: WeightUnit,
  // Same-identity observations folded in (#1996) — read-only here, see
  // MetricReadingRow.observed.
  observations: readonly Reading[] = []
): MetricReadingRow[] {
  const own = getMetricReadings(profileId, slug).flatMap((r) => {
    // Every row posts the PHYSICAL row it writes to (#2032). For this metric's own
    // rows that is the registry's answer; a metric with no store is derived and never
    // reaches here, so a missing target is a row we decline to offer actions on rather
    // than one we guess a store for.
    const target = metricReadingTarget(slug, r.id);
    if (!target) return [];
    const shown =
      slug === "weight"
        ? dispWeight(r.value, weightUnit)
        : // Calm is the stored `anxiety` rating on its #1313 display axis (high =
          // calm) — the SAME map the chart above and the check-in card apply, so the
          // table can't contradict the plot it explains. A second display boundary
          // beside weight's unit conversion, and the action converts back on write.
          slug === "calm"
          ? anxietyDisplaySlot(r.value)
          : round(r.value, decimals);
    return [
      {
        id: r.id,
        date: r.date,
        target: readingTargetToken(target),
        display: String(shown),
        editValue: shown,
        source: r.source,
        flag: r.flag,
        edited: r.edited,
        notes: r.notes,
      },
    ];
  });
  // The folded observations carry the identity's canonical unit, which for every
  // metric that folds is the unit this page charts in (see getMetricJudgment). Each one
  // names its OWN clinical record as its target, which is what makes it correctable
  // here instead of read-only (#2032 — the residual #1999 recorded).
  const folded: MetricReadingRow[] = observations.flatMap((r) => {
    const target = readingTarget(r);
    if (!target) return [];
    return [
      {
        id: r.rowId,
        date: r.date,
        target: readingTargetToken(target),
        display: String(round(r.value, decimals)),
        editValue: round(r.value, decimals),
        source: r.sourceKey,
        flag: r.provenance?.flag ?? null,
        edited: r.edited,
        notes: r.notes,
        observed: true,
      },
    ];
  });
  // Newest first, the order the table reads in; a clinic reading sits on its own
  // day rather than at the end of the list.
  return [...own, ...folded].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id - a.id
  );
}

// The goal overlay (target line + projection caption) for a metric that can carry a
// body-metric goal — the SAME shape the Body tab draws (projectGoal + describeEta).
function goalOverlay(
  profileId: number,
  goalMetric: BodyMetricKind,
  data: { date: string; value: number }[],
  unit: string,
  decimals: number,
  weightUnit: WeightUnit
): Pick<BodyChartSpec, "referenceValue" | "projectionNote"> {
  const goal: Goal | undefined = getGoals(profileId).find(
    (g) =>
      g.body_metric === goalMetric && isGoalLive(g) && g.target_value != null
  );
  if (!goal || goal.target_value == null) {
    return { referenceValue: null, projectionNote: null };
  }
  const toDisplay = (v: number) =>
    goalMetric === "weight" ? dispWeight(v, weightUnit) : round(v, decimals);
  const target = toDisplay(goal.target_value);
  const baseline =
    goal.baseline_value == null ? null : toDisplay(goal.baseline_value);
  const projection = projectGoal(data, target, goal.target_date, baseline);
  let projectionNote: string | null = null;
  if (projection?.status === "away") {
    projectionNote = `Currently trending away from your ${round(target, decimals)}${unit} goal.`;
  } else if (projection?.status === "reaching") {
    const reach = `At current pace you reach ${round(target, decimals)}${unit}`;
    projectionNote =
      projection.daysEarly != null
        ? `${reach} ${describeEta(projection.daysEarly)}.`
        : `${reach} around ${projection.projectedDate}.`;
  }
  if (projectionNote && projection?.confidence === "low") {
    projectionNote += " (rough estimate)";
  }
  return {
    referenceValue: {
      value: target,
      label: `Goal ${round(target, decimals)}${unit}`,
    },
    projectionNote,
  };
}

export default async function BodyMetricDetailPage(props: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{
    from?: string | string[];
    to?: string | string[];
    // The explicit all-time sentinel (#1485 G) — see resolveTrendsRange.
    range?: string | string[];
  }>;
}) {
  const { kind } = await props.params;
  const searchParams = await props.searchParams;

  if (!isBodyMetricSlug(kind)) {
    return (
      <PageContainer width="reading" className="space-y-4">
        <BackLink />
        <PageHeader title="Metric" />
        <EmptyState message="Unknown metric." />
      </PageContainer>
    );
  }

  const { login, profile } = await requireSession();

  // Calm carries the check-in card's own relevance gate (#1313/#1408). A profile the
  // scale was never offered to has no Calm surface AT ALL — not an empty one — so a
  // typed or shared `/trends/metric/calm` reads exactly like any unknown metric. The
  // copy deliberately names nothing: the scale simply appears or doesn't, and this
  // page may no more explain its absence than the card may.
  if (kind === "calm" && !isAnxietyScaleRelevant(profile.id)) {
    return (
      <PageContainer width="reading" className="space-y-4">
        <BackLink />
        <PageHeader title="Metric" />
        <EmptyState message="Unknown metric." />
      </PageContainer>
    );
  }

  const meta = BODY_METRIC_META[kind];
  const weightUnit = getUnitPrefs(login.id).weightUnit;
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const unit = resolveBodyMetricUnit(meta, weightUnit);
  const todayStr = today(profile.id);
  const savedMetricId = savedMetricIdForBodySlug(kind);
  const starred = isItemSaved(profile.id, "trend-metric", savedMetricId);
  const starAction = (
    <StarButton
      itemKey={metricSeriesKey(savedMetricId)}
      saved={starred}
      label={meta.title}
      iconOnlyBelowSm
    />
  );

  const from = timelineDateFromParam(searchParams.from);
  const to = timelineDateFromParam(searchParams.to);
  // Same window rule as the hub (#1485 G): 90D by default, an explicit ?from/?to
  // verbatim, `?range=all` for all time. This page is reached BY the hub's tiles,
  // so a different default here would silently rewind the window on every drill-in.
  const range = resolveTrendsRange(
    normalizeTimelineRange(from, to),
    todayStr,
    Array.isArray(searchParams.range)
      ? searchParams.range[0]
      : searchParams.range
  );

  // COMPLETENESS (#1996 part 2) THROUGH ONE FOLD (#2029). A metric's readings are
  // the ones of its IDENTITY, not the ones in its table: a clinic-measured resting
  // HR sits in `medical_records` and never reached the daily chart, because the
  // chart read `body_metrics`. The SERIES folds them in upstream
  // (lib/body-metric-series.ts, so the tile and this page cannot disagree) — and it
  // hands back WHICH observations it plotted, so the readings table below lists
  // exactly those. Reading the raw observations here instead is what let the chart
  // drop a same-day equal-value clinic reading while the table still listed it.
  // Empty for a metric whose readings already ARE observations, which would
  // otherwise list each one twice.
  const { points: fullSeries, observations } = bodyMetricSeriesFold(
    kind,
    profile.id,
    weightUnit,
    todayStr
  );
  const windowed = filterSeriesByRange(fullSeries, range);
  const stats = bodyMetricPeriodStats(fullSeries, todayStr, meta.decimals);
  const readings = readingRowsFor(
    kind,
    profile.id,
    meta.decimals,
    weightUnit,
    observations
  );
  const sourceComparisonKey = SOURCE_COMPARISON_KEY[kind];
  const birthdate = getUserBirthdate(profile.id);
  const ageMonths = birthdate
    ? ageInMonthsFromBirthdate(birthdate, todayStr)
    : null;
  const age = getUserAge(profile.id);
  const entryGates = {
    showBodyFat: showBodyFat(age),
    showGrowth: showGrowthQuickAdd(age),
    showHeadCirc: showHeadCircEntry(ageMonths),
  };
  const measurementEntryMetric = MEASUREMENT_ENTRY_METRIC[kind];
  const measurementEntry =
    measurementEntryMetric &&
    isMeasurementEntryAllowed(measurementEntryMetric, entryGates)
      ? {
          metric: measurementEntryMetric,
          label: meta.summaryTitle ?? meta.title,
        }
      : undefined;

  // Goal overlay + event annotations, both windowed to the shared range — the same
  // machinery the Body tab draws (buildTrendAnnotations / buildProtocolTrendWindows).
  const overlay = meta.goalMetric
    ? goalOverlay(
        profile.id,
        meta.goalMetric,
        windowed,
        unit,
        meta.decimals,
        weightUnit
      )
    : { referenceValue: null, projectionNote: null };
  const annotations = buildTrendAnnotations(profile.id, range);
  const protocolWindows = buildProtocolTrendWindows(profile.id, range);

  const chartSpec: BodyChartSpec = {
    key: meta.slug,
    detailHref: null, // detail-none: this page IS the detail — a card here would link to itself
    title: meta.title,
    // The page's <h1> already says it — a card heading here is pure echo (#1541).
    hideTitle: true,
    data: windowed,
    unit,
    color: meta.color,
    referenceValue: overlay.referenceValue,
    projectionNote: overlay.projectionNote,
    // What the plot ACTUALLY covers, whenever the selected window is wider than the
    // series — the reconciliation between a lit "90D" pill and a week-wide axis.
    note: seriesCoverageNote(windowed, range),
    ...bodyChartScale(meta),
  };

  const latest =
    fullSeries.length > 0 ? fullSeries[fullSeries.length - 1] : null;

  // Context that travels with a CONTINUOUS VITAL (#1932). These metrics are
  // `medical_records` readings under a canonical name — the same rows the reading
  // detail page charts for every episodic marker — so the two clinical companions
  // that page carried for them come along to the surface they now render on,
  // rather than being lost in the move or re-implemented here:
  //   • the pediatric BP percentile + AAP category (#150), which is how a CHILD's
  //     blood pressure must be judged (adult cutoffs call an elevated child fine);
  //   • the panel cross-reference (#1502) — an SpO2 arrived with a blood pressure
  //     and a respiratory rate, and each chip lands on ITS own cadence's surface.
  // Null for every other kind: a body_metrics or metric_samples series has no
  // canonical name, no panel, and no pediatric BP interpretation.
  const vitalCanonical =
    METRIC_READING_STORE[kind]?.table === "medical_records"
      ? METRIC_READING_STORE[kind].canonical
      : null;
  const panelSiblings = vitalCanonical
    ? getPanelSiblings(profile.id, vitalCanonical)
    : null;
  const bpCtx = vitalCanonical
    ? pediatricBpContextFor(
        profile.id,
        vitalCanonical,
        latest?.value ?? null,
        latest?.date ?? null
      )
    : null;
  // THE JUDGEMENT (#1996 part 1). One lookup, keyed by the reading's #482
  // identity, so the curated bands reach this surface whichever store its
  // readings stream into — the fix for a child's daily resting-heart-rate trend
  // being charted against nothing. Suppressed when the pediatric BP card is
  // showing: that IS the judgement for a child's blood pressure (#150), and an
  // adult reference band beside it would be a second, wrong answer.
  // Only when there is a reading to judge: a band above an empty chart is clinical
  // noise about a measurement this profile does not take.
  const judgment =
    bpCtx || latest == null
      ? null
      : getMetricJudgment(profile.id, kind, latest.value, latest.date);
  const latestDisplay =
    latest == null
      ? null
      : meta.countMetric
        ? groupChartValue(latest.value, meta.decimals)
        : String(round(latest.value, meta.decimals));

  const base = `/trends/metric/${kind}`;
  const rangeHref = (r: DateRange): AppRoute => {
    const sp = new URLSearchParams();
    if (r.from) sp.set("from", r.from);
    if (r.to) sp.set("to", r.to);
    // The control asks for `{}` for both "All time" and "Clear dates"; with a 90D
    // default that URL is no longer all-time, so it needs the explicit sentinel.
    if (isAllTimeRange(r)) sp.set(ALL_TIME_RANGE_PARAM, ALL_TIME_RANGE_VALUE);
    const qs = sp.toString();
    return (qs ? `${base}?${qs}` : base) as AppRoute;
  };

  const latestSummary =
    latest != null && latestDisplay != null ? (
      <div>
        <div
          className="text-3xl font-bold leading-none tabular-nums text-slate-900 md:text-4xl dark:text-slate-100"
          data-testid="metric-latest-value"
        >
          {latestDisplay}
          {unit}
        </div>
        <div className="mt-1 text-xs font-normal text-slate-500 dark:text-slate-400">
          Latest ·{" "}
          <span className="sm:hidden">
            {formatMonthDay(latest.date, formatPrefs)}
          </span>
          <span className="hidden sm:inline">
            {formatLongDate(latest.date, formatPrefs)}
          </span>
        </div>
      </div>
    ) : (
      "No readings yet"
    );

  return (
    <TrendAnnotationProvider>
      <PageContainer
        width="wide"
        className="mx-auto space-y-4 md:space-y-6"
        data-testid="metric-detail-page"
      >
        {meta.quickAdd === "measurements" && measurementEntry ? (
          <MetricMeasurementPanel
            metric={measurementEntry.metric}
            label={measurementEntry.label}
            title={meta.title}
            subtitle={latestSummary}
            leading={<BackLink />}
            headerAction={starAction}
            weightUnit={weightUnit}
            defaultDate={todayStr}
            temperatureUnit={getUnitPrefs(login.id).temperatureUnit}
            showBodyFat={entryGates.showBodyFat}
            showGrowth={entryGates.showGrowth}
            showHeadCirc={entryGates.showHeadCirc}
          />
        ) : (
          <div className="flex min-w-0 items-start gap-2 sm:block">
            <BackLink />
            <PageHeader
              className="!mb-0 min-w-0 flex-1 sm:mt-3"
              title={meta.title}
              subtitle={latestSummary}
              action={starAction}
              actionAlign="start"
            />
          </div>
        )}

        {/* Pediatric BP percentile + AAP category (#150) — child BP readings only,
            shown INSTEAD OF the adult thresholds; hidden for adults and for every
            metric that is not blood pressure. */}
        <PediatricBpCard ctx={bpCtx} />

        {/* The band this trend is read against (#1996) — resolved through the
            reading's identity, so it reaches a metric whose readings stream into
            body_metrics as readily as one stored as observations. */}
        <MetricJudgmentCard judgment={judgment} unit={unit} />

        {/* The SAME shared range + event-control composition as the Trends hub.
            BodyTrendCharts registers the annotation kinds it actually draws; the
            provider hoists their controls into DateRangeControl's companion slot
            instead of rendering a second row above the chart. */}
        <DateRangeControl
          basePath={base}
          range={range}
          todayStr={todayStr}
          buildHref={rangeHref}
          idPrefix="metric"
          // Summary chip only for a CUSTOM window — with a preset pill lit it just
          // repeats that pill's label (#1455 D).
          rightSlot={
            isCustomRange(range, todayStr) ? (
              <span className="whitespace-nowrap rounded-full border border-black/10 bg-white/60 px-3 py-1 text-slate-500 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-400">
                {rangeSummaryLabel(range, todayStr)}
              </span>
            ) : undefined
          }
          companionSlot={<TrendAnnotationControls />}
        />

        <div className="grid items-start gap-4 md:gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(22rem,2fr)]">
          {/* The chart owns the primary desktop column. BodyTrendCharts normally
            lays overview cards out two-up; this detail page explicitly keeps its
            one chart full-width so there is never an empty sibling column. */}
          {/* The plotted point count, exposed so the readings table below can be
            held to the SAME fold in a browser test (#2029). */}
          <div data-testid="metric-detail-chart" data-points={windowed.length}>
            {windowed.length === 0 ? (
              <div className="card">
                <EmptyState message="No readings in this range." />
              </div>
            ) : (
              <BodyTrendCharts
                charts={[chartSpec]}
                annotations={annotations}
                windows={protocolWindows}
                singleColumn
              />
            )}
          </div>

          {/* Secondary context follows the chart on a phone and becomes its compact
            companion at wide desktop sizes. These windows remain relative to
            today and independent of the selected chart range. */}
          <PeriodStatsCard
            stats={stats}
            unit={unit}
            decimals={meta.decimals}
            formatPrefs={formatPrefs}
            desktopSidebar
          />
        </div>

        {/* "Part of your Vital signs panel · also measured …" (#1502/#1932): the
            cross-reference across the cadence split, so a vital's page still says
            what it arrived with. */}
        {panelSiblings && (
          <PanelSiblingsCard
            panelId={panelSiblings.panelId}
            names={panelSiblings.names}
          />
        )}

        {sourceComparisonKey && (
          <SourceComparison
            profileId={profile.id}
            weightUnit={weightUnit}
            metricKey={sourceComparisonKey}
            range={range}
          />
        )}

        {/* The readings themselves, one tap from the chart they shape (#1488 /
          #1397): each row's ⋯ menu edits or deletes it, and the chart above
          redraws. */}
        <MetricReadingsTable
          kind={kind}
          rows={readings}
          unit={unit}
          readOnlyReason={
            METRIC_READING_STORE[kind]
              ? null
              : (DERIVED_READING_REASON[kind] ?? null)
          }
          truncated={readings.length >= METRIC_READINGS_LIMIT}
        />
      </PageContainer>
    </TrendAnnotationProvider>
  );
}

function BackLink() {
  return (
    <Link
      href="/trends#body"
      aria-label="Back to Body"
      className="mt-0.5 inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-1 text-sm text-brand-700 hover:bg-brand-50 hover:no-underline sm:px-2 dark:text-brand-400 dark:hover:bg-brand-950/40"
    >
      <IconArrowLeft className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">Back to Body</span>
    </Link>
  );
}

// One column per window from `sm` up — but only as many columns as there are
// cards, so a collapsed single card fills the card instead of sitting in a third
// of it. Below `sm` the windows STACK (#1541 fix 2): at 390px a hard `grid-cols-3`
// leaves 76px of content per cell against a `Range` row needing ~110px, so the
// value broke mid-range onto a second line — by arithmetic, not by accident. Four
// windows (the #1938 365d column) wrap into a 2×2 grid for the same reason: four
// abreast at 640px is back under that arithmetic's floor.
const PERIOD_COLS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2",
};

// How many `sm` columns the grid above resolves to — the input the per-item
// borders need (divide-x/divide-y utilities assume one row or one column, which a
// 2×2 grid is neither, so each cell draws its own edges instead).
function periodGridCols(statCount: number): number {
  return statCount === 4 ? 2 : Math.max(1, statCount);
}

// The separators between period cells, per cell: a top rule in the phone stack, a
// left rule between `sm` row neighbours plus a top rule for the second 2×2 row,
// and (in the desktop sidebar) back to top rules only when `xl` restacks to one
// column.
function periodItemBorders(
  index: number,
  cols: number,
  desktopSidebar: boolean
): string {
  if (index === 0) return "";
  const out = ["border-black/10", "dark:border-white/10", "border-t"];
  const startsRow = index % cols === 0;
  if (!startsRow) out.push("sm:border-l");
  if (index < cols) out.push("sm:border-t-0");
  if (desktopSidebar) {
    if (!startsRow) out.push("xl:border-l-0");
    if (index < cols) out.push("xl:border-t");
  }
  return out.join(" ");
}

function PeriodStatsCard({
  stats,
  unit,
  decimals,
  formatPrefs,
  desktopSidebar = false,
}: {
  stats: PeriodStat[];
  unit: string;
  decimals: number;
  formatPrefs: DisplayFormatPrefs;
  desktopSidebar?: boolean;
}) {
  const value = (v: number | null) =>
    v == null ? "—" : groupChartValue(v, decimals);
  const withUnit = (v: number | null) =>
    v == null ? "—" : `${value(v)}${unit}`;
  const windowLabel = (s: PeriodStat) =>
    s.windows.length === 1
      ? `${s.days} days`
      : `${s.windows[0]}–${s.days} days`;
  const coverage = (s: PeriodStat) =>
    s.from && s.to
      ? `${formatMonthDay(s.from, formatPrefs)}${
          s.from === s.to ? "" : `–${formatMonthDay(s.to, formatPrefs)}`
        }`
      : null;
  // Day one (#1909's follow-up): the profile's only reading is today's, so every
  // window carries the shared helper's fallback and the card shows THAT reading
  // rather than "No readings". The note must not claim "through yesterday" while
  // it is doing so — the coverage sentence changes with the number it describes.
  const dayOne = stats.length > 0 && stats.every((s) => s.dayOne);

  return (
    <section
      className="card overflow-hidden !p-0"
      data-testid="metric-period-stats"
      aria-labelledby="metric-period-stats-heading"
    >
      <div className="border-b border-black/10 bg-slate-50/55 px-4 py-3.5 sm:px-5 dark:border-white/10 dark:bg-ink-900/35">
        <h2
          id="metric-period-stats-heading"
          className="font-semibold text-slate-800 dark:text-slate-100"
        >
          Rolling summary
        </h2>
        {/* The exclusion made visible (#1909). These windows end YESTERDAY —
          today is not history until it ends, and a half-finished day used to
          drag a cumulative metric's average down all afternoon. Latest is the
          one figure that still carries today, so the note names both. */}
        <p
          className="mt-0.5 text-xs text-slate-500 dark:text-slate-400"
          data-testid="metric-period-coverage"
        >
          {dayOne ? (
            <>
              This is your first reading, so there is no completed day to
              average yet — the figure below is today&rsquo;s reading. Rolling
              7, 30, 90, and 365-day averages start once a day is complete.
            </>
          ) : (
            <>
              Rolling 7, 30, 90, and 365-day windows through yesterday —
              complete days only. Average, range, and change cover those days;
              Latest is the most recent reading, including today&rsquo;s.
            </>
          )}
        </p>
      </div>
      <div
        className={`grid grid-cols-1 ${
          desktopSidebar
            ? `xl:grid-cols-1 ${PERIOD_COLS[stats.length] ?? "sm:grid-cols-3"}`
            : (PERIOD_COLS[stats.length] ?? "sm:grid-cols-3")
        }`}
      >
        {stats.map((s, i) => (
          <article
            key={s.label}
            data-testid={`period-stat-${s.days}`}
            className={`min-w-0 px-4 py-4 sm:px-5 ${periodItemBorders(
              i,
              periodGridCols(stats.length),
              desktopSidebar
            )}`}
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <span className="inline-flex rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:bg-brand-950/70 dark:text-brand-300">
                {windowLabel(s)}
              </span>
              <span
                data-testid={`period-readings-${s.days}`}
                className="min-w-0 text-right text-xs leading-5 text-slate-500 dark:text-slate-400"
              >
                {s.count === 0
                  ? "No readings"
                  : `${s.count} reading${s.count === 1 ? "" : "s"}${
                      coverage(s) ? ` · ${coverage(s)}` : ""
                    }`}
              </span>
            </div>

            {s.count === 0 ? (
              <p className="mt-5 text-sm text-slate-500 dark:text-slate-400">
                Add a reading from a completed day to see an average, range, and
                change.
              </p>
            ) : s.dayOne ? (
              /* Day one: the figure is TODAY's reading, not an average, so it
                 carries its own label and its own test id — an average and a
                 single in-progress reading must never be addressable as the
                 same thing. Range and Change are omitted: over one reading they
                 are v–v and +0, which reads as information and is not. */
              <div className="mt-4">
                <div
                  data-testid={`period-today-reading-${s.days}`}
                  className="text-3xl font-semibold leading-none tracking-tight tabular-nums text-slate-900 xl:text-2xl dark:text-slate-100"
                >
                  {withUnit(s.avg)}
                </div>
                <div className="mt-1 section-label">Today&rsquo;s reading</div>
              </div>
            ) : (
              <div
                className={
                  desktopSidebar
                    ? "xl:mt-4 xl:flex xl:items-end xl:gap-4"
                    : undefined
                }
              >
                <div className="mt-4 xl:mt-0 xl:shrink-0">
                  <div
                    data-testid={`period-average-${s.days}`}
                    className="text-3xl font-semibold leading-none tracking-tight tabular-nums text-slate-900 xl:text-2xl dark:text-slate-100"
                  >
                    {withUnit(s.avg)}
                  </div>
                  <div className="mt-1 section-label">Average</div>
                </div>

                <dl className="mt-4 grid min-w-0 flex-1 grid-cols-3 divide-x divide-black/10 rounded-lg bg-slate-50/80 py-2.5 xl:mt-0 dark:divide-white/10 dark:bg-ink-900/55">
                  <div className="min-w-0 px-2.5">
                    <dt className="section-label">Latest</dt>
                    <dd className="mt-0.5 whitespace-nowrap text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                      {value(s.latest)}
                    </dd>
                  </div>
                  <div className="min-w-0 px-2.5">
                    <dt className="section-label">Range</dt>
                    <dd className="mt-0.5 whitespace-nowrap text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                      {value(s.min)}–{value(s.max)}
                    </dd>
                  </div>
                  <div className="min-w-0 px-2.5">
                    <dt className="section-label">Change</dt>
                    <dd className="mt-0.5 whitespace-nowrap text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                      {s.delta != null && s.delta > 0 ? "+" : ""}
                      {value(s.delta)}
                    </dd>
                  </div>
                </dl>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

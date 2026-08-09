import {
  IconHeartbeat,
  IconArrowUpRight,
  IconArrowDownRight,
  IconMinus,
} from "@tabler/icons-react";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import LogReadingButton from "@/components/dashboard/LogReadingButton";
import type { TrendDirection } from "@/lib/latest-trend";
import {
  VITAL_PRESENTATION_FLOORS,
  type VitalQuantity,
  type VitalsLatestModel,
} from "@/lib/vitals-latest";
import type { FreshnessState } from "@/lib/freshness";
import { formatRelativeDate } from "@/lib/format-date";

// The prepared model the page builds from the SAME series queries behind Trends →
// Vitals (getBiomarkerSeries for BP, getBodyMetricDailySeries for resting HR), reduced
// through the shared latestTrend helper and the per-quantity presentation floor
// (lib/vitals-latest, #221). Re-exported here so existing import sites are unchanged.
export type { VitalsLatestModel };

function DirArrow({
  direction,
  label,
}: {
  direction: TrendDirection | null;
  label: string;
}) {
  if (!direction) return null;
  const Icon =
    direction === "up"
      ? IconArrowUpRight
      : direction === "down"
        ? IconArrowDownRight
        : IconMinus;
  const word =
    direction === "up" ? "up" : direction === "down" ? "down" : "flat";
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-slate-500 dark:text-slate-400">
      <Icon className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />
      <span className="sr-only">{`${word} versus previous ${label}. `}</span>
    </span>
  );
}

// The row's provenance line. A `due` reading keeps its value at full prominence above
// and states its AGE here instead of a raw ISO date — "2022-03-08" does not read as
// "four years ago" at a glance, which is how half this card came to look like a
// snapshot of "my vitals now" (#2303). Amber plus an explaining `title`, the same
// treatment #1216 established on Recent labs, so the two glance cards speak one visual
// language for one meaning. `not-applicable` (no knowable age) states the date plainly
// and claims nothing either way.
function ProvenanceLine({
  label,
  quantity,
  date,
  freshness,
  today,
  testId,
}: {
  label: string;
  quantity: VitalQuantity;
  date: string;
  freshness: FreshnessState;
  today: string;
  testId: string;
}) {
  const stale = freshness === "due";
  return (
    <div className="text-xs text-slate-500 dark:text-slate-400">
      {label} ·{" "}
      <span
        data-testid={testId}
        data-stale={stale ? "true" : undefined}
        title={
          stale
            ? `Older than ${VITAL_PRESENTATION_FLOORS[quantity].label} — still your latest reading, but not a current one`
            : undefined
        }
        className={
          stale ? "font-medium text-amber-600 dark:text-amber-400" : undefined
        }
      >
        {stale ? formatRelativeDate(date, today) : date}
      </span>
    </div>
  );
}

// Dashboard "Latest vitals" tile (issue #1221): the most recent blood pressure and
// resting heart rate, each with a trend arrow vs the prior reading — a thin FORMATTER
// over the prepared model above. Informational glance; the full trend lives on Trends
// → Vitals.
//
// The header stays "Latest vitals" whatever the rows' ages, and no row is ever hidden:
// *latest* is a fact about the data, *current* is the claim #2303 removed. A card whose
// rows are all stale still renders — with the "Log reading" action now pointing at the
// obvious next move.
//
// The "Log reading" action (#1892) is in the NON-EMPTY state on purpose. The card used
// to offer logging only while the domain was empty, which inverted who got the
// affordance: the weekly BP logger — the person who actually opens this card — had
// none, while the person who had never logged got one. It opens the same shared
// measurements quick-entry the empty CTA opens; no second form, no second write path.
export default function VitalsLatestWidget({
  model,
  today,
}: {
  model: VitalsLatestModel;
  // The PROFILE-local day the ages are measured against — required, so the server's
  // local day can never age a profile's reading (#1186, as RecentLabsWidget takes it).
  today: string;
}) {
  const { bp, restingHr } = model;
  return (
    <div className="card" data-testid="vitals-latest-widget">
      <WidgetHeader
        title="Latest vitals"
        href="/trends#body"
        action={<LogReadingButton />}
      />
      <div className="flex items-start gap-3">
        <IconHeartbeat
          className="mt-1 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400"
          stroke={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-2">
          {bp && (
            <div data-testid="vitals-latest-bp">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100">
                  {bp.systolic}/{bp.diastolic}
                </span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  mmHg
                </span>
                <DirArrow direction={bp.direction} label="blood pressure" />
              </div>
              <ProvenanceLine
                label="Blood pressure"
                quantity="blood-pressure"
                date={bp.date}
                freshness={bp.freshness}
                today={today}
                testId="vitals-latest-bp-age"
              />
            </div>
          )}
          {restingHr && (
            <div data-testid="vitals-latest-resting-hr">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-lg font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                  {restingHr.value}
                </span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  bpm resting
                </span>
                <DirArrow
                  direction={restingHr.direction}
                  label="resting heart rate"
                />
              </div>
              <ProvenanceLine
                label="Resting heart rate"
                quantity="resting-hr"
                date={restingHr.date}
                freshness={restingHr.freshness}
                today={today}
                testId="vitals-latest-resting-hr-age"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import type { DisplayFormatPrefs } from "@/lib/format-date";
import { formatMonthDay } from "@/lib/format-date";
import { chartBristolMarks } from "@/lib/chart-colors";
import {
  BRISTOL_PANEL_DAYS,
  BRISTOL_STOOL_TYPES,
  MAX_BRISTOL_TYPE,
  bristolStoolType,
  type BristolPanel as PanelModel,
} from "@/lib/bristol-stool";
import { SeriesPoint, SeriesSummary } from "@/components/SeriesAccess";

// The Bristol stool-form panel (issue #2785): a DISTRIBUTION and a per-day dot strip,
// never an averaged line.
//
// WHY THE MARK IS THIS. A Bristol series is categorical-ordinal, so the two questions
// it can honestly answer are "which types, how often" and "which type, which day" —
// both of them counts and positions, neither of them a mean. A sparkline of daily
// averages answers a third question nobody asked and answers it wrongly: type 1 in the
// morning and type 7 at night average to 4, the middle of the scale, so the one week
// that most needs to be visible renders as textbook-normal. The panel model
// (lib/bristol-stool.ts) carries no mean for this component to reach for.
//
// GAP SEMANTICS, declared like every series. A day with no reading is a HOLE, not a
// zero and not a carried-forward value: it renders as a neutral hairline occupying its
// own calendar position (#2258), visibly different from a day that was logged.
//
// NO VERDICT. There is no good type and no bad one on this surface — no color coding by
// type, no "type 6-7 runs alongside your illness episode", no finding, no send. #2785
// ships a recording surface, and any observation about what a run of types means is a
// later decision under the findings doctrine.
//
// A pure formatter, server-rendered with no client JS: each mark names its exact
// value and is the door to it (#4760).

// Where a type's dot sits in the strip's track: type 1 at the top, type 7 at the
// bottom, which is the scale's own direction (hard → liquid) and the direction its
// published chart is always drawn in.
function dotOffsetPercent(type: number): number {
  return ((type - 1) / (MAX_BRISTOL_TYPE - 1)) * 100;
}

function dayTitle(
  day: PanelModel["days"][number],
  formatPrefs: DisplayFormatPrefs
): string {
  const date = formatMonthDay(day.date, formatPrefs);
  if (day.types.length === 0) return `${date} · nothing logged`;
  const marks = day.types
    .map((t) => `type ${t} (${bristolStoolType(t)?.label ?? ""})`.trim())
    .join(", ");
  return `${date} · ${marks}`;
}

function distributionTitle(
  entry: PanelModel["distribution"][number],
  total: number
): string {
  const scale = BRISTOL_STOOL_TYPES.find((type) => type.type === entry.type)!;
  return `Type ${entry.type}, ${scale.description}: ${entry.count} of ${total}`;
}

export default function BristolStoolPanel({
  panel,
  formatPrefs,
}: {
  panel: PanelModel;
  formatPrefs: DisplayFormatPrefs;
}) {
  // Nothing recorded in the window: render nothing at all rather than an empty chart
  // with an exhortation under it (the fiber panel's rule, and the attention doctrine's).
  if (panel.total === 0) return null;

  return (
    <div
      data-testid="bristol-panel"
      className="border-t border-black/5 pt-5 dark:border-white/5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="section-label">Stool form</h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Last 4 weeks
        </span>
      </div>

      {/* The distribution: how often each type, over the window. */}
      <div
        className="mt-3 flex items-end gap-1"
        data-testid="bristol-distribution"
      >
        {panel.distribution.map((d) => {
          const label = distributionTitle(d, panel.total);
          return (
            <SeriesPoint
              key={d.type}
              data-testid={`bristol-bar-${d.type}`}
              data-count={d.count}
              label={label}
              className="relative flex min-w-0 flex-1 flex-col items-center gap-1"
            >
              <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                {d.count || ""}
              </span>
              <div className="flex h-12 w-full items-end">
                <div
                  className={`w-full rounded-sm ${d.count === 0 ? "bg-slate-200 dark:bg-slate-700" : chartBristolMarks.bar.class}`}
                  style={{
                    height:
                      d.count === 0
                        ? "1px"
                        : `${Math.max(6, Math.round((d.count / panel.maxCount) * 100))}%`,
                  }}
                />
              </div>
              <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                {d.type}
              </span>
            </SeriesPoint>
          );
        })}
      </div>

      {/* The strip: which type, which day. One column per calendar day. */}
      <div
        className="mt-4 flex items-stretch gap-px"
        data-testid="bristol-strip"
      >
        {panel.days.map((day) => {
          const label = dayTitle(day, formatPrefs);
          return (
            <SeriesPoint
              key={day.date}
              data-testid={`bristol-day-${day.date}`}
              data-types={day.types.join(",") || undefined}
              label={label}
              className="relative block min-w-0 flex-1"
              style={{ height: "3rem" }}
            >
              {day.types.length === 0 ? (
                // An honest hole: no reading that day, occupying its own position.
                <div className="absolute inset-x-0 top-1/2 h-px bg-slate-200 dark:bg-slate-700" />
              ) : (
                day.types.map((t, i) => (
                  <span
                    key={`${t}-${i}`}
                    className={`absolute left-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${chartBristolMarks.dot.class}`}
                    style={{ top: `${dotOffsetPercent(t)}%` }}
                  />
                ))
              )}
            </SeriesPoint>
          );
        })}
      </div>

      <SeriesSummary
        label="Stool form by type and by day"
        items={[
          ...panel.distribution.map((entry) =>
            distributionTitle(entry, panel.total)
          ),
          ...panel.days.map((day) => dayTitle(day, formatPrefs)),
        ]}
      />

      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {panel.total === 1
          ? `1 reading over ${BRISTOL_PANEL_DAYS} days`
          : `${panel.total} readings over ${BRISTOL_PANEL_DAYS} days`}
        {" · type 1 (hard) at the top, type 7 (liquid) at the bottom"}
      </p>
    </div>
  );
}

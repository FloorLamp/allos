import { notFound, redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import { accessForProfile, requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getUnitPrefs, getDisplayFormatPrefs } from "@/lib/settings";
import { getActivityDetailData } from "@/lib/training-activity-detail";
import { getWorkoutPresence } from "@/lib/queries/presence";
import DiscardDraftButton from "../DiscardDraftButton";
import {
  rideDetailHref,
  rideHeartRateSeries,
  rideZoneRows,
} from "@/lib/ride-detail";
import { ZONE_COLORS } from "@/lib/training-zones";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
import type { RideComparisonMetricKey } from "@/lib/ride-detail";
import { fmtDistance, fmtKmh } from "@/lib/units";
import { formatElapsed } from "@/lib/ride-detail";
import ActivityLedgerNav from "./ActivityLedgerNav";
import ActivityRecord from "../ActivityRecord";
import RideHeartRateChart from "../../rides/[id]/RideHeartRateChart";
import RideTelemetryChart from "../../rides/[id]/RideTelemetryChart";
import { RideChartLinkProvider } from "../../rides/[id]/RideChartLink";

export const dynamic = "force-dynamic";

// What each comparable metric is CALLED on a session that is not a ride. Power,
// weighted power and cadence stay off this list: they are cycling vocabulary,
// and a walk that somehow carries them is not helped by seeing them.
const COMPARISON_LABELS: Partial<Record<RideComparisonMetricKey, string>> = {
  speed: "Speed",
  heart_rate: "Heart rate",
  elevation: "Elevation",
  relative_effort: "Relative effort",
};

// One activity's canonical page (#2870 step 1): the record, at its own URL.
// The record IS the Training Log card — rendered whole (sets, statuses, notes,
// clips, provenance, fault warnings, the full menu with same-day merge
// targets), so every surface that used to anchor into the log list lands on a
// page that can do everything the card could. Heart rate renders LAST
// (owner-ruled: a strength record leads with the work; HR is its appendix),
// through the same window → minutes → zones pipeline the ride page uses.
// Cycling activities keep their bespoke ride page; this route redirects them.
export default async function TrainingActivityPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await props.params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const { login, profile } = await requireSession();
  if (isTrainingRestricted(profile.id)) redirect("/training");

  const units = getUnitPrefs(login.id);
  const data = getActivityDetailData(
    profile.id,
    id,
    units,
    getDisplayFormatPrefs(login.id)
  );
  if (!data) notFound();

  // Cycling keeps its dedicated performance page (#2566's convergence step
  // decides its future) — the canonical URL for a ride is the ride page.
  const ride = rideDetailHref(data.row);
  if (ride) redirect(ride);

  const card = data.card;
  const canWrite =
    accessForProfile(login.id, login.role, profile.id) === "write";

  // The session's live/draft state (#2870 step 3). While presence says THIS
  // activity is the running session, the page is the record-in-progress; a
  // zero-content row that is NOT running is a draft — this page is its only
  // address (the feed hides it), so it says so and offers the discard.
  const presence = getWorkoutPresence(profile.id);
  const liveActive =
    presence.state === "active" && presence.activityId === data.row.id;
  const heartRateSeries = rideHeartRateSeries(
    data.heartRate.window,
    data.heartRate.minutes
  );
  const zoneRows = data.heartRate.zoneMinutes
    ? rideZoneRows(data.heartRate.zoneMinutes)
    : [];
  const zoneTotal = zoneRows.reduce((sum, zone) => sum + zone.minutes, 0);
  // Name the interval the splits were actually cut at (#3009) — "1 km" for a
  // walk, "5 km" once one-per-unit would overflow the table.
  const splitUnits =
    data.telemetry.splitIntervalM /
    (units.distanceUnit === "mi" ? 1609.344 : 1000);
  const splitLabel = `${Math.round(splitUnits)} ${units.distanceUnit}`;
  // Peer comparison (#3009). Each metric renders its own value, the peers'
  // median, and the gap — a personal baseline, which for endurance beats any
  // published standard. Presentation is deliberately plain here; the ride page's
  // charted treatment stays its own until #2566's convergence step gives both
  // surfaces one.
  const comparisonRows = (data.comparison?.metrics ?? []).flatMap((metric) => {
    const label = COMPARISON_LABELS[metric.key];
    if (!label) return [];
    const render =
      metric.key === "speed"
        ? (value: number) => fmtKmh(value, units.distanceUnit)
        : metric.key === "elevation"
          ? (value: number) => `${Math.round(value)} m`
          : (value: number) => String(Math.round(value));
    return [
      {
        key: metric.key,
        label,
        current: render(metric.current),
        median: render(metric.median),
        // The sign is the story; the magnitude is rendered in the metric's own
        // units so "+0.4 km/h" never reads as "+0.4 bpm".
        difference: `${metric.difference > 0 ? "+" : metric.difference < 0 ? "−" : "±"}${render(Math.abs(metric.difference))}`,
        direction:
          metric.difference > 0
            ? "up"
            : metric.difference < 0
              ? "down"
              : "same",
      },
    ];
  });

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="training-activity-page"
    >
      {/* Back to the log, and ‹ older / newer › walking the ledger in
          (date, id) order so a review session continues without bouncing back
          to a list (#2870). All three answer their own tap (#2983). */}
      <ActivityLedgerNav olderId={data.olderId} newerId={data.newerId} />

      {liveActive ? (
        <p
          data-testid="session-in-progress"
          className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        >
          Workout in progress — this page is the session&rsquo;s record and
          fills in as you log.
        </p>
      ) : data.isDraft ? (
        <div
          data-testid="draft-banner"
          className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300"
        >
          <span>
            Draft — this workout was started but nothing was logged. It appears
            only here and expires on its own.
          </span>
          {canWrite && <DiscardDraftButton activityId={data.row.id} />}
        </div>
      ) : null}
      {/* Keyed by activity: ‹older/newer› must REMOUNT the record, so a docked
          edit of the previous activity closes (flushing its auto-save) instead
          of staying portaled under the new record it doesn't belong to. */}
      <ActivityRecord
        key={data.card.activity.id}
        card={data.card}
        siblings={data.siblings}
        units={units}
        canWrite={canWrite}
        partDeltas={data.partDeltas}
        overlapping={data.overlappingSiblings}
      />

      {/* Both charts share one crosshair, the way the ride page's do: the
          provider is what links them, and the hook is inert without it, so a
          page that grows a second chart opts in by mounting this. */}
      <RideChartLinkProvider>
        {data.telemetry.traces.length > 0 && (
          <div className="card mt-4" data-testid="activity-traces">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                Session traces
              </h3>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {card.provenance.label}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              What the recording device measured second by second. Pick a
              measure to see it across the session.
            </p>
            <div className="mt-4">
              <RideTelemetryChart traces={data.telemetry.traces} />
            </div>
          </div>
        )}

        {data.telemetry.splits.length > 0 && (
          <div className="card mt-4" data-testid="activity-splits">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                {splitLabel} splits
              </h3>
              {data.telemetry.decouplingPercent != null && (
                <span
                  data-testid="activity-decoupling"
                  title="Pace per heartbeat, second half against first"
                  className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
                >
                  {data.telemetry.decouplingPercent > 0
                    ? `${data.telemetry.decouplingPercent}% slower per beat late on`
                    : data.telemetry.decouplingPercent < 0
                      ? `${Math.abs(data.telemetry.decouplingPercent)}% faster per beat late on`
                      : "Even pace per beat throughout"}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Cut from the recorded distance, not from the totals.
            </p>
            <ResponsiveTable className="mt-4 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left text-xs font-medium text-slate-500 dark:border-white/10 dark:text-slate-400">
                  <th className="th">Split</th>
                  <th className="th text-right">Distance</th>
                  <th className="th text-right">Time</th>
                  <th className="th text-right">Speed</th>
                  <th className="th text-right">Heart rate</th>
                </tr>
              </thead>
              <tbody>
                {data.telemetry.splits.map((split) => (
                  <tr
                    key={split.index}
                    className="border-b border-black/5 last:border-0 dark:border-white/5"
                  >
                    <Td slot="title" className="py-2.5 pr-3 font-medium">
                      {split.index}
                    </Td>
                    <Td
                      slot="value"
                      label="Distance"
                      className="px-3 py-2.5 text-right tabular-nums"
                    >
                      {fmtDistance(split.distanceM / 1000, units.distanceUnit)}
                    </Td>
                    <Td
                      slot="meta"
                      label="Time"
                      className="px-3 py-2.5 text-right tabular-nums"
                    >
                      {formatElapsed(split.timeSec)}
                    </Td>
                    <Td
                      slot="meta"
                      label="Speed"
                      className="px-3 py-2.5 text-right tabular-nums"
                    >
                      {fmtKmh(split.averageSpeedKmh, units.distanceUnit)}
                    </Td>
                    <Td
                      slot="meta"
                      label="Heart rate"
                      className="px-3 py-2.5 text-right tabular-nums"
                    >
                      {split.averageHeartrate == null
                        ? "—"
                        : `${Math.round(split.averageHeartrate)} bpm`}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </div>
        )}

        {heartRateSeries.length > 0 && (
          // Not `activity-heart-rate`: the record card above already carries that
          // id on its summary's ♥ chip, and two of them on one page is the
          // hidden-twin trap (#2305) — a scoped read would get whichever came
          // first in the DOM, which is the 16px chip, not this block.
          <div className="card mt-4" data-testid="activity-hr-chart">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                Heart rate
              </h3>
              <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                {data.heartRate.minutes.length} recorded min
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              One-minute readings recorded during this session. A break in the
              line is a gap in wear.
            </p>
            <div className="mt-4">
              <RideHeartRateChart
                data={heartRateSeries}
                rideDate={data.row.date}
                zoneModel={data.heartRate.zoneModel}
              />
            </div>
            {zoneTotal > 0 && (
              <div className="mt-4" data-testid="activity-heart-rate-zones">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  Time in zones
                </h3>
                <div
                  className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800"
                  aria-hidden
                >
                  {zoneRows.map((zone, index) =>
                    zone.minutes > 0 ? (
                      <span
                        key={zone.id}
                        style={{
                          width: `${(zone.minutes / zoneTotal) * 100}%`,
                          backgroundColor: ZONE_COLORS[index],
                        }}
                      />
                    ) : null
                  )}
                </div>
                <ul className="mt-3 space-y-2">
                  {zoneRows.map((zone, index) => (
                    <li
                      key={zone.id}
                      data-testid={`activity-zone-${zone.id}`}
                      className="flex items-center justify-between gap-4 text-sm"
                    >
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: ZONE_COLORS[index] }}
                        />
                        <span className="font-medium text-slate-700 dark:text-slate-200">
                          {zone.name}
                        </span>
                        <span className="truncate text-slate-500 dark:text-slate-400">
                          {zone.label}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums text-slate-600 dark:text-slate-300">
                        {zone.minutes} min · {zone.percent}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </RideChartLinkProvider>

      {comparisonRows.length > 0 && data.comparison && (
        <div className="card mt-4" data-testid="activity-comparison">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">
              How this compares
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {data.comparison.rideCount} similar{" "}
              {data.comparison.rideCount === 1 ? "session" : "sessions"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Against the median of your own sessions of this kind, within{" "}
            {Math.round(data.comparison.tolerancePercent)}% of the same{" "}
            {data.comparison.basis === "distance" ? "distance" : "duration"}.
          </p>
          <ul className="mt-3 space-y-2">
            {comparisonRows.map((row) => (
              <li
                key={row.key}
                data-testid={`activity-comparison-${row.key.replace("_", "-")}`}
                className="flex items-baseline justify-between gap-4 text-sm"
              >
                <span className="text-slate-700 dark:text-slate-200">
                  {row.label}
                </span>
                <span className="flex items-baseline gap-2 tabular-nums">
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {row.current}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    median {row.median}
                  </span>
                  <span
                    className={`text-xs ${
                      row.direction === "up"
                        ? "text-brand-600 dark:text-brand-400"
                        : row.direction === "down"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-slate-500 dark:text-slate-400"
                    }`}
                  >
                    {row.difference}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* A session whose source answered with nothing says so (#3009). The page
          is allowed to be short — a hand-entered walk IS a total and a title —
          but it is not allowed to be silent about being short, which reads as
          something failing to load. Only stated when the source has actually
          answered: never asked is a different fact, and claiming otherwise
          would be a guess. */}
      {data.telemetry.answered &&
        data.telemetry.traces.length === 0 &&
        heartRateSeries.length === 0 && (
          <p
            data-testid="activity-totals-only"
            className="mt-4 text-sm text-slate-500 dark:text-slate-400"
          >
            {card.provenance.label} recorded totals for this session — no
            second-by-second detail, and no heart rate during it.
          </p>
        )}
    </PageContainer>
  );
}

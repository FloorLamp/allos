import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getUnitPrefs,
  getUserSex,
  getUserBirthdate,
  getUserAge,
} from "@/lib/settings";
import { ageInMonthsFromBirthdate } from "@/lib/date";
import {
  planBodyCharts,
  showGrowthQuickAdd,
  showHeadCircEntry,
  type BodyChartKey,
} from "@/lib/growth-metrics";
import {
  getWeights,
  getBodyMetricsWithSource,
  getMetricDailyTotals,
  getLatestMetricValue,
  getSleepStageDailyTotals,
  getHrDailySummary,
  getLatestHrDay,
  getHrMinutes,
  getGoals,
} from "@/lib/queries";
import { dispWeight, fmtWeight, round } from "@/lib/units";
import { buildGrowthProfile, displayWeightGrowth } from "@/lib/growth-series";
import { ALL_ROWS, filterSeriesByRange } from "@/lib/trends";
import { buildTrendAnnotations } from "@/lib/trends-series";
import { projectGoal, describeEta } from "@/lib/trend-projection";
import { formatLongDate } from "@/lib/format-date";
import type { BodyMetricKind, Goal } from "@/lib/types";
import type { DateRange } from "@/lib/timeline-format";
import { EmptyState } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import StackedBarCard from "@/components/StackedBarCard";
import ScrollFade from "@/components/ScrollFade";
import BodyTrendCharts, {
  type BodyChartSpec,
} from "@/components/BodyTrendCharts";
import GrowthChartsCard, {
  type GrowthMetricView,
} from "@/components/GrowthChartsCard";
import BodyQuickAdd from "./BodyQuickAdd";
import VitalsQuickAdd from "./VitalsQuickAdd";
import GrowthQuickAdd from "./GrowthQuickAdd";
import DeleteBodyMetricButton from "./DeleteBodyMetricButton";

// The Trends hub's Body section: the full Body Metrics surface (absorbed here in
// the sidebar consolidation — the standalone /body-metrics page was retired and
// redirects to /trends?tab=body). It carries the compact logging quick-add, the
// windowed weight / body-fat / resting-HR trend charts + goal overlays + growth
// card, the synced-from-integrations daily charts (steps, sleep, HR, body
// composition, intake), and the full history/provenance table with per-row
// delete. Weight respects the login's unit preference (dispWeight). Reuses the
// body-metrics queries/actions and the existing chart components; this tab is NOT
// age-gated, so every profile reaches it (matching the old page).
export default async function BodySection({ range }: { range: DateRange }) {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;

  // Read the whole series (ALL_ROWS overrides the default 365-row cap) so an
  // older window isn't silently truncated before filterSeriesByRange windows it.
  const weights = getWeights(profile.id, ALL_ROWS);
  const bodyMetrics = getBodyMetricsWithSource(profile.id, ALL_ROWS);

  const weightChart = filterSeriesByRange(
    weights
      .slice()
      .reverse()
      .map((w) => ({ date: w.date, value: dispWeight(w.weight_kg, wu) })),
    range
  );
  const bodyFatChart = filterSeriesByRange(
    bodyMetrics
      .filter((w) => w.body_fat_pct != null)
      .slice()
      .reverse()
      .map((w) => ({ date: w.date, value: round(w.body_fat_pct!, 1) })),
    range
  );
  const restingHrChart = filterSeriesByRange(
    bodyMetrics
      .filter((w) => w.resting_hr != null)
      .slice()
      .reverse()
      .map((w) => ({ date: w.date, value: Math.round(w.resting_hr!) })),
    range
  );

  // Age drives an age-aware Body-tab layout (kids growth trends): for a child,
  // HEIGHT is the priority datapoint and body fat % is not tracked, so the tab
  // charts height (and head circ for the very young), drops body fat, floats the
  // growth-percentile card to the top, and offers a height/head-circ quick-add.
  // Adults keep the original weight → body fat → resting-HR layout unchanged. The
  // decision is the pure lib/growth-metrics (planBodyCharts), shared with tests.
  const ageYears = getUserAge(profile.id);
  const birthdate = getUserBirthdate(profile.id);
  const ageMonths = birthdate
    ? ageInMonthsFromBirthdate(birthdate, today(profile.id))
    : null;
  const plan = planBodyCharts({ ageYears, ageMonths });

  // Height + head-circumference series (canonical cm, from metric_samples — the
  // same store the growth charts read). Charted on the Body tab for minors so a
  // height/head-circ history always surfaces even without the full growth card.
  const heightChart = filterSeriesByRange(
    getMetricDailyTotals(profile.id, "height_cm").map((r) => ({
      date: r.date,
      value: round(r.value, 1),
    })),
    range
  );
  const headCircChart = filterSeriesByRange(
    getMetricDailyTotals(profile.id, "head_circumference_cm").map((r) => ({
      date: r.date,
      value: round(r.value, 1),
    })),
    range
  );

  // Event annotations (medication start/stop, appointments, situation changes)
  // windowed to the shared range — the same set drives all three charts via the
  // one toggle bar. Reads only through profile-scoped queries (buildTrendAnnotations).
  const annotations = buildTrendAnnotations(profile.id, range);

  // Goal projection: for a body-metric goal with a target value +
  // target_date, draw the target line and extrapolate the windowed trend to it.
  // Weight targets are stored canonically (kg) → convert to the display unit so the
  // line and the projection math share the chart's unit. First active, non-archived
  // goal per metric wins (getGoals returns active-first).
  const goals = getGoals(profile.id);
  const goalFor = (metric: BodyMetricKind): Goal | undefined =>
    goals.find(
      (g) =>
        g.body_metric === metric &&
        g.status === "active" &&
        g.archived === 0 &&
        g.target_value != null
    );

  const goalOverlay = (
    metric: BodyMetricKind,
    data: { date: string; value: number }[],
    unit: string,
    decimals: number
  ): Pick<BodyChartSpec, "referenceValue" | "projectionNote"> => {
    const goal = goalFor(metric);
    if (!goal || goal.target_value == null) {
      return { referenceValue: null, projectionNote: null };
    }
    const toDisplay = (v: number) =>
      metric === "weight" ? dispWeight(v, wu) : round(v, decimals);
    const target = toDisplay(goal.target_value);
    const baseline =
      goal.baseline_value == null ? null : toDisplay(goal.baseline_value);
    const targetLabel = `Goal ${round(target, decimals)}${unit}`;
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
    // Hedge a shaky projection (few points / scattered trend) so the ETA doesn't
    // read as precise (#37).
    if (projectionNote && projection?.confidence === "low") {
      projectionNote += " (rough estimate)";
    }
    return {
      referenceValue: { value: target, label: targetLabel },
      projectionNote,
    };
  };

  // The full set of body-composition chart specs, keyed so the age-aware plan can
  // order/select them. For a minor, body fat is absent from plan.keys entirely.
  const chartByKey: Record<BodyChartKey, BodyChartSpec> = {
    height: {
      key: "height",
      title: "Height",
      data: heightChart,
      label: "Height",
      unit: " cm",
      color: "#2563eb",
    },
    head_circumference: {
      key: "head_circumference",
      title: "Head circumference",
      data: headCircChart,
      label: "Head circ.",
      unit: " cm",
      color: "#0891b2",
    },
    weight: {
      key: "weight",
      title: "Weight",
      data: weightChart,
      label: "Weight",
      unit: ` ${wu}`,
      color: "#16a34a",
      ...goalOverlay("weight", weightChart, ` ${wu}`, 1),
    },
    bodyfat: {
      key: "bodyfat",
      title: "Body fat",
      data: bodyFatChart,
      label: "Body fat",
      unit: "%",
      color: "#a855f7",
      ...goalOverlay("body_fat", bodyFatChart, "%", 1),
    },
    resting_hr: {
      key: "resting_hr",
      title: "Resting heart rate",
      data: restingHrChart,
      label: "Resting HR",
      unit: " bpm",
      color: "#fb923c",
      ...goalOverlay("resting_hr", restingHrChart, " bpm", 0),
    },
  };
  const charts: BodyChartSpec[] = plan.keys.map((k) => chartByKey[k]);

  // Pediatric growth percentiles — reuses the exact build the Body Metrics page
  // uses; returns null unless the profile has a known sex + birthdate and is in
  // chart range. Age-based, so it isn't windowed by the shared range.
  const growth = buildGrowthProfile({
    sex: getUserSex(profile.id),
    birthdate: getUserBirthdate(profile.id),
    today: today(profile.id),
    heights: getMetricDailyTotals(profile.id, "height_cm").map((r) => ({
      date: r.date,
      value: r.value,
    })),
    weights: weights.map((w) => ({ date: w.date, value: w.weight_kg })),
    headCircs: getMetricDailyTotals(profile.id, "head_circumference_cm").map(
      (r) => ({ date: r.date, value: r.value })
    ),
  });
  const growthMeta: Record<
    "height" | "weight" | "bmi" | "head_circumference",
    { label: string; unit: string; valueRound: number }
  > = {
    height: { label: "Height", unit: " cm", valueRound: 1 },
    // Weight's unit follows the login's weight preference — the plotted values
    // are converted at the display boundary below (displayWeightGrowth).
    weight: { label: "Weight", unit: ` ${wu}`, valueRound: 1 },
    bmi: { label: "BMI", unit: "", valueRound: 1 },
    head_circumference: { label: "Head circ.", unit: " cm", valueRound: 1 },
  };
  const growthViews: GrowthMetricView[] = growth
    ? growth.metrics
        .filter((m) => m.bands.length > 0 && m.points.length > 0)
        .map((m) => {
          // Percentiles stay computed in kg (correct); only the DISPLAYED plot +
          // label change for an lb-preference user. For weight, convert the
          // reference bands AND the trajectory points together so they stay
          // coherent (converting only the points would break the plot). Other
          // metrics (height / BMI / head circ) are unit-invariant here.
          const plot =
            m.metric === "weight"
              ? displayWeightGrowth(m, wu)
              : { bands: m.bands, points: m.points };
          return {
            metric: m.metric,
            ...growthMeta[m.metric],
            bands: plot.bands,
            points: plot.points,
            latestPercentile: m.latest?.percentile ?? null,
            minMonths: m.minMonths,
            maxMonths: m.maxMonths,
          };
        })
    : [];
  const growthSource = growth && growth.ageMonths < 24 ? "WHO" : "CDC";
  const growthCard =
    growth && growthViews.length > 0 ? (
      <GrowthChartsCard
        views={growthViews}
        currentAgeMonths={growth.ageMonths}
        source={growthSource}
      />
    ) : null;

  // Synced-from-integrations daily metrics (steps, sleep, body composition,
  // intake, heart rate). These show the full series (not windowed) — matching the
  // former standalone page — so an occasional sync isn't hidden by a short range.
  const stepsChart = getMetricDailyTotals(profile.id, "steps").map((r) => ({
    date: r.date,
    value: Math.round(r.value),
  }));
  const sleepChart = getMetricDailyTotals(profile.id, "sleep_min").map((r) => ({
    date: r.date,
    value: round(r.value / 60, 1), // minutes → hours
  }));
  const sleepStages = getSleepStageDailyTotals(profile.id).map((r) => ({
    date: r.date.slice(5),
    deep: round(r.deep / 60, 1),
    rem: round(r.rem / 60, 1),
    light: round(r.light / 60, 1),
    awake: round(r.awake / 60, 1),
  }));
  const leanMassChart = getMetricDailyTotals(profile.id, "lean_mass_kg").map(
    (r) => ({ date: r.date, value: round(r.value, 1) })
  );
  const boneMassChart = getMetricDailyTotals(profile.id, "bone_mass_kg").map(
    (r) => ({ date: r.date, value: round(r.value, 2) })
  );
  const bmrChart = getMetricDailyTotals(profile.id, "bmr_kcal").map((r) => ({
    date: r.date,
    value: Math.round(r.value),
  }));
  const hydrationChart = getMetricDailyTotals(profile.id, "hydration_l").map(
    (r) => ({ date: r.date, value: round(r.value, 2) })
  );
  const caloriesChart = getMetricDailyTotals(profile.id, "nutrition_kcal").map(
    (r) => ({ date: r.date, value: Math.round(r.value) })
  );
  const protein = new Map(
    getMetricDailyTotals(profile.id, "protein_g").map((r) => [r.date, r.value])
  );
  const carbs = new Map(
    getMetricDailyTotals(profile.id, "carbs_g").map((r) => [r.date, r.value])
  );
  const fat = new Map(
    getMetricDailyTotals(profile.id, "fat_g").map((r) => [r.date, r.value])
  );
  const macroDates = [
    ...new Set([...protein.keys(), ...carbs.keys(), ...fat.keys()]),
  ].sort();
  const macrosChart = macroDates.map((d) => ({
    date: d.slice(5),
    protein: round(protein.get(d) ?? 0, 0),
    carbs: round(carbs.get(d) ?? 0, 0),
    fat: round(fat.get(d) ?? 0, 0),
  }));
  // BMI over the weight series, using the most recently synced height.
  const heightCm = getLatestMetricValue(profile.id, "height_cm");
  const bmiChart =
    heightCm && heightCm > 0
      ? weights
          .slice()
          .reverse()
          .map((w) => ({
            date: w.date,
            value: round(w.weight_kg / (heightCm / 100) ** 2, 1),
          }))
      : [];
  const hrChart = getHrDailySummary(profile.id).map((r) => ({
    date: r.date,
    value: Math.round(r.avg),
  }));
  const latestHrDay = getLatestHrDay(profile.id);
  const hrIntraday = latestHrDay
    ? getHrMinutes(profile.id, latestHrDay).map((m) => ({
        date: m.ts.slice(11), // HH:MM
        value: round(m.bpm, 0),
      }))
    : [];
  const hasSynced =
    stepsChart.length > 0 ||
    sleepChart.length > 0 ||
    sleepStages.length > 0 ||
    hrChart.length > 0 ||
    leanMassChart.length > 0 ||
    boneMassChart.length > 0 ||
    bmrChart.length > 0 ||
    hydrationChart.length > 0 ||
    caloriesChart.length > 0 ||
    macrosChart.length > 0 ||
    bmiChart.length > 0;

  return (
    <div className="space-y-6">
      <BodyQuickAdd weightUnit={wu} defaultDate={today(profile.id)} />

      {showGrowthQuickAdd(ageYears) && (
        <GrowthQuickAdd
          defaultDate={today(profile.id)}
          showHeadCirc={showHeadCircEntry(ageMonths)}
        />
      )}

      <VitalsQuickAdd defaultDate={today(profile.id)} />

      <p className="text-sm text-slate-500 dark:text-slate-400">
        Body-composition trends over the selected window.
      </p>

      {/* For a child the growth-percentile card is the headline, so it floats
          above the body-composition charts (plan.growthCardFirst); adults keep
          it below, unchanged. */}
      {plan.growthCardFirst && growthCard}

      <BodyTrendCharts charts={charts} annotations={annotations} />

      {!plan.growthCardFirst && growthCard}

      {hasSynced && (
        <div className="grid gap-6 lg:grid-cols-2">
          {stepsChart.length > 0 && (
            <div className="card">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Steps per day
              </h2>
              <LineChartCard data={stepsChart} label="Steps" color="#0ea5e9" />
            </div>
          )}
          {sleepChart.length > 0 && (
            <div className="card">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Sleep per night
              </h2>
              <LineChartCard
                data={sleepChart}
                label="Sleep"
                color="#6366f1"
                unit=" h"
              />
            </div>
          )}
          {sleepStages.length > 0 && (
            <div className="card lg:col-span-2">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Sleep stages
              </h2>
              <StackedBarCard
                data={sleepStages}
                unit=" h"
                series={[
                  { key: "deep", label: "Deep", color: "#4f46e5" },
                  { key: "rem", label: "REM", color: "#a855f7" },
                  { key: "light", label: "Light", color: "#38bdf8" },
                  { key: "awake", label: "Awake", color: "#f59e0b" },
                ]}
              />
            </div>
          )}
          {hrChart.length > 0 && (
            <div className="card">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Heart rate (daily avg)
              </h2>
              <LineChartCard
                data={hrChart}
                label="Avg HR"
                color="#f43f5e"
                unit=" bpm"
              />
            </div>
          )}
          {hrIntraday.length > 0 && (
            <div className="card lg:col-span-2">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Heart rate over the day{latestHrDay ? ` — ${latestHrDay}` : ""}
              </h2>
              <LineChartCard
                data={hrIntraday}
                label="HR"
                color="#f43f5e"
                unit=" bpm"
                showDots={false}
              />
            </div>
          )}
          {bmiChart.length > 0 && (
            <div className="card">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                BMI{heightCm ? ` (height ${round(heightCm, 0)} cm)` : ""}
              </h2>
              <LineChartCard data={bmiChart} label="BMI" color="#14b8a6" />
            </div>
          )}
          {leanMassChart.length > 0 && (
            <div className="card">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Lean body mass
              </h2>
              <LineChartCard
                data={leanMassChart}
                label="Lean mass"
                color="#10b981"
                unit=" kg"
              />
            </div>
          )}
          {boneMassChart.length > 0 && (
            <div className="card">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Bone mass
              </h2>
              <LineChartCard
                data={boneMassChart}
                label="Bone mass"
                color="#64748b"
                unit=" kg"
              />
            </div>
          )}
          {bmrChart.length > 0 && (
            <div className="card">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Basal metabolic rate
              </h2>
              <LineChartCard
                data={bmrChart}
                label="BMR"
                color="#ef4444"
                unit=" kcal"
              />
            </div>
          )}
          {hydrationChart.length > 0 && (
            <div className="card">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Hydration
              </h2>
              <LineChartCard
                data={hydrationChart}
                label="Water"
                color="#06b6d4"
                unit=" L"
              />
            </div>
          )}
          {caloriesChart.length > 0 && (
            <div className="card">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Calories (intake)
              </h2>
              <LineChartCard
                data={caloriesChart}
                label="Calories"
                color="#f97316"
                unit=" kcal"
              />
            </div>
          )}
          {macrosChart.length > 0 && (
            <div className="card lg:col-span-2">
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Macros (protein / carbs / fat)
              </h2>
              <StackedBarCard
                data={macrosChart}
                unit=" g"
                series={[
                  { key: "protein", label: "Protein", color: "#6366f1" },
                  { key: "carbs", label: "Carbs", color: "#f59e0b" },
                  { key: "fat", label: "Fat", color: "#ef4444" },
                ]}
              />
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
          History
        </h2>
        {bodyMetrics.length === 0 ? (
          <EmptyState message="No body metrics yet. Log one above to see the trend." />
        ) : (
          <ScrollFade>
            <table className="w-full">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/10">
                  <th className="th">Date</th>
                  <th className="th">Weight</th>
                  <th className="th">Body fat</th>
                  <th className="th">Resting HR</th>
                  <th className="th">Source</th>
                  <th className="th">Notes</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {bodyMetrics.map((w) => (
                  <tr
                    key={w.id}
                    className="border-b border-black/5 dark:border-white/10"
                  >
                    <td className="td whitespace-nowrap">
                      {formatLongDate(w.date)}
                    </td>
                    <td
                      className="td font-medium"
                      data-testid="body-weight-cell"
                    >
                      {fmtWeight(w.weight_kg, wu)}
                    </td>
                    <td className="td">
                      {w.body_fat_pct != null ? `${w.body_fat_pct}%` : "—"}
                    </td>
                    <td className="td">{w.resting_hr ?? "—"}</td>
                    <td className="td whitespace-nowrap">
                      {w.document_id != null ? (
                        <Link
                          href={`/import/${w.document_id}`}
                          className="text-brand-700 hover:underline dark:text-brand-400"
                        >
                          {w.source_label}
                        </Link>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400">
                          {w.source_label}
                        </span>
                      )}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {w.notes ?? ""}
                    </td>
                    <td className="td text-right">
                      <DeleteBodyMetricButton
                        id={w.id}
                        label={formatLongDate(w.date)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFade>
        )}
      </div>
    </div>
  );
}

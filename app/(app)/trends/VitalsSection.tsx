import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getBiomarkerSeries,
  getBodyMetricDailySeries,
  getMetricDailyTotals,
} from "@/lib/queries";
import { getUnitPrefs } from "@/lib/settings";
import { HRV_METRIC } from "@/lib/vitals-input";
import { ALL_ROWS, filterSeriesByRange } from "@/lib/trends";
import { chartSeries } from "@/lib/chart-colors";
import type { DateRange } from "@/lib/timeline-format";
import type { MedicalRecord } from "@/lib/types";
import { EmptyState } from "@/components/ui";
import LineChartCard from "@/components/LineChartCard";
import VitalsQuickAdd from "./VitalsQuickAdd";

// The Trends → Vitals section (#1076). The physiologic vitals were previously
// stranded on the biomarker view — charted on a years-axis with a yearly-retest
// nudge, and (for a fever) leaking into the flagged-biomarker hero. Now that the
// biomarker surfaces scope to `lab` only, this is their home: BP (systolic +
// diastolic), SpO2, respiratory rate, resting HR, and HRV as windowed trend
// charts. Body TEMPERATURE gets ACUTE grammar — a recent-readings view with a
// fever reference line and a link to the illness/fever surface — NEVER a years
// trajectory (a fever is a spike, not a slow trend). Reuses the existing series
// queries + LineChartCard; no new data path.

type Point = { date: string; value: number };

// medical_records vitals (BP/SpO2/respiratory rate/temperature) — one value per
// reading, mapped to the {date,value} the chart takes. Windowed by the shared range.
function vitalSeries(
  rows: MedicalRecord[],
  range: DateRange,
  round = 0
): Point[] {
  const factor = 10 ** round;
  return filterSeriesByRange(
    rows
      .filter((r) => r.value_num != null)
      .map((r) => ({
        date: r.date,
        value: Math.round((r.value_num as number) * factor) / factor,
      })),
    range
  );
}

// Fahrenheit fever threshold (100.4 °F / 38 °C) — the reference line on the acute
// temperature view, matching the illness/fever surface (#859).
const FEVER_F = 100.4;
// The acute temperature view shows only the most recent readings (never a years
// trajectory), regardless of the shared window.
const TEMP_RECENT = 30;

export default async function VitalsSection({ range }: { range: DateRange }) {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);

  const systolic = vitalSeries(
    getBiomarkerSeries(profile.id, "Blood Pressure Systolic"),
    range
  );
  const diastolic = vitalSeries(
    getBiomarkerSeries(profile.id, "Blood Pressure Diastolic"),
    range
  );
  const spo2 = vitalSeries(
    getBiomarkerSeries(profile.id, "Oxygen Saturation"),
    range
  );
  const respiratory = vitalSeries(
    getBiomarkerSeries(profile.id, "Respiratory Rate"),
    range
  );
  const restingHr = filterSeriesByRange(
    getBodyMetricDailySeries(profile.id, "resting_hr", ALL_ROWS).map((w) => ({
      date: w.date,
      value: Math.round(w.value),
    })),
    range
  );
  const hrv = filterSeriesByRange(
    getMetricDailyTotals(profile.id, HRV_METRIC, 3650).map((d) => ({
      date: d.date,
      value: Math.round(d.value),
    })),
    range
  );
  // Temperature: acute — the most recent readings only, newest kept, oldest first.
  const tempRows = getBiomarkerSeries(profile.id, "Body Temperature")
    .filter((r) => r.value_num != null)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const temperature: Point[] = tempRows.slice(-TEMP_RECENT).map((r) => ({
    date: r.date,
    value: Math.round((r.value_num as number) * 10) / 10,
  }));

  const hasBp = systolic.length > 0 || diastolic.length > 0;
  const hasAny =
    hasBp ||
    spo2.length > 0 ||
    respiratory.length > 0 ||
    restingHr.length > 0 ||
    hrv.length > 0 ||
    temperature.length > 0;

  return (
    <div data-testid="trends-vitals">
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Your physiologic vitals — blood pressure, oxygen saturation, respiratory
        rate, resting heart rate, HRV, and body temperature. Log a reading with
        the quick-add below.
      </p>

      <div className="mb-6">
        <VitalsQuickAdd
          defaultDate={today(profile.id)}
          temperatureUnit={units.temperatureUnit}
        />
      </div>

      {!hasAny ? (
        <EmptyState message="No vitals logged yet. Add a reading above to see the trend." />
      ) : (
        <div className="space-y-6">
          {hasBp && (
            <div className="card" data-testid="vitals-blood-pressure">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Blood pressure
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <LineChartCard
                  data={systolic}
                  label="Systolic"
                  unit=" mmHg"
                  color={chartSeries.rose}
                  heightClass="h-48"
                />
                <LineChartCard
                  data={diastolic}
                  label="Diastolic"
                  unit=" mmHg"
                  color={chartSeries.violet}
                  heightClass="h-48"
                />
              </div>
            </div>
          )}

          {spo2.length > 0 && (
            <div className="card" data-testid="vitals-spo2">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Oxygen saturation
              </h3>
              <LineChartCard
                data={spo2}
                label="SpO₂"
                unit="%"
                color={chartSeries.emerald}
                heightClass="h-48"
              />
            </div>
          )}

          {respiratory.length > 0 && (
            <div className="card" data-testid="vitals-respiratory-rate">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Respiratory rate
              </h3>
              <LineChartCard
                data={respiratory}
                label="Respiratory rate"
                unit=" /min"
                color={chartSeries.slate}
                heightClass="h-48"
              />
            </div>
          )}

          {restingHr.length > 0 && (
            <div className="card" data-testid="vitals-resting-hr">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Resting heart rate
              </h3>
              <LineChartCard
                data={restingHr}
                label="Resting HR"
                unit=" bpm"
                color={chartSeries.brand}
                heightClass="h-48"
              />
            </div>
          )}

          {hrv.length > 0 && (
            <div className="card" data-testid="vitals-hrv">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Heart rate variability
              </h3>
              <LineChartCard
                data={hrv}
                label="HRV"
                unit=" ms"
                color={chartSeries.amber}
                heightClass="h-48"
              />
            </div>
          )}

          {temperature.length > 0 && (
            <div className="card" data-testid="vitals-temperature">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                  Body temperature
                </h3>
                <Link
                  href="/medical/episodes"
                  className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
                >
                  Illness episodes <IconArrowRight size={14} />
                </Link>
              </div>
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Recent readings ({temperature.length}). Temperature is an acute
                signal — a fever is tracked on the illness/fever chart, not a
                long-term trajectory.
              </p>
              <LineChartCard
                data={temperature}
                label="Temperature"
                unit=" °F"
                color={chartSeries.rose}
                referenceValue={{ value: FEVER_F, label: "Fever" }}
                heightClass="h-48"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

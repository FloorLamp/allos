import Link from "next/link";
import type { CardioZoneCoverage } from "@/lib/queries";
import type { SessionOverviewRollup } from "@/lib/session-overview";
import type { FitnessPercentile } from "@/lib/fitness-norms";
import { formatPercentile } from "@/lib/fitness-norms";
import { fmtDistance } from "@/lib/units";
import { formatMinutes } from "@/lib/duration";
import type { DistanceUnit } from "@/lib/settings";

function changeText(value: number | null): string {
  if (value == null) return "no prior block";
  if (value === 0) return "same as the 28 days before";
  return `${value > 0 ? "+" : ""}${value}% vs the 28 days before`;
}

export default function EnduranceDepthSuite({
  zones,
  form,
  vo2,
  distanceUnit,
}: {
  zones: CardioZoneCoverage | null;
  form: SessionOverviewRollup;
  vo2: FitnessPercentile | null;
  distanceUnit: DistanceUnit;
}) {
  const hasHistory = form.recent.sessions > 0 || form.previous.sessions > 0;
  return (
    <div className="card" data-testid="endurance-depth-suite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Endurance
        </h3>
        <Link
          href="/training?tab=analyze&kind=cardio"
          className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          Analyze →
        </Link>
      </div>
      {!hasHistory ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          No recent endurance sessions. Log cardio to build intensity and
          personal-baseline context.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div>
            <p className="section-label">Zone coverage this week</p>
            {zones ? (
              <>
                <div className="mt-2 flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800">
                  {zones.minutes.map((minutes, index) => (
                    <span
                      key={index}
                      className={
                        [
                          "bg-slate-400",
                          "bg-emerald-500",
                          "bg-amber-400",
                          "bg-orange-500",
                          "bg-rose-600",
                        ][index]
                      }
                      style={{
                        width: `${zones.totalMinutes > 0 ? (minutes / zones.totalMinutes) * 100 : 0}%`,
                      }}
                      title={`Zone ${index + 1}: ${minutes} min`}
                    />
                  ))}
                </div>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  Zone 2 {zones.minutes[1] ?? 0} min · {zones.easyPercent}% easy
                  / {100 - zones.easyPercent}% hard
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Heart-rate zones appear when a session has wearable data and a
                profile zone model.
              </p>
            )}
          </div>
          <div>
            <p className="section-label">Last 28 days</p>
            <p className="mt-2 text-lg font-semibold text-slate-800 dark:text-slate-100">
              {form.recent.distanceKm > 0
                ? fmtDistance(form.recent.distanceKm, distanceUnit)
                : formatMinutes(form.recent.durationMin)}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {changeText(
                form.recent.distanceKm > 0
                  ? form.distanceChangePercent
                  : form.durationChangePercent
              )}
            </p>
          </div>
          <div>
            <p className="section-label">VO₂ percentile</p>
            <p className="mt-2 text-lg font-semibold text-slate-800 dark:text-slate-100">
              {vo2 ? formatPercentile(vo2) : "No current VO₂ result"}
            </p>
            <Link
              href="/training/fitness-check"
              className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              Fitness check →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

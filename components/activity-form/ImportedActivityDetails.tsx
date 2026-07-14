"use client";

import type { ActivityEditData } from "./model";
import type { DistanceUnit } from "@/lib/settings";
import { importedActivityStats } from "@/lib/activity-import-details";

export default function ImportedActivityDetails({
  activity,
  distanceUnit,
}: {
  activity: ActivityEditData | null;
  distanceUnit: DistanceUnit;
}) {
  if (
    !activity?.source ||
    activity.source === "manual" ||
    !activity.imported_metrics
  )
    return null;
  const { primary, secondary } = importedActivityStats(
    activity.imported_metrics,
    distanceUnit
  );
  const estimatedCalories =
    activity.imported_metrics.active_kcal == null &&
    activity.calorie_estimated &&
    activity.calorie_kcal != null
      ? activity.calorie_kcal
      : null;
  if (
    primary.length === 0 &&
    secondary.length === 0 &&
    estimatedCalories == null
  )
    return null;
  return (
    <section
      data-testid="imported-activity-details"
      aria-labelledby="imported-activity-details-title"
    >
      <h3 id="imported-activity-details-title" className="label mb-0">
        Recorded measurements
      </h3>
      {primary.length > 0 && (
        <dl
          data-testid="strava-primary-stats"
          className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 lg:grid-cols-4"
        >
          {primary.map((stat) => (
            <div key={stat.key} className="min-w-0">
              <dt className="text-xs text-slate-500 dark:text-slate-400">
                {stat.label}
              </dt>
              <dd className="mt-0.5 text-base font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                {stat.value}
              </dd>
              {stat.detail && (
                <div className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
                  {stat.key === "power" ? (
                    <>
                      <span
                        className="cursor-help decoration-dotted underline-offset-2 hover:underline"
                        title="Weighted power accounts for changes in effort and better reflects the ride’s physiological load."
                      >
                        {stat.detail.split(" · ")[0]}
                      </span>
                      {stat.detail.includes(" · ") &&
                        ` · ${stat.detail.split(" · ").slice(1).join(" · ")}`}
                    </>
                  ) : (
                    stat.detail
                  )}
                </div>
              )}
            </div>
          ))}
        </dl>
      )}
      {(secondary.length > 0 || estimatedCalories != null) && (
        <dl
          data-testid="strava-secondary-stats"
          className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs lg:grid-cols-4"
        >
          {secondary.map((stat) => (
            <div key={stat.key} className="min-w-0">
              <dt className="text-slate-400 dark:text-slate-500">
                {stat.label}
              </dt>
              <dd className="mt-0.5 font-medium tabular-nums text-slate-600 dark:text-slate-300">
                {stat.value}
              </dd>
            </div>
          ))}
          {estimatedCalories != null && (
            <div className="min-w-0" data-testid="estimated-active-energy">
              <dt className="text-slate-400 dark:text-slate-500">
                Active energy
              </dt>
              <dd className="mt-0.5 font-medium tabular-nums text-slate-600 dark:text-slate-300">
                ≈ {Math.round(estimatedCalories)} kcal
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

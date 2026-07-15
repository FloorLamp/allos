import {
  getCardioByActivity,
  getCardioVolumeByWeek,
  getCardioIntensityMix,
} from "@/lib/queries";
import { getUnitPrefs } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { fmtDistance, fmtKmh } from "@/lib/units";
import { formatMinutes } from "@/lib/duration";
import { today } from "@/lib/db";
import { formatRelativeDate } from "@/lib/format-date";
import { recentCardioPRs, type CardioPR } from "@/lib/coaching";
import { EmptyState } from "@/components/ui";
import CardioExplorer from "@/components/CardioExplorer";
import StackedBarCard from "@/components/StackedBarCard";
import PrCard from "@/components/PrCard";

const KIND_LABEL: Record<CardioPR["kind"], string> = {
  distance: "longest",
  speed: "fastest",
  duration: "longest time",
};

// Intensity → bar/legend color.
const INTENSITY_COLOR: Record<string, string> = {
  Easy: "bg-emerald-500",
  Moderate: "bg-amber-500",
  Hard: "bg-rose-500",
  Unspecified: "bg-slate-400",
};

function prValue(p: CardioPR, du: "km" | "mi"): string {
  if (p.kind === "distance") return fmtDistance(p.distanceKm, du);
  if (p.kind === "speed") return fmtKmh(p.speedKmh, du);
  return formatMinutes(p.durationMin);
}

// Cardio analytics + records. New section on the combined Training page.
export default async function CardioSection() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const du = units.distanceUnit;
  const cardio = getCardioByActivity(profile.id, du);
  const prs = recentCardioPRs(cardio, today(profile.id), 30);
  const weekly = getCardioVolumeByWeek(profile.id);
  const mix = getCardioIntensityMix(profile.id);
  const mixTotal = mix.reduce((s, b) => s + b.minutes, 0);

  return (
    <section>
      {cardio.length === 0 ? (
        <EmptyState message="No cardio logged yet. Log a run, ride, or swim to see trends and records." />
      ) : (
        <>
          {/* Recent cardio PRs beside the weekly-volume chart (2 columns when
              both are present). */}
          {(prs.length > 0 || weekly.data.length > 0) && (
            <div
              className={`mb-6 grid gap-6 ${
                prs.length > 0 && weekly.data.length > 0 ? "lg:grid-cols-2" : ""
              }`}
            >
              {prs.length > 0 && (
                <PrCard
                  title="🏆 Recent cardio PRs"
                  items={prs.map((p) => ({
                    name: p.activity,
                    value: prValue(p, du),
                    meta: `${KIND_LABEL[p.kind]} · ${formatRelativeDate(p.date, today(profile.id))}`,
                  }))}
                />
              )}

              {weekly.data.length > 0 && (
                <div className="card">
                  <h3 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
                    Weekly volume
                  </h3>
                  <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                    Minutes per week, by activity
                  </p>
                  <StackedBarCard
                    data={weekly.data}
                    series={weekly.series}
                    unit=" min"
                    labelPrefix="Week of "
                  />
                </div>
              )}
            </div>
          )}

          {mixTotal > 0 && (
            <div className="card mb-6">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Intensity mix
              </h3>
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800">
                {mix.map((b) => (
                  <div
                    key={b.intensity}
                    className={INTENSITY_COLOR[b.intensity] ?? "bg-slate-400"}
                    style={{ width: `${(b.minutes / mixTotal) * 100}%` }}
                    title={`${b.intensity}: ${formatMinutes(b.minutes)}`}
                  />
                ))}
              </div>
              <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                {mix.map((b) => (
                  <li key={b.intensity} className="flex items-center gap-1.5">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${INTENSITY_COLOR[b.intensity] ?? "bg-slate-400"}`}
                    />
                    {b.intensity} — {formatMinutes(b.minutes)} · {b.sessions}×
                  </li>
                ))}
              </ul>
            </div>
          )}

          <CardioExplorer cardio={cardio} units={units} />
        </>
      )}
    </section>
  );
}

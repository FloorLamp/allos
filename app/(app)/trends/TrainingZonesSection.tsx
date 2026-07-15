import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getTrainingZoneData } from "@/lib/queries";
import { ZONES, ZONE_COLORS, type ZoneModel } from "@/lib/training-zones";
import { EmptyState } from "@/components/ui";
import ZoneMinutesCard, {
  type ZoneWeekDatum,
} from "@/components/ZoneMinutesCard";

// The bpm range label for a zone id (1..5): "[lower]–[nextLower−1] bpm", open at
// the top for Zone 5.
function zoneRange(model: ZoneModel, id: number): string {
  const lo = model.lowerBounds[id - 1];
  const hi = id < 5 ? model.lowerBounds[id] - 1 : model.maxHr;
  return id < 5 ? `${lo}–${hi} bpm` : `${lo}+ bpm`;
}

// Trends → Fitness → HR training-intensity distribution (issue #159): weekly
// stacked zone minutes with a Zone 2 target line, the current-week Zone 2 volume,
// the easy/hard polarization split, and the zone boundary table WITH its formula.
// All HR is scoped to activity windows so all-day wear doesn't count as training.
export default async function TrainingZonesSection() {
  const { profile } = await requireSession();
  const data = getTrainingZoneData(profile.id);
  const { model } = data;

  return (
    <section data-testid="training-zones" className="mb-6">
      <div className="card">
        <h3 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
          Training intensity (HR zones)
        </h3>
        <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
          Weekly minutes per heart-rate zone, from per-minute HR during your
          logged workouts. Longevity training tracks weekly Zone 2 volume and
          the easy/hard (80/20) split.
        </p>

        {!model ? (
          <EmptyState message="Set your age (or a max-HR override) in Settings → Profile to draw your heart-rate zones." />
        ) : (
          <>
            <ZoneMinutesCard
              data={data.weeks.map((w): ZoneWeekDatum => ({
                week: w.week,
                z1: w.minutes[0],
                z2: w.minutes[1],
                z3: w.minutes[2],
                z4: w.minutes[3],
                z5: w.minutes[4],
              }))}
              zone2Target={data.zone2Target}
            />

            {!data.hasHrData && (
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                No heart-rate data yet. Sync a wearable (Health Connect) or
                import workouts with HR to see your zone distribution.
              </p>
            )}

            {/* Current-week Zone 2 volume vs target. */}
            {data.currentWeekZone2 && data.zone2Target > 0 && (
              <p
                data-testid="zone2-adherence"
                className="mt-4 text-sm text-slate-600 dark:text-slate-300"
              >
                <span className="font-semibold">Zone 2 this week:</span>{" "}
                {data.currentWeekZone2.minutes} of {data.zone2Target} min target
                {data.currentWeekZone2.met ? (
                  <span className="ml-1 font-medium text-emerald-600 dark:text-emerald-400">
                    ✓ met
                  </span>
                ) : (
                  <span className="ml-1 text-slate-400">
                    ({data.currentWeekZone2.pct}%)
                  </span>
                )}
              </p>
            )}

            {/* Easy/hard polarization split. */}
            {data.split.totalMin > 0 && (
              <div className="mt-4" data-testid="polarization-split">
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-semibold text-slate-700 dark:text-slate-200">
                    Easy / hard split
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">
                    {data.split.easyPct}% easy · {data.split.hardPct}% hard
                  </span>
                </div>
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-ink-800">
                  <div
                    style={{
                      width: `${data.split.easyPct}%`,
                      backgroundColor: ZONE_COLORS[1],
                    }}
                    title={`Easy (Z1–Z2): ${data.split.easyMin} min`}
                  />
                  <div
                    style={{
                      width: `${data.split.hardPct}%`,
                      backgroundColor: ZONE_COLORS[3],
                    }}
                    title={`Hard (Z3–Z5): ${data.split.hardMin} min`}
                  />
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Easy = at/below the aerobic threshold (Zones 1–2); hard =
                  above it (Zones 3–5). A polarized base keeps ~80% easy.
                </p>
              </div>
            )}

            {/* Zone boundary table with the formula (no black box). */}
            <div className="mt-5 border-t border-black/5 pt-4 dark:border-white/10">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {ZONES.map((z) => (
                      <tr key={z.id}>
                        <td className="py-1 pr-2">
                          <span
                            className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
                            style={{ backgroundColor: ZONE_COLORS[z.id - 1] }}
                          />
                          <span className="font-medium text-slate-700 dark:text-slate-200">
                            {z.name}
                          </span>{" "}
                          <span className="text-slate-500 dark:text-slate-400">
                            {z.label}
                          </span>
                        </td>
                        <td className="py-1 text-right tabular-nums text-slate-600 dark:text-slate-300">
                          {zoneRange(model, z.id)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                {model.formula} A lab-tested lactate/ventilatory threshold beats
                any formula — set a max-HR override in{" "}
                <Link
                  href="/settings/profile"
                  className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                >
                  Settings → Profile
                </Link>{" "}
                if you know yours.
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

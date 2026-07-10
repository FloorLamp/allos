import {
  getStrengthByExercise,
  getVolumeByDate,
  getLatestBodyMetric,
  getRecentByExercise,
  getGoals,
  getGoalProgressMap,
} from "@/lib/queries";
import { getUnitPrefs, getUserSex } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { dispWeight, fmtWeight } from "@/lib/units";
import { today } from "@/lib/db";
import { formatRelativeDate } from "@/lib/format-date";
import { recentPRs } from "@/lib/coaching";
import LineChartCard from "@/components/LineChartCard";
import StrengthExplorer from "@/components/StrengthExplorer";
import PrCard from "@/components/PrCard";
import { EmptyState } from "@/components/ui";

// Strength analytics + coaching. Extracted from the former /workouts page, with
// a "Recent PRs" card added on top.
export default async function StrengthSection() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;
  const volume = getVolumeByDate(profile.id).map((v) => ({
    date: v.date,
    value: dispWeight(v.volume, wu, 0),
  }));
  const exercises = getStrengthByExercise(profile.id);
  const bodyweightKg = getLatestBodyMetric(profile.id, "weight");
  const recentByExercise = getRecentByExercise(profile.id, wu);
  const goals = getGoals(profile.id);
  // Plain object (not a Map) so it can cross into the client component.
  const goalProgress = Object.fromEntries(
    getGoalProgressMap(profile.id, goals)
  );
  const prs = recentPRs(exercises, today(profile.id), 30);

  return (
    <section>
      {/* Recent PRs beside the volume trend (2 columns when both are present). */}
      <div
        className={`mb-6 grid gap-6 ${prs.length > 0 ? "lg:grid-cols-2" : ""}`}
      >
        {prs.length > 0 && (
          <PrCard
            title="🏆 Recent PRs"
            items={prs.map((p) => ({
              name: p.exercise,
              value:
                p.kind === "1rm"
                  ? p.bodyweight
                    ? `BW × ${p.reps}`
                    : `${fmtWeight(p.weightKg, wu)} × ${p.reps}`
                  : `${fmtWeight(p.weightKg, wu)} top`,
              meta: formatRelativeDate(p.date, today(profile.id)),
            }))}
          />
        )}

        <div className="card">
          <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Total training volume ({wu} lifted per session)
          </h3>
          {volume.length === 0 ? (
            <EmptyState message="No strength sessions logged yet. Log a lift to see your volume trend." />
          ) : (
            <LineChartCard
              data={volume}
              label="Volume"
              unit={` ${wu}`}
              color="#16a34a"
            />
          )}
        </div>
      </div>

      {!bodyweightKg && exercises.length > 0 && (
        <div className="mb-6 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          Add a body weight entry on the Body Metrics page to see strength
          standards relative to your bodyweight.
        </div>
      )}

      <StrengthExplorer
        exercises={exercises}
        bodyweightKg={bodyweightKg}
        units={units}
        recentByExercise={recentByExercise}
        goals={goals}
        goalProgress={goalProgress}
        sex={getUserSex(profile.id)}
      />
    </section>
  );
}

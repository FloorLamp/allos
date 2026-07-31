import {
  getStrengthByExercise,
  getVolumeByDate,
  getLatestBodyMetric,
  getRecentByExercise,
  getGoals,
  getGoalProgressMap,
} from "@/lib/queries";
import {
  getUnitPrefs,
  getUserSex,
  getDisplayFormatPrefs,
} from "@/lib/settings";
import { chartSeries } from "@/lib/chart-colors";
import { requireSession } from "@/lib/auth";
import { dispWeight, fmtWeight } from "@/lib/units";
import { today } from "@/lib/db";
import { formatRelativeDate } from "@/lib/format-date";
import { recentPRs } from "@/lib/coaching";
import { loadContextLabel } from "@/lib/lifts";
import LineChartCard from "@/components/LineChartCard";
import StrengthExplorer from "@/components/StrengthExplorer";
import PrCard from "@/components/PrCard";
import { EmptyState } from "@/components/ui";
import { Notice } from "@/components/Notice";

// UNMOUNTED since #1492. This section (and the full-history explorer it hosts) was
// only ever rendered by Trends → Fitness, which became the WINDOWED analytics lens:
// "analyze on Trends, do on /training". Its capabilities live on /training →
// Analyze (the picker + per-item detail panel — the explorer triplet's fourth
// sibling), which #1491 item 3 converges these three onto. Kept, not deleted, so
// that convergence has its subjects; /training page changes are out of #1492's
// scope, so nothing re-mounts it here.
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
  // PRs read the LOAD-CONTEXT grouping (#1610) so a record is never assembled from
  // two machines; the card labels each row with its implement. The movement-wide
  // `exercises` above still drives the per-exercise list and detail panel. Both fold
  // the SAME cached all-history scan (#1654) — one read, two aggregates.
  const prStats = getStrengthByExercise(profile.id, true);
  const bodyweightKg = getLatestBodyMetric(profile.id, "weight");
  const recentByExercise = getRecentByExercise(
    profile.id,
    wu,
    getDisplayFormatPrefs(login.id)
  );
  const goals = getGoals(profile.id);
  // Plain object (not a Map) so it can cross into the client component.
  const goalProgress = Object.fromEntries(
    getGoalProgressMap(profile.id, goals)
  );
  const prs = recentPRs(prStats, today(profile.id), 30);

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
              name: loadContextLabel(p.exercise, p.equipment),
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
            <EmptyState
              message="No strength sessions logged yet. Log a lift to see your volume trend."
              action={{ href: "/training?tab=log", label: "Go to Log" }}
            />
          ) : (
            <LineChartCard
              data={volume}
              label="Volume"
              unit={` ${wu}`}
              color={chartSeries.brand}
            />
          )}
        </div>
      </div>

      {!bodyweightKg && exercises.length > 0 && (
        <Notice tone="amber" className="mb-6">
          Add a body weight entry on the Body metrics page to see strength
          standards relative to your bodyweight.
        </Notice>
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

import {
  getActivities,
  getSetsForActivities,
  getStrengthByExercise,
  getCardioByActivity,
  getSportByActivity,
  getGoals,
  getGoalProgressMap,
  getFrequencyTargetProgress,
  getLatestBodyMetric,
  getJournalWeekSummary,
  getRecentByExercise,
  getWeights,
} from "@/lib/queries";
import { type DatedWeight } from "@/lib/calorie-estimate";
import { today as todayFn, yesterday as yesterdayFn } from "@/lib/db";
import { frequencyScopeLabel } from "@/lib/goals";
import { getUnitPrefs, getUserSex } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { getEquipment } from "@/lib/equipment";
import { buildJournalCards } from "@/lib/journal-card";
import { EmptyState } from "@/components/ui";
import JournalView from "../journal/JournalView";

export default async function HistorySection() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;
  const activities = getActivities(profile.id);

  if (activities.length === 0) {
    return (
      <EmptyState message="No activities logged yet. Use “Log activity” to start." />
    );
  }

  // Bodyweight series for the per-activity calorie ESTIMATE (issue #151): each
  // manual activity is scored against the weigh-in nearest its own date.
  const weights: DatedWeight[] = getWeights(profile.id).map((w) => ({
    date: w.date,
    weightKg: w.weight_kg,
  }));

  const sets = getSetsForActivities(
    profile.id,
    activities.map((a) => a.id)
  );
  // Resolve per-set equipment_id -> implement name for the journal's labels.
  // includeRetired: a retired implement must still label the historical sets it
  // was logged against (issue #341).
  const equipmentNames = new Map(
    getEquipment(profile.id, { includeRetired: true }).map((e) => [
      e.id,
      e.name,
    ])
  );

  // Build the day-grouped feed cards (set-grouping, components-vs-legacy parts,
  // header folds, metric chips, faults, provenance) — one pure computation, shared
  // by the pinning test (issue #334).
  const groups = buildJournalCards({
    activities,
    sets,
    equipmentNames,
    weights,
    units,
    // "Today"/"Yesterday" labels relative to the calendar/db notion of today
    // (TZ-local, matching lib/db).
    today: todayFn(profile.id),
    yesterday: yesterdayFn(profile.id),
  });

  // Per-exercise recent sessions (last 10) for the exercise detail pane.
  const recentByExercise = getRecentByExercise(profile.id, wu);

  const summary = getJournalWeekSummary(profile.id);
  const goals = getGoals(profile.id);
  // Map → plain object so it can cross the server/client boundary.
  const goalProgress = Object.fromEntries(
    getGoalProgressMap(profile.id, goals)
  );
  const targets = getFrequencyTargetProgress(profile.id).map((t) => ({
    label: frequencyScopeLabel(t.target.scope_kind, t.target.scope_value),
    count: t.count,
    perWeek: t.per_week,
    met: t.met,
  }));

  return (
    <JournalView
      groups={groups}
      exerciseStats={getStrengthByExercise(profile.id)}
      cardioStats={getCardioByActivity(profile.id, units.distanceUnit)}
      sportStats={getSportByActivity(profile.id)}
      goals={goals}
      goalProgress={goalProgress}
      bodyweightKg={getLatestBodyMetric(profile.id, "weight")}
      units={units}
      recentByExercise={recentByExercise}
      weekSummary={{
        sessions: summary.sessions,
        activeDays: summary.activeDays,
        streak: summary.streak,
        targets,
      }}
      showHeader={false}
      sex={getUserSex(profile.id)}
    />
  );
}

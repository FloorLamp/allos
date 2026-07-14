import {
  getStrengthByExercise,
  getCardioByActivity,
  getSportByActivity,
  getGoals,
  getGoalProgressMap,
  getFrequencyTargetProgress,
  getLatestBodyMetric,
  getJournalWeekSummary,
  getRecentByExercise,
  getActiveDaysStrip,
} from "@/lib/queries";
import { frequencyScopeLabel } from "@/lib/goals";
import { getUnitPrefs, getUserSex } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { buildJournalFeedPage } from "@/lib/journal-feed";
import { EmptyState } from "@/components/ui";
import JournalView from "../journal/JournalView";

export default async function HistorySection() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;

  // First page ONLY (issue #451): the newest window of day-grouped cards, not the whole
  // history. Older windows are fetched on demand by the "Load more" server action
  // (journal/actions.ts), which calls the SAME buildJournalFeedPage assembler.
  const { groups, nextBefore } = buildJournalFeedPage(profile.id, null, units);

  if (groups.length === 0) {
    return (
      <EmptyState message="No activities logged yet. Use “Log activity” to start." />
    );
  }

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
      initialCursor={nextBefore}
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
      activeDaysStrip={getActiveDaysStrip(profile.id, 21)}
      showHeader={false}
      sex={getUserSex(profile.id)}
    />
  );
}

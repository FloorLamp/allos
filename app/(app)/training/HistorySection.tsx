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
import {
  getUnitPrefs,
  getUserSex,
  getDisplayFormatPrefs,
} from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { buildJournalFeedPage } from "@/lib/journal-feed";
import JournalView from "../journal/JournalView";

export default async function HistorySection() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;

  // First page ONLY (issue #451): the newest window of day-grouped cards, not the whole
  // history. Older windows are fetched on demand by the "Load more" server action
  // (journal/actions.ts), which calls the SAME buildJournalFeedPage assembler.
  // Render JournalView unconditionally, even for a brand-new/post-onboarding
  // profile with no activities (issue #809). The early return that short-circuited
  // to a bare EmptyState kept JournalView — which owns the Log-activity action row
  // and the activity-editor wiring — from ever mounting, leaving first-run users
  // with no way to log their first activity. JournalView now renders a dedicated
  // first-run empty variant (action row prominent, filters/search hidden); the
  // stats/goals queries below are cheap and empty for a fresh profile.
  const { groups, nextBefore } = buildJournalFeedPage(
    profile.id,
    null,
    units,
    getDisplayFormatPrefs(login.id)
  );

  // Per-exercise recent sessions (last 10) for the exercise detail pane.
  const recentByExercise = getRecentByExercise(
    profile.id,
    wu,
    getDisplayFormatPrefs(login.id)
  );

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
    pace: t.pace,
  }));

  return (
    <JournalView
      groups={groups}
      initialCursor={nextBefore}
      exerciseStats={getStrengthByExercise(profile.id)}
      cardioStats={getCardioByActivity(
        profile.id,
        units.distanceUnit,
        getDisplayFormatPrefs(login.id)
      )}
      sportStats={getSportByActivity(
        profile.id,
        getDisplayFormatPrefs(login.id)
      )}
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

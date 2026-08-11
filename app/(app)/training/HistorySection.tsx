import {
  getStrengthByExercise,
  getCardioByActivity,
  getSportByActivity,
  getOutcomeGoals,
  getOutcomeGoalProgressMap,
  getFrequencyTargetProgress,
  getLatestBodyMetric,
  getJournalWeekSummary,
  getRecentByExercise,
  getActiveDaysStrip,
} from "@/lib/queries";
import { frequencyScopeLabel } from "@/lib/frequency-targets";
import {
  getUnitPrefs,
  getProfileSex,
  getDisplayFormatPrefs,
} from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { EMPTY_JOURNAL_FILTERS } from "@/lib/journal-filters";
import { resolveJournalFeedContext } from "./journal-feed-resolve";
import JournalView from "./JournalView";

export default async function HistorySection({
  initialCreateDate,
}: {
  initialCreateDate?: string;
}) {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;

  // The feed's FIRST page under NO filters (issues #451, #1634): the newest window
  // of day-grouped cards, not the whole history. Older windows — and, when a filter
  // is on, the filtered page one — are fetched by the "Load more" / filter Server
  // Action (loadJournalPage), which calls the SAME resolver, so the initial render
  // and every later fetch build identical cards, authorize identically, and (in a
  // household view) stamp the same subject identity.
  //
  // Render JournalView unconditionally, even for a brand-new/post-onboarding
  // profile with no activities (issue #809). The early return that short-circuited
  // to a bare EmptyState kept JournalView — which owns the Log-activity action row
  // and the activity-editor wiring — from ever mounting, leaving first-run users
  // with no way to log their first activity. JournalView now renders a dedicated
  // first-run empty variant (action row prominent, filters/search hidden); the
  // stats/goals queries below are cheap and empty for a fresh profile.
  const feed = await resolveJournalFeedContext(EMPTY_JOURNAL_FILTERS);

  // Per-exercise recent sessions (last 10) for the exercise detail pane.
  const recentByExercise = getRecentByExercise(
    profile.id,
    wu,
    getDisplayFormatPrefs(login.id)
  );

  const summary = getJournalWeekSummary(profile.id);
  const goals = getOutcomeGoals(profile.id);
  // Map → plain object so it can cross the server/client boundary.
  const goalProgress = Object.fromEntries(
    getOutcomeGoalProgressMap(profile.id, goals)
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
      initialCreateDate={initialCreateDate}
      groups={feed.groups}
      initialCursor={feed.cursor}
      sourceOptions={feed.sourceOptions}
      faultCount={feed.faultCount}
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
        targets,
      }}
      activeDaysStrip={getActiveDaysStrip(profile.id, 21)}
      showHeader={false}
      sex={getProfileSex(profile.id)}
      canWriteVideos={feed.canWriteVideos}
      multiView={
        feed.multi ? { actingProfileId: feed.actingProfileId } : undefined
      }
    />
  );
}

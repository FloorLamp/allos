import {
  getStrengthByExercise,
  getCardioByActivity,
  getSportByActivity,
  getOutcomeGoals,
  getOutcomeGoalProgressMap,
  getLatestBodyMetric,
  getTrainingLogWeekSummary,
  getRecentByExercise,
  getActiveDaysStrip,
} from "@/lib/queries";
import {
  getUnitPrefs,
  getProfileSex,
  getProfileAge,
  getDisplayFormatPrefs,
} from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { EMPTY_TRAINING_LOG_FILTERS } from "@/lib/training-log-filters";
import { resolveTrainingLogFeedContext } from "./training-log-feed-resolve";
import TrainingLogView from "./TrainingLogView";
import { isAdultForClinical } from "@/lib/life-stage";

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
  // Action (loadTrainingLogPage), which calls the SAME resolver, so the initial render
  // and every later fetch build identical cards, authorize identically, and (in a
  // household view) stamp the same subject identity.
  //
  // Render TrainingLogView unconditionally, even for a brand-new/post-onboarding
  // profile with no activities (issue #809). The early return that short-circuited
  // to a bare EmptyState kept TrainingLogView — which owns the Log-activity action row
  // and the activity-editor wiring — from ever mounting, leaving first-run users
  // with no way to log their first activity. TrainingLogView now renders a dedicated
  // first-run empty variant (action row prominent, filters/search hidden); the
  // stats/goals queries below are cheap and empty for a fresh profile.
  const feed = await resolveTrainingLogFeedContext(EMPTY_TRAINING_LOG_FILTERS);

  // Per-exercise recent sessions (last 10) for the exercise detail pane.
  const recentByExercise = getRecentByExercise(
    profile.id,
    wu,
    getDisplayFormatPrefs(login.id)
  );

  const summary = getTrainingLogWeekSummary(profile.id);
  const goals = getOutcomeGoals(profile.id);
  // Map → plain object so it can cross the server/client boundary.
  const goalProgress = Object.fromEntries(
    getOutcomeGoalProgressMap(profile.id, goals)
  );
  return (
    <TrainingLogView
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
      }}
      activeDaysStrip={getActiveDaysStrip(profile.id, 21)}
      showHeader={false}
      sex={getProfileSex(profile.id)}
      adultClinicalContent={isAdultForClinical(getProfileAge(profile.id))}
      canWriteVideos={feed.canWriteVideos}
      multiView={
        feed.multi ? { actingProfileId: feed.actingProfileId } : undefined
      }
    />
  );
}

import { getTrainingLogWeekSummary, getActiveDaysStrip } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { EMPTY_TRAINING_LOG_FILTERS } from "@/lib/training-log-filters";
import { resolveTrainingLogFeedContext } from "./training-log-feed-resolve";
import TrainingLogView from "./TrainingLogView";

export default async function HistorySection({
  initialCreateDate,
}: {
  initialCreateDate?: string;
}) {
  const { profile } = await requireSession();

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
  // summary queries below are cheap and empty for a fresh profile.
  const feed = await resolveTrainingLogFeedContext(EMPTY_TRAINING_LOG_FILTERS);

  const summary = getTrainingLogWeekSummary(profile.id);
  return (
    <TrainingLogView
      initialCreateDate={initialCreateDate}
      groups={feed.groups}
      initialCursor={feed.cursor}
      sourceOptions={feed.sourceOptions}
      faultCount={feed.faultCount}
      weekSummary={{
        sessions: summary.sessions,
        activeDays: summary.activeDays,
      }}
      activeDaysStrip={getActiveDaysStrip(profile.id, 21)}
      showHeader={false}
      multiView={
        feed.multi ? { actingProfileId: feed.actingProfileId } : undefined
      }
    />
  );
}

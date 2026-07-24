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
import { requireSession, accessForProfile } from "@/lib/auth";
import { requireScope, stampSubjects } from "@/lib/scope";
import { isTrainingRestricted } from "@/lib/age-gate";
import {
  buildJournalFeedPage,
  buildMultiViewJournalGroups,
} from "@/lib/journal-feed";
import type { DayGroup } from "@/lib/journal-card";
import JournalView from "../journal/JournalView";

export default async function HistorySection() {
  const { login, profile } = await requireSession();
  // The cross-profile scope (issue #1330): the persisted view-set (∩ accessible). In
  // the common single-view case `viewIds` is just the acting profile and everything
  // below renders exactly as before; when the user has spread the view, the Journal
  // becomes a MERGED, subject-stamped card feed with per-card write/fitness gating.
  const scope = await requireScope();
  const multi = scope.viewIds.length > 1;
  // Whether the acting login can write to the active profile — gates the per-card
  // form-check video affordances (#1224). The server actions re-gate regardless. In
  // multi-view each card carries its own subject write gate (below).
  const canWriteVideos =
    accessForProfile(login.id, login.role, profile.id) === "write";
  const units = getUnitPrefs(login.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);
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
  //
  // Multi-view (issue #1330): loop-compose the per-profile feed over the whole
  // view-set (each member's newest window built in ITS own timezone/labels), merge by
  // date, and stamp subject identity (name/photo/access via stampSubjects, plus each
  // member's OWN training-restriction) onto each card. It's a recent-window overview,
  // so server-side paging is off (initialCursor = null); the analytics side panel
  // stays the ACTING profile's own (its detail/goals/week summary describe "you").
  let groups: DayGroup[];
  let initialCursor: string | null;
  if (multi) {
    const merged = buildMultiViewJournalGroups(
      scope.viewIds,
      scope.actingProfileId,
      units,
      formatPrefs
    );
    const subjectByProfile = new Map(
      stampSubjects(
        scope,
        scope.viewIds.map((id) => ({ profileId: id }))
      ).map((s) => [s.profileId, s.subject])
    );
    const restrictedByProfile = new Map(
      scope.viewIds.map((id) => [id, isTrainingRestricted(id)])
    );
    groups = merged.map((g) => ({
      ...g,
      cards: g.cards.map((c) => {
        const pid = c.activity.subjectProfileId;
        const subject = pid != null ? subjectByProfile.get(pid) : undefined;
        return {
          ...c,
          subject: subject
            ? {
                profileId: subject.profileId,
                name: subject.name,
                photoPath: subject.photoPath,
                photoVersion: subject.photoVersion,
                canWrite: subject.access === "write",
                restricted: restrictedByProfile.get(subject.profileId) ?? false,
              }
            : undefined,
        };
      }),
    }));
    // No cross-member pager for the merged window (each member has its own cursor).
    initialCursor = null;
  } else {
    const page = buildJournalFeedPage(profile.id, null, units, formatPrefs);
    groups = page.groups;
    initialCursor = page.nextBefore;
  }

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
      initialCursor={initialCursor}
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
      canWriteVideos={canWriteVideos}
      multiView={multi ? { actingProfileId: scope.actingProfileId } : undefined}
    />
  );
}

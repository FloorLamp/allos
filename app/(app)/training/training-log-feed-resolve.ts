import { requireSession, accessForProfile } from "@/lib/auth";
import { requireScope, stampSubjects } from "@/lib/scope";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getUnitPrefs, getDisplayFormatPrefs } from "@/lib/settings";
import {
  buildTrainingLogFeedPage,
  buildMultiViewTrainingLogGroups,
} from "@/lib/training-log-feed";
import { getActivityFaults, getTrainingLogSourceKeys } from "@/lib/queries";
import {
  activityProvenanceKeyLabel,
  TRAINING_LOG_SOURCE_MANUAL,
} from "@/lib/training-log-format";
import type { DayGroup } from "@/lib/training-log-card";
import type { TrainingLogFilters } from "@/lib/training-log-filters";

// ONE resolution of "what does the Training Log feed show right now" (issue #1634),
// shared by the server component that renders the first page (HistorySection) and
// by the Server Action that fetches every later page or re-fetches page one when a
// filter changes (loadTrainingLogPage). Before this existed the two forked: the action
// only ever knew the single-profile path, while the multi-view merge + subject
// stamping lived inline in the page — so a filtered fetch could not have answered
// for a household view at all. Same authorization, same build, same stamping, one
// place.
//
// Not a "use server" module: it is a plain server helper. The action that calls it
// owns the request boundary (validation of the untrusted filter payload).

export interface TrainingLogSourceOption {
  value: string; // provenance key
  label: string;
}

export interface ResolvedTrainingLogFeed {
  groups: DayGroup[];
  // Cursor for the next-older page of THIS filter set, or null when exhausted.
  // Always null in multi-view (the merged window has no cross-member pager).
  cursor: string | null;
}

export interface TrainingLogFeedContext extends ResolvedTrainingLogFeed {
  // Whether the acting login can write to the ACTIVE profile — gates the per-card
  // form-check video affordances (#1224). The server actions re-gate regardless.
  canWriteVideos: boolean;
  multi: boolean;
  actingProfileId: number;
  // The source filter's option list, resolved server-side from the ledger's own
  // distinct sources (#1634) — never a hard-coded provider vocabulary.
  sourceOptions: TrainingLogSourceOption[];
  // How many rows across the WHOLE ledger the editor can't re-save as-is. The
  // client used to count this over the loaded pages only, which both under-reported
  // the badge and hid the toggle entirely when page one happened to be clean.
  faultCount: number;
}

// The feed itself (groups + cursor) for the given filters and cursor position.
export async function resolveTrainingLogFeed(
  filters: TrainingLogFilters,
  before: string | null = null
): Promise<ResolvedTrainingLogFeed> {
  return (await resolveTrainingLogFeedContext(filters, before)).feed;
}

// The feed plus the once-per-request context the controls need. HistorySection uses
// this; the action uses resolveTrainingLogFeed above and drops the rest.
export async function resolveTrainingLogFeedContext(
  filters: TrainingLogFilters,
  before: string | null = null
): Promise<{ feed: ResolvedTrainingLogFeed } & TrainingLogFeedContext> {
  const { login, profile } = await requireSession();
  // The cross-profile scope (issue #1330): the persisted view-set (∩ accessible). In
  // the common single-view case `viewIds` is just the acting profile.
  const scope = await requireScope();
  const multi = scope.viewIds.length > 1;
  const units = getUnitPrefs(login.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);

  let groups: DayGroup[];
  let cursor: string | null;
  if (multi) {
    // Multi-view (issue #1330): loop-compose the per-profile feed over the whole
    // view-set (each member's newest MATCHING window built in ITS own timezone/
    // labels), merge by date, and stamp subject identity (name/photo/access via
    // stampSubjects, plus each member's OWN training-restriction) onto each card.
    const merged = buildMultiViewTrainingLogGroups(
      scope.viewIds,
      scope.actingProfileId,
      units,
      formatPrefs,
      filters
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
    cursor = null;
  } else {
    const page = buildTrainingLogFeedPage(
      profile.id,
      before,
      units,
      formatPrefs,
      undefined,
      filters
    );
    groups = page.groups;
    cursor = page.nextBefore;
  }

  // Controls context, resolved over every profile whose cards can appear in the
  // feed so the option list and the badge describe what is actually on screen.
  const contextIds = multi ? scope.viewIds : [profile.id];
  const sourceKeys = new Set<string>();
  let faultCount = 0;
  for (const id of contextIds) {
    for (const key of getTrainingLogSourceKeys(id)) sourceKeys.add(key);
    faultCount += getActivityFaults(id).count;
  }
  // Manual first, then the rest alphabetically — a stable order across profiles and
  // as history grows, so the control doesn't reshuffle under the user.
  const sourceOptions = [...sourceKeys]
    .sort((a, b) =>
      a === TRAINING_LOG_SOURCE_MANUAL
        ? -1
        : b === TRAINING_LOG_SOURCE_MANUAL
          ? 1
          : a.localeCompare(b)
    )
    .map((value) => ({ value, label: activityProvenanceKeyLabel(value) }));

  const feed = { groups, cursor };
  return {
    feed,
    groups,
    cursor,
    canWriteVideos:
      accessForProfile(login.id, login.role, profile.id) === "write",
    multi,
    actingProfileId: scope.actingProfileId,
    sourceOptions,
    faultCount,
  };
}

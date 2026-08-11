// Assemble ONE page of the Training Log feed's day-grouped cards (issue #451). The Training Log
// used to load the profile's ENTIRE activity history (getActivities, SELECT * incl.
// the components TEXT) and page it client-side, so the whole history crossed the wire
// and hydrated on every Training → Log visit. This is the server-side window: the
// initial render (HistorySection) and the "Load more" server action (activity-actions.ts)
// both call THIS one assembler, so both build identical cards for a given window —
// "one question, one computation". Only the built DayGroups (not raw history) cross to
// the client. Not pure (reads DB + settings); takes the resolved profile + unit prefs.

import {
  getTrainingLogPage,
  resolveTrainingLogFilterSpec,
  getSetsForActivities,
  getRoutePolylinesForActivities,
  getActiveCaloriesForActivities,
  getWeights,
} from "./queries";
import { getEquipment } from "./equipment";
import { getActivityVideosForActivities } from "./activity-video-write";
import { buildTrainingLogCards, type DayGroup } from "./training-log-card";
import { mergeTrainingLogDayGroups } from "./training-log-multi-view";
import {
  EMPTY_TRAINING_LOG_FILTERS,
  trainingLogFiltersActive,
  type TrainingLogFilters,
} from "./training-log-filters";
import type { DatedWeight } from "./calorie-estimate";
import type { UnitPrefs } from "./settings";
import {
  DEFAULT_FORMAT_PREFS,
  formatLongDate,
  type DisplayFormatPrefs,
} from "./format-date";
import { today as todayFn, yesterday as yesterdayFn } from "./db";
import { getProfileZoneModel } from "./queries/zones";
import { getWeatherDaysForProfile } from "./queries/weather-situations";

// Days per page. Matches the client's 14-day reveal increment so a "Load more" click
// fetches roughly one screen of older history at a time.
export const TRAINING_LOG_PAGE_DAYS = 14;

export interface TrainingLogFeedPage {
  groups: DayGroup[];
  // Cursor for the next-older page (pass back as `before`), or null when exhausted.
  nextBefore: string | null;
}

// Build the day-grouped cards for the window ending just before `before` (null = the
// newest day). `dayLimit` days of activities are loaded, their sets fetched, and the
// pure buildTrainingLogCards run over them — the same derivation HistorySection used to
// run inline over ALL activities.
//
// FILTERS (issue #1634). When `filters` is active the window is the next `dayLimit`
// days that CONTAIN a match anywhere in the ledger — not the next `dayLimit` days —
// so `nextBefore` pages over matches and a hit twenty windows deep lands on page
// one. The store answers "which days", the pure trainingLogCardMatches answers "which
// cards" (the client applies it as it always has, now over a complete day set). An
// INACTIVE filter set resolves to no spec at all, so the unfiltered feed keeps its
// exact pre-#1634 query and cost.
export function buildTrainingLogFeedPage(
  profileId: number,
  before: string | null,
  units: UnitPrefs,
  formatPrefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS,
  dayLimit: number = TRAINING_LOG_PAGE_DAYS,
  filters: TrainingLogFilters = EMPTY_TRAINING_LOG_FILTERS
): TrainingLogFeedPage {
  const spec = trainingLogFiltersActive(filters)
    ? resolveTrainingLogFilterSpec(profileId, filters)
    : undefined;
  const page = getTrainingLogPage(profileId, before, dayLimit, spec);
  if (page.activities.length === 0) {
    return { groups: [], nextBefore: page.nextBefore };
  }

  const activityIds = page.activities.map((a) => a.id);
  const sets = getSetsForActivities(profileId, activityIds);
  // GPS route polylines for the tile-free route thumbnails (issue #569). Only
  // activities with a captured route appear in the map; consumed server-side to
  // build the card — only the (small) polyline for a rendered card crosses the wire.
  const routes = getRoutePolylinesForActivities(profileId, activityIds);
  const activeCalories = getActiveCaloriesForActivities(
    profileId,
    page.activities
  );
  // Form-check video clips (#1224) for this page's activities — one query, then
  // bucketed per activity; only the small metadata rows cross to the card.
  const activityVideos = getActivityVideosForActivities(profileId, activityIds);
  // Resolve per-set / per-activity equipment_id -> implement name. includeRetired: a
  // retired implement must still label the historical sets it was logged against
  // (issue #341). The equipment list is small and profile-owned, so re-reading it per
  // page is cheap — and it never crosses the wire (only the built card labels do).
  const equipmentNames = new Map(
    getEquipment(profileId, { includeRetired: true }).map((e) => [e.id, e.name])
  );
  // Bodyweight series for the per-activity calorie ESTIMATE (issue #151). body_metrics
  // weigh-ins are a much smaller series than activity history and are consumed
  // server-side only (they build the card's kcal chip; they don't cross the wire).
  const weights: DatedWeight[] = getWeights(profileId).map((w) => ({
    date: w.date,
    weightKg: w.weight_kg,
  }));

  // The conditions stamps (#1728): the cached daily weather for the days this page's
  // activities fall on, read ONCE for the page's date span rather than per card. The
  // cache is global and location-keyed, so a profile with no home location simply gets
  // an empty map and no card is stamped.
  const pageDates = page.activities.map((a) => a.date).sort();
  const weatherByDate = new Map<
    string,
    { tempMaxC: number | null; weatherCode: number | null }
  >();
  if (pageDates.length > 0) {
    for (const d of getWeatherDaysForProfile(
      profileId,
      pageDates[0],
      pageDates[pageDates.length - 1]
    )) {
      weatherByDate.set(d.date, {
        tempMaxC: d.tempMaxC,
        weatherCode: d.weatherCode,
      });
    }
  }

  const groups = buildTrainingLogCards({
    activities: page.activities,
    sets,
    equipmentNames,
    weights,
    units,
    formatPrefs,
    // "Today"/"Yesterday" labels relative to the calendar/db notion of today.
    today: todayFn(profileId),
    yesterday: yesterdayFn(profileId),
    routes,
    activeCalories,
    zoneModel: getProfileZoneModel(profileId),
    activityVideos,
    weatherByDate,
  });

  return { groups, nextBefore: page.nextBefore };
}

// Assemble the MULTI-VIEW Training Log feed (issue #1330): the newest window of each
// in-view member's cards, merged into ONE day-grouped feed with every card stamped
// with its subject profile (activity.subjectProfileId). Loop-composed — each member's
// window is built by the per-profile buildTrainingLogFeedPage (with THAT member's own
// today/yesterday labels, route/video/equipment gathers) — then merged and RE-LABELED
// by the viewer's (acting) clock so a date reads one way in the merged feed (the
// per-profile-context rule, mergeTrainingLogDayGroups). Multi-view is a recent-window
// overview: only the newest page per member is gathered (no cross-member "Load more"
// cursor), so the page passes initialCursor=null and hides the pager. The server
// component then stamps subject NAME/photo/access identity (lib/scope stampSubjects)
// and each member's own restriction onto the cards. In single view the caller uses
// buildTrainingLogFeedPage directly, so nothing here touches the single-profile path.
//
// FILTERS (issue #1634) compose with the per-member cursors rather than assuming a
// single one: each member's OWN newest window of MATCHING days is built by the
// per-profile assembler above (its own preimages, its own labels) and the merge is
// unchanged, so two members' matches interleave by date exactly as their unfiltered
// cards do. The merged feed still has no cross-member pager — it is a recent-window
// overview — so what a filter changes is which days each member contributes, not how
// paging works.
export function buildMultiViewTrainingLogGroups(
  viewIds: readonly number[],
  actingProfileId: number,
  units: UnitPrefs,
  formatPrefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS,
  filters: TrainingLogFilters = EMPTY_TRAINING_LOG_FILTERS
): DayGroup[] {
  const members = viewIds.map((profileId) => ({
    profileId,
    groups: buildTrainingLogFeedPage(
      profileId,
      null,
      units,
      formatPrefs,
      TRAINING_LOG_PAGE_DAYS,
      filters
    ).groups,
  }));
  const today = todayFn(actingProfileId);
  const yesterday = yesterdayFn(actingProfileId);
  return mergeTrainingLogDayGroups(members, (date) =>
    date === today
      ? "Today"
      : date === yesterday
        ? "Yesterday"
        : formatLongDate(date, formatPrefs)
  );
}

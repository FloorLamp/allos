// Assemble ONE page of the Journal feed's day-grouped cards (issue #451). The Journal
// used to load the profile's ENTIRE activity history (getActivities, SELECT * incl.
// the components TEXT) and page it client-side, so the whole history crossed the wire
// and hydrated on every Training → Log visit. This is the server-side window: the
// initial render (HistorySection) and the "Load more" server action (journal/actions)
// both call THIS one assembler, so both build identical cards for a given window —
// "one question, one computation". Only the built DayGroups (not raw history) cross to
// the client. Not pure (reads DB + settings); takes the resolved profile + unit prefs.

import {
  getJournalPage,
  getSetsForActivities,
  getRoutePolylinesForActivities,
  getActiveCaloriesForActivities,
  getWeights,
} from "./queries";
import { getEquipment } from "./equipment";
import { buildJournalCards, type DayGroup } from "./journal-card";
import type { DatedWeight } from "./calorie-estimate";
import type { UnitPrefs } from "./settings";
import { today as todayFn, yesterday as yesterdayFn } from "./db";

// Days per page. Matches the client's 14-day reveal increment so a "Load more" click
// fetches roughly one screen of older history at a time.
export const JOURNAL_PAGE_DAYS = 14;

export interface JournalFeedPage {
  groups: DayGroup[];
  // Cursor for the next-older page (pass back as `before`), or null when exhausted.
  nextBefore: string | null;
}

// Build the day-grouped cards for the window ending just before `before` (null = the
// newest day). `dayLimit` days of activities are loaded, their sets fetched, and the
// pure buildJournalCards run over them — the same derivation HistorySection used to
// run inline over ALL activities.
export function buildJournalFeedPage(
  profileId: number,
  before: string | null,
  units: UnitPrefs,
  dayLimit: number = JOURNAL_PAGE_DAYS
): JournalFeedPage {
  const page = getJournalPage(profileId, before, dayLimit);
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

  const groups = buildJournalCards({
    activities: page.activities,
    sets,
    equipmentNames,
    weights,
    units,
    // "Today"/"Yesterday" labels relative to the calendar/db notion of today.
    today: todayFn(profileId),
    yesterday: yesterdayFn(profileId),
    routes,
    activeCalories,
  });

  return { groups, nextBefore: page.nextBefore };
}

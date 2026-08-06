import { weekWindowStart } from "../profile-week";
import { CARDIO_ACTIVITIES, SPORTS } from "../../activities-catalog";
import {
  buildCompanionMap,
  type CompanionMap,
  type CompanionRow,
} from "../../companions";
import { shiftDateStr } from "../../date";
import {
  inferWeeklyRhythm,
  predictedOnDay,
  RHYTHM_WINDOW_WEEKS,
  type WeeklyRhythm,
} from "../../weekly-rhythm";
import { db, today } from "../../db";
import { decayedWeight } from "../../decay";
import {
  LIFT_OPTIONS,
  baseLiftName,
  muscleFor,
  regionForExercise,
} from "../../lifts";
import {
  storedActivityFault,
  type StoredActivity,
  type StoredSet,
} from "../../activity-validate";
import {
  activityProvenanceKey,
  JOURNAL_SOURCE_DOCUMENT,
  JOURNAL_SOURCE_MANUAL,
} from "../../journal-format";
import type { JournalFilters } from "../../journal-filters";
import { likePattern } from "../../search-projections";
import { DOCUMENT_SOURCE_PREFIX } from "../../body-metric-extract";
import {
  rankByFrequency,
  prioritizeRoutineSlots,
} from "../../rank-by-frequency";
import { getActiveRoutine } from "../../routines";
import { resolveTodayRoutineDayIndex } from "../../workout-recommendation";
import type { ActivityEditData } from "../../activity-form-model";
import { pickImportedActivityMetrics } from "../../activity-import-details";
import type { Activity, ActivityType, ExerciseSet } from "../../types";
import { getLatestBodyMetricDated } from "../metrics";
import { cache, effortNameCounts, recentWindowStart } from "./common";

export interface ActivitySuggestions {
  lifts: string[];
  cardio: string[];
  sports: string[];
  // Per-lift co-occurrence: base-name (lowercased) -> top co-logged lifts, used
  // to bias the combobox toward companions of the draft's exercises (issue #195).
  liftCompanions: CompanionMap;
}

// The base-collapsed exercise names prescribed by TODAY'S resolved routine day (#1115
// Fix C): every candidate of every slot on the day the rotation cursor points at,
// de-duplicated in slot order. Base-collapsed (baseLiftName) so they line up with the
// picker's grouped base names. Empty when there's no active routine / no days — the
// picker then keeps its plain frequency order. Reuses the SAME resolveTodayRoutineDayIndex
// the recommendation core and crediting path share (#831), so "today's day" can't fork.
function todayRoutineSlotNames(profileId: number): string[] {
  const routine = getActiveRoutine(profileId);
  if (!routine) return [];
  const idx = resolveTodayRoutineDayIndex({
    position: routine.position,
    days: routine.days,
  });
  if (idx === null) return [];
  const day = routine.days[idx];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const slot of day.slots) {
    for (const cand of slot.candidates) {
      const base = baseLiftName(cand);
      const key = base.toLowerCase();
      if (base && !seen.has(key)) {
        seen.add(key);
        names.push(base);
      }
    }
  }
  return names;
}

// cache(): the app layout resolves suggestions on every navigation, and a request
// may render this more than once — cache() collapses those to a single scan per
// request (a no-op outside a request, e.g. the notify process, where it just runs).
export const getActivitySuggestions = cache(function getActivitySuggestions(
  profileId: number
): ActivitySuggestions {
  const t = today(profileId);
  const since = recentWindowStart(profileId);
  // Per-name × date rows so each occurrence can be recency-weighted (issue #195):
  // a set logged today counts 1.0, ~60 days ago 0.5, so a recent habit outranks
  // a stale one. Still bounded to the 12-month recent window.
  const rawLiftRows = db
    .prepare(
      `SELECT s.exercise AS name, a.date AS date, COUNT(*) AS c
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND a.date >= ?
       GROUP BY s.exercise, a.date`
    )
    .all(profileId, since) as {
    name: string;
    date: string;
    c: number;
  }[];
  // Collapse variant names ("Dumbbell Curl") to their base ("Curl") so the
  // picker offers the grouped base and ranks it by combined (decayed) usage;
  // equipment is then chosen with chips.
  const liftCounts = new Map<string, { name: string; c: number }>();
  for (const r of rawLiftRows) {
    const name = baseLiftName(r.name);
    const key = name.toLowerCase();
    const w = r.c * decayedWeight(r.date, t);
    const prev = liftCounts.get(key);
    if (prev) prev.c += w;
    else liftCounts.set(key, { name, c: w });
  }
  const liftRows = [...liftCounts.values()];

  // Co-occurrence: the distinct exercises per activity (one row each), fed to
  // the pure companion builder (base-collapsed, decayed, top-5 capped). The
  // GROUP BY makes each (activity, exercise) distinct, so set multiplicity
  // doesn't inflate a pairing. Profile-scoped via the activities join.
  const companionRows = db
    .prepare(
      `SELECT s.activity_id AS activityId, a.date AS date, s.exercise AS exercise
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND a.date >= ?
       GROUP BY s.activity_id, s.exercise`
    )
    .all(profileId, since) as CompanionRow[];

  // Routine-aware picker order (#1115 Fix C): when an active routine resolves a day for
  // today, its prescribed slot exercises (+ their candidates) float to the FRONT of the
  // frequency-ranked lift list, so logging the session you're actually doing is a tap,
  // not a scroll. Off a routine, `routineSlotNames` is empty and the order is
  // byte-for-byte the frequency ranking. Names are base-collapsed to match the picker's
  // grouped base names. One more consumer of the already-resolved routine.
  const routineSlotNames = todayRoutineSlotNames(profileId);

  // Cardio/sport names come from the structured component names ("Running"), not
  // the freeform activity title ("Morning run"), so the picker suggests real
  // activity names rather than one-off session labels.
  return {
    lifts: prioritizeRoutineSlots(
      rankByFrequency(LIFT_OPTIONS, liftRows),
      routineSlotNames
    ),
    cardio: rankByFrequency(
      CARDIO_ACTIVITIES,
      effortNameCounts(profileId, "cardio")
    ),
    sports: rankByFrequency(SPORTS, effortNameCounts(profileId, "sport")),
    liftCompanions: buildCompanionMap(companionRows, t),
  };
});

// ---- Activities / Journal ----
// Omit `limit` to fetch the full history (the journal pages all activities
// client-side); pass a number to cap the result (e.g. dashboard previews).
export function getActivities(profileId: number, limit?: number): Activity[] {
  if (limit == null) {
    return db
      .prepare(
        "SELECT * FROM activities WHERE profile_id = ? ORDER BY date DESC, id DESC"
      )
      .all(profileId) as Activity[];
  }
  return db
    .prepare(
      "SELECT * FROM activities WHERE profile_id = ? ORDER BY date DESC, id DESC LIMIT ?"
    )
    .all(profileId, limit) as Activity[];
}

// The profile's session gear, most-recently-used first (issues #342/#339), used to
// DEFAULT the activity-level equipment picker on a new log — the same "last-used"
// convenience the strength implement picker has. Returns a de-duplicated, recency-
// ordered list of every equipment id linked to a past activity; the form's pure
// pickDefaultActivityEquipment then takes the first id that's a valid candidate for
// the CURRENT activity, so a run defaults to the last-used shoes and a ride to the
// last-used bike (the candidate set is narrowed per-activity — issue #339), each
// remembering its own gear rather than sharing one per-type slot. Profile-scoped.
export function getRecentActivityEquipmentIds(profileId: number): number[] {
  const rows = db
    .prepare(
      `SELECT equipment_id FROM activities
        WHERE profile_id = ? AND equipment_id IS NOT NULL
        ORDER BY date DESC, id DESC`
    )
    .all(profileId) as { equipment_id: number }[];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (!seen.has(r.equipment_id)) {
      seen.add(r.equipment_id);
      out.push(r.equipment_id);
    }
  }
  return out;
}

// The training week summary. NO STREAK FIELD (#1937): the "N-day streak" every
// consumer rendered sat directly beside `activeDays` for the same week, so "6 days
// active · 5-day streak" told one fact twice — and it was the less honest of the
// two, because the rest-tolerant activityStreak counted ACTIVE days with a rest-day
// of tolerance, so a Mon/Wed/Fri rhythm read "5-day streak" across a nine-day span.
// `activeDays` is accurate, already present, and already what the surfaces lead with.
export interface JournalWeekSummary {
  sessions: number; // activities logged in the profile's weekly window
  activeDays: number; // distinct days trained in the profile's weekly window
  volumeKg: number; // total weight × reps (both sides) in the profile's weekly window
}

export function getJournalWeekSummary(profileId: number): JournalWeekSummary {
  // "This week" per the profile's setting: the current calendar week (resetting
  // on the week-start day) or a rolling 7-day window.
  const since = weekWindowStart(profileId);
  const sessions = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND date >= ?`
      )
      .get(profileId, since) as { c: number }
  ).c;
  const activeDays = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT date) c FROM activities WHERE profile_id = ? AND date >= ?`
      )
      .get(profileId, since) as { c: number }
  ).c;
  const volumeKg = (
    db
      .prepare(
        `SELECT COALESCE(SUM(
            COALESCE(s.weight_kg, 0) * COALESCE(s.reps, 0)
          + COALESCE(s.weight_kg_right, 0) * COALESCE(s.reps_right, 0)), 0) v
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
         WHERE a.profile_id = ? AND a.date >= ?`
      )
      .get(profileId, since) as { v: number }
  ).v;
  return {
    sessions,
    activeDays,
    volumeKg,
  };
}

// Activities on or after `since` (YYYY-MM-DD, inclusive), newest first. The bounded
// counterpart to getActivities() for callers that only reduce a trailing window and
// don't need full history — e.g. the weekly recap's two 7-day windows (issue #389),
// which otherwise loaded every activity (SELECT *, including the components TEXT) to
// discard all but ~14 days. Streak math that DOES need full history uses the cheap
// getActivityDates instead.
export function getActivitiesSince(
  profileId: number,
  since: string
): Activity[] {
  return db
    .prepare(
      "SELECT * FROM activities WHERE profile_id = ? AND date >= ? ORDER BY date DESC, id DESC"
    )
    .all(profileId, since) as Activity[];
}

// One page of the Journal feed, windowed SERVER-SIDE by whole days (issue #451). The
// journal is browsed by recency, so paging by day (not by row) keeps a day's cards
// intact — a page never splits a single day across the boundary, so the client can
// append pages by plain concatenation. Keyset ("seek") pagination on `date`: pass the
// previous page's `nextBefore` as `before` to get the next-older window; null starts
// at the newest day. Bounded — at most `dayLimit` days' activities cross the wire per
// call, instead of the profile's entire history (SELECT *, incl. the components TEXT)
// on every visit. `nextBefore` is the oldest loaded date when more days remain (an
// over-fetch of one extra date decides this without a phantom trailing page), else
// null. Profile-scoped on both statements.
export interface JournalPage {
  activities: Activity[]; // every activity on the returned days, date DESC, id DESC
  days: string[]; // the distinct dates covered, date DESC
  nextBefore: string | null; // cursor for the next-older page, or null when exhausted
}

// The SQL-shaped form of the feed's active filters (issue #1634) — what
// resolveJournalFilterSpec() turns a JournalFilters into once per request. Every
// field is already reduced to something a WHERE clause can use: the derived filters
// (muscle/region tag, fault) arrive as finite PREIMAGES resolved in JS, because
// regionForExercise() and storedActivityFault() are pure TypeScript that SQLite
// cannot run (the #394 pattern, as getPracticeSpellings does for spelling families).
//
// `null` on a field means "this filter is not active". An EMPTY preimage array
// means "active, and nothing in the ledger can match" — the page is empty, which is
// very different from absent; keep the two apart.
export interface JournalFilterSpec {
  query: string | null; // free text (already trimmed), matched by LIKE
  type: ActivityType | null;
  source: string | null; // a provenance KEY (activityProvenanceKey)
  // Lowercased exercise names whose muscle/region is the selected tag.
  tagExercises: readonly string[] | null;
  // Activity ids whose storedActivityFault() is non-null.
  faultIds: readonly number[] | null;
}

export const NO_JOURNAL_FILTERS: JournalFilterSpec = {
  query: null,
  type: null,
  source: null,
  tagExercises: null,
  faultIds: null,
};

export function journalFilterSpecActive(spec: JournalFilterSpec): boolean {
  return (
    spec.query != null ||
    spec.type != null ||
    spec.source != null ||
    spec.tagExercises != null ||
    spec.faultIds != null
  );
}

// The `source` half of the WHERE clause for a provenance KEY. Mirrors
// activityProvenanceKey()'s collapse in SQL: 'manual' covers NULL and the literal
// 'manual'; 'document' covers every 'document:<id>' row; anything else is the raw
// integration id stored on the row.
function journalSourceClause(key: string): { sql: string; params: unknown[] } {
  if (key === JOURNAL_SOURCE_MANUAL)
    return { sql: "(a.source IS NULL OR a.source = 'manual')", params: [] };
  if (key === JOURNAL_SOURCE_DOCUMENT)
    return {
      // Prefix match — DOCUMENT_SOURCE_PREFIX carries no LIKE wildcards itself.
      sql: "a.source LIKE ?",
      params: [`${DOCUMENT_SOURCE_PREFIX}%`],
    };
  return { sql: "a.source = ?", params: [key] };
}

// Build the shared `AND …` fragments + params for a filter spec. Used by the day
// scan below; deliberately a SUPERSET of the pure card predicate
// (lib/journal-filters.ts) — see that module's superset contract.
function journalFilterSql(spec: JournalFilterSpec): {
  sql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (spec.type != null) {
    clauses.push("a.type = ?");
    params.push(spec.type);
  }
  if (spec.source != null) {
    const s = journalSourceClause(spec.source);
    clauses.push(s.sql);
    params.push(...s.params);
  }
  if (spec.faultIds != null) {
    if (spec.faultIds.length === 0) return { sql: " AND 0", params: [] };
    clauses.push(`a.id IN (${spec.faultIds.map(() => "?").join(",")})`);
    params.push(...spec.faultIds);
  }
  if (spec.tagExercises != null) {
    if (spec.tagExercises.length === 0) return { sql: " AND 0", params: [] };
    clauses.push(
      `EXISTS (SELECT 1 FROM exercise_sets s WHERE s.activity_id = a.id
                 AND LOWER(TRIM(s.exercise)) IN (${spec.tagExercises
                   .map(() => "?")
                   .join(",")}))`
    );
    params.push(...spec.tagExercises);
  }
  if (spec.query != null) {
    const like = likePattern(spec.query);
    // The three places the card's free text comes from: the activity title, the
    // exercise names of its sets (the legacy/strength part names), and the names
    // inside its stored components JSON (cardio/sport part names). json_each is
    // guarded by json_valid because a present-but-unparseable `components` string
    // is a real stored state (the card layer treats it as an empty list) and
    // json_each would raise on it.
    clauses.push(
      `(a.title LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM exercise_sets s WHERE s.activity_id = a.id
                     AND s.exercise LIKE ? ESCAPE '\\')
        OR (a.components IS NOT NULL AND json_valid(a.components)
            AND EXISTS (SELECT 1 FROM json_each(a.components) je
                          WHERE json_extract(je.value, '$.name') LIKE ? ESCAPE '\\')))`
    );
    params.push(like, like, like);
  }
  return {
    sql: clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`,
    params,
  };
}

export function getJournalPage(
  profileId: number,
  before: string | null,
  dayLimit: number,
  spec: JournalFilterSpec = NO_JOURNAL_FILTERS
): JournalPage {
  const limit = Math.max(1, dayLimit);
  const filter = journalFilterSql(spec);
  // Over-fetch one extra date so we can tell whether an older page exists without
  // issuing a separate count (or a trailing page that comes back empty). Under a
  // filter the scan selects the days that CONTAIN a match across the whole ledger,
  // so `nextBefore` pages over MATCHES, not over raw days (issue #1634).
  const dateRows = db
    .prepare(
      `SELECT DISTINCT a.date AS date FROM activities a
        WHERE a.profile_id = ?${before == null ? "" : " AND a.date < ?"}${filter.sql}
        ORDER BY a.date DESC LIMIT ?`
    )
    .all(
      profileId,
      ...(before == null ? [] : [before]),
      ...filter.params,
      limit + 1
    ) as {
    date: string;
  }[];

  const hasMore = dateRows.length > limit;
  const days = dateRows.slice(0, limit).map((r) => r.date);
  if (days.length === 0) return { activities: [], days: [], nextBefore: null };

  // EVERY activity on the selected days — including, under a filter, the ones that
  // do NOT match. Deliberate: the filter selects DAYS here and the pure card
  // predicate (journalCardMatches) selects CARDS within them, and the card layer
  // needs a day's full row set anyway for the manual-merge sibling picker, which
  // must keep offering a same-day duplicate a search would otherwise hide (#64).
  const placeholders = days.map(() => "?").join(",");
  const activities = db
    .prepare(
      `SELECT * FROM activities WHERE profile_id = ? AND date IN (${placeholders})
         ORDER BY date DESC, id DESC`
    )
    .all(profileId, ...days) as Activity[];

  return {
    activities,
    days,
    nextBefore: hasMore ? days[days.length - 1] : null,
  };
}

// ---- Journal filter preimages (issue #1634) ----

// The profile's distinct exercise names, as stored. Small (dozens–hundreds even for
// a long history) and the input to the tag preimage below. cache(): a request that
// resolves the tag filter and re-renders would otherwise re-scan it.
const distinctExerciseNames = cache(function distinctExerciseNames(
  profileId: number
): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT s.exercise AS exercise
           FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
          WHERE a.profile_id = ?`
      )
      .all(profileId) as { exercise: string }[]
  ).map((r) => r.exercise);
});

// The FINITE PREIMAGE of a muscle/region badge: which of the profile's own exercise
// names map to it (issue #1634, the #394 pattern). regionForExercise/muscleFor are
// pure TypeScript with a loose contains-fallback, so they cannot be expressed in
// SQL — and the catalog alone is not the preimage either, because a user's free-text
// exercise name still resolves through that fallback. So the mapping is evaluated in
// JS over the names the profile ACTUALLY logged, and the result becomes an IN-list.
// Bounded by the distinct-name count, resolved once per request.
export function getJournalTagExercises(
  profileId: number,
  tag: { kind: "muscle" | "region"; value: string }
): string[] {
  const out = new Set<string>();
  for (const name of distinctExerciseNames(profileId)) {
    const hit =
      tag.kind === "muscle"
        ? muscleFor(name) === tag.value
        : regionForExercise(name) === tag.value;
    if (hit) out.add(name.trim().toLowerCase());
  }
  return [...out];
}

// Every activity the editor could NOT re-save as-is, by id, with the total count —
// the honest backing for the "Can't be saved" filter AND its badge. Before #1634
// both were derived from the LOADED pages, so a faulty row in an unfetched window
// neither showed up nor was counted (and, with no fault on page one, the toggle did
// not render at all — the filter was unreachable).
//
// COST. storedActivityFault() is a pure judgment over the row plus its sets, so this
// walks the profile's activities and exercise_sets once. That is the SAME shape of
// scan the Journal page already pays for its analytics side panel
// (getStrengthByExercise reads every non-warmup set of the profile), so it does not
// change the surface's cost class — and cache() collapses it to one pass per request
// no matter how many callers ask.
export interface ActivityFaults {
  ids: number[]; // faulty activity ids, newest day first
  count: number;
}

export const getActivityFaults = cache(function getActivityFaults(
  profileId: number
): ActivityFaults {
  const rows = db
    .prepare(
      `SELECT id, type, title, start_time, end_time, components,
              distance_km, duration_min
         FROM activities WHERE profile_id = ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId) as (StoredActivity & { id: number })[];
  const setRows = db
    .prepare(
      `SELECT s.activity_id AS activityId, s.exercise, s.weight_kg, s.reps,
              s.weight_kg_right, s.reps_right, s.duration_sec,
              s.duration_sec_right, s.equipment_id
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ?
        ORDER BY s.activity_id, s.set_number`
    )
    .all(profileId) as (StoredSet & { activityId: number })[];
  const byActivity = new Map<number, StoredSet[]>();
  for (const s of setRows) {
    const arr = byActivity.get(s.activityId);
    if (arr) arr.push(s);
    else byActivity.set(s.activityId, [s]);
  }
  const ids: number[] = [];
  for (const a of rows) {
    if (storedActivityFault(a, byActivity.get(a.id) ?? []) != null)
      ids.push(a.id);
  }
  return { ids, count: ids.length };
});

// The provenance KEYS present in this profile's ledger, for the source filter's
// option list (issue #1634). A distinct-scan collapsed through the SAME
// activityProvenanceKey the card chips and the pure predicate use, so every provider
// is exactly one option and 'document:<id>' rows don't fan out into one option per
// uploaded file. Manual first, then the rest alphabetically by key — a stable order
// that doesn't shuffle as history grows. cache(): one scan per request.
export const getJournalSourceKeys = cache(function getJournalSourceKeys(
  profileId: number
): string[] {
  const rows = db
    .prepare("SELECT DISTINCT source FROM activities WHERE profile_id = ?")
    .all(profileId) as { source: string | null }[];
  const keys = new Set(rows.map((r) => activityProvenanceKey(r.source)));
  const rest = [...keys].filter((k) => k !== JOURNAL_SOURCE_MANUAL).sort();
  return keys.has(JOURNAL_SOURCE_MANUAL)
    ? [JOURNAL_SOURCE_MANUAL, ...rest]
    : rest;
});

// Turn the feed's user-facing filters into the SQL-shaped spec, resolving the two
// derived filters against this profile's own data. Called ONCE per feed request (the
// page assembler), never per render.
export function resolveJournalFilterSpec(
  profileId: number,
  filters: JournalFilters
): JournalFilterSpec {
  const query = filters.query.trim();
  return {
    query: query === "" ? null : query,
    type: filters.type,
    source: filters.source,
    tagExercises: filters.tag
      ? getJournalTagExercises(profileId, filters.tag)
      : null,
    faultIds: filters.faultOnly ? getActivityFaults(profileId).ids : null,
  };
}

export function getActivitiesByDate(
  profileId: number,
  date: string
): Activity[] {
  return db
    .prepare(
      "SELECT * FROM activities WHERE profile_id = ? AND date = ? ORDER BY id DESC"
    )
    .all(profileId, date) as Activity[];
}

export function getActivityDates(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT DISTINCT date FROM activities WHERE profile_id = ? ORDER BY date DESC"
      )
      .all(profileId) as { date: string }[]
  ).map((r) => r.date);
}

// The inferred training cadence — the shared weekly-rhythm shape (see
// lib/weekly-rhythm.ts, which owns the window/gate/fallback thresholds this and
// the practice inference both key on). The historical name survives for its many
// consumers.
export type InferredWorkoutSchedule = WeeklyRhythm;

// Derive the user's regular training cadence from recent history, so the workout
// reminder fires around when they normally train: the weekdays trained on often
// enough, and the most common start hour. Falls back to every day at 18:00 when
// there's no clear pattern. A thin SQL gather over the shared inference core
// (#2188) — the thresholds live in lib/weekly-rhythm.ts, not here.
export function inferWorkoutSchedule(
  profileId: number,
  weeks = RHYTHM_WINDOW_WEEKS
): InferredWorkoutSchedule {
  const rows = db
    .prepare(
      `SELECT date, start_time FROM activities WHERE profile_id = ? AND date >= ?`
    )
    .all(profileId, shiftDateStr(today(profileId), -weeks * 7)) as {
    date: string;
    start_time: string | null;
  }[];
  return inferWeeklyRhythm(
    rows.map((r) => ({ date: r.date, time: r.start_time })),
    { weeks }
  );
}

// Whether `date` should be a training day for this profile, per the inferred
// cadence (issue #558). Returns `null` when no cadence can be inferred — the
// caller then falls back to "was a workout actually logged" rather than guessing.
// This is the "today SHOULD be a workout day" signal a pre-workout supplement
// reminder needs (so it can fire in the morning, before the session), reusing the
// same inferWorkoutSchedule the notify tick's workout reminder consumes ("one
// question, one computation").
export function isPredictedWorkoutDay(
  profileId: number,
  date: string,
  weeks = RHYTHM_WINDOW_WEEKS
): boolean | null {
  return predictedOnDay(inferWorkoutSchedule(profileId, weeks), date);
}

// (date, exercise) rows over the recent window — one scan that powers the workout
// recommendation (yesterday's regions, the per-weekday pattern, exercise frequency).
export function getRecentDatedExercises(
  profileId: number,
  days = 56
): { date: string; exercise: string }[] {
  return db
    .prepare(
      `SELECT a.date AS date, s.exercise AS exercise
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND a.date >= ?
       ORDER BY a.date DESC`
    )
    .all(profileId, shiftDateStr(today(profileId), -days)) as {
    date: string;
    exercise: string;
  }[];
}

// Sets belong to a profile only through their parent activity, so the ids (which
// arrive from forms) are filtered via a join on activities.profile_id — a set id
// from another profile is silently dropped rather than trusted.
export function getSetsForActivities(
  profileId: number,
  ids: number[]
): ExerciseSet[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT s.* FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND s.activity_id IN (${placeholders})
       ORDER BY s.exercise, s.set_number`
    )
    .all(profileId, ...ids) as ExerciseSet[];
}

// The encoded GPS route polyline for each of `ids` that has one (issue #569),
// returned as activityId -> polyline. Profile-scoped through the activities JOIN
// (activity_routes carries no profile_id of its own). Feeds the Journal card's
// tile-free SVG route thumbnail; only activities with a captured route appear.
export function getRoutePolylinesForActivities(
  profileId: number,
  ids: number[]
): Map<number, string> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT r.activity_id, r.polyline
         FROM activity_routes r JOIN activities a ON a.id = r.activity_id
        WHERE a.profile_id = ? AND r.activity_id IN (${placeholders})`
    )
    .all(profileId, ...ids) as { activity_id: number; polyline: string }[];
  return new Map(rows.map((r) => [r.activity_id, r.polyline]));
}

// Device active energy is stored as a metric_sample rather than on activities.
// New samples carry the activity's stable provider identity, so user edits to
// date/clock fields and profile timezone changes cannot break the association.
// The window matcher below remains only for pre-migration samples that have not
// yet been backfilled or seen in a provider re-sync.
export function getActiveCaloriesForActivities(
  profileId: number,
  activities: Activity[]
): Map<number, number> {
  const linkedCandidates = activities.filter(
    (activity) => activity.source && activity.external_id
  );
  const linked = new Map<number, number>();
  if (linkedCandidates.length > 0) {
    const externalIds = [
      ...new Set(linkedCandidates.map((activity) => activity.external_id!)),
    ];
    const placeholders = externalIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT source, activity_external_id, value
           FROM metric_samples
          WHERE profile_id = ? AND metric = 'active_kcal'
            AND activity_external_id IN (${placeholders})`
      )
      .all(profileId, ...externalIds) as {
      source: string;
      activity_external_id: string;
      value: number;
    }[];
    const byIdentity = new Map(
      rows.map((row) => [
        `${row.source}\0${row.activity_external_id}`,
        row.value,
      ])
    );
    for (const activity of linkedCandidates) {
      const value = byIdentity.get(
        `${activity.source!}\0${activity.external_id!}`
      );
      if (value != null) linked.set(activity.id, value);
    }
  }

  const legacyCandidates = activities.filter(
    (activity) =>
      !linked.has(activity.id) &&
      activity.source === "strava" &&
      activity.start_time &&
      activity.end_time
  );
  if (legacyCandidates.length === 0) return linked;
  const dates = legacyCandidates.map((activity) => activity.date).sort();
  const rows = db
    .prepare(
      `SELECT source, date, start_time, end_time, value
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'active_kcal'
          AND source = 'strava'
          AND activity_external_id IS NULL
          AND date BETWEEN ? AND ?`
    )
    .all(profileId, dates[0], dates[dates.length - 1]) as {
    source: string;
    date: string;
    start_time: string;
    end_time: string;
    value: number;
  }[];
  const storedClock = (value: string): string =>
    /T(\d{2}:\d{2})/.exec(value)?.[1] ?? value.slice(0, 5);
  // Only Strava has a safe window fallback: its old sample timestamps encode the
  // same local wall-clock numerals stored on the activity. Health Connect and Oura
  // legacy rows are linked by migration 035; projecting their remaining null-link
  // instants through the profile's mutable timezone would recreate the bug this
  // stable identity column fixes.
  const sampleKey = (
    source: string,
    date: string,
    start: string,
    end: string
  ): string => `${source}\0${date}\0${storedClock(start)}\0${storedClock(end)}`;
  const activityKey = (
    source: string,
    date: string,
    start: string,
    end: string
  ): string => `${source}\0${date}\0${storedClock(start)}\0${storedClock(end)}`;
  const byWindow = new Map(
    rows.map((row) => [
      sampleKey(row.source, row.date, row.start_time, row.end_time),
      row.value,
    ])
  );
  for (const activity of legacyCandidates) {
    const value = byWindow.get(
      activityKey(
        activity.source!,
        activity.date,
        activity.start_time!,
        activity.end_time!
      )
    );
    if (value != null) linked.set(activity.id, value);
  }
  return linked;
}

// The single most recent activity as an ActivityEditData (issue #337): the seed
// for a "Repeat last activity" command palette entry / mobile quick action, so
// repeat-last isn't desktop-only. Newest by (date, id); null when nothing is
// logged. Profile-scoped; its sets come through getSetsForActivities (also
// scoped). Mirrors buildJournalCards' editData mapping so the repeated draft is
// identical whichever surface launched it.
// Map an activity row (+ its scoped sets) to the ActivityEditData the editor
// consumes. Shared by getMostRecentActivityEditData and getActivityEditData so a
// repeated/resumed draft is identical whichever surface launched it.
export function activityToEditData(
  profileId: number,
  a: Activity
): ActivityEditData {
  const sets = getSetsForActivities(profileId, [a.id]);
  return {
    id: a.id,
    type: a.type,
    title: a.title,
    date: a.date,
    duration_min: a.duration_min,
    elapsed_min: a.elapsed_min,
    distance_km: a.distance_km,
    intensity: a.intensity,
    start_time: a.start_time,
    end_time: a.end_time,
    components: a.components,
    notes: a.notes,
    source: a.source,
    edited: a.edited,
    created_at: a.created_at,
    updated_at: a.updated_at,
    est_calories: a.est_calories,
    equipment_id: a.equipment_id,
    imported_metrics: pickImportedActivityMetrics(a),
    sets: sets.map((s) => ({
      exercise: s.exercise,
      set_number: s.set_number,
      weight_kg: s.weight_kg,
      reps: s.reps,
      weight_kg_right: s.weight_kg_right,
      reps_right: s.reps_right,
      duration_sec: s.duration_sec,
      duration_sec_right: s.duration_sec_right,
      equipment_id: s.equipment_id,
      target_reps: s.target_reps,
      to_failure: s.to_failure,
      warmup: s.warmup,
      rpe: s.rpe,
    })),
  };
}

// The profile-scoped stored activity row behind detail readers. Keeping this
// lookup beside the editor mapping lets read-first activity surfaces share the
// exact row and edit payload without reaching around the query boundary.
export function getActivityById(
  profileId: number,
  activityId: number
): Activity | null {
  return (
    (db
      .prepare(`SELECT * FROM activities WHERE id = ? AND profile_id = ?`)
      .get(activityId, profileId) as Activity | undefined) ?? null
  );
}

export function getMostRecentActivityEditData(
  profileId: number
): ActivityEditData | null {
  const a = db
    .prepare(
      `SELECT * FROM activities WHERE profile_id = ?
        ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(profileId) as Activity | undefined;
  return a ? activityToEditData(profileId, a) : null;
}

// The ActivityEditData for a specific activity (#921) — the workout dock reopens a
// live session by id, hydrated from the persisted #451 draft. Profile-scoped;
// null when the id isn't this profile's.
export function getActivityEditData(
  profileId: number,
  activityId: number
): ActivityEditData | null {
  const a = getActivityById(profileId, activityId);
  return a ? activityToEditData(profileId, a) : null;
}

export function getDashboardStats(profileId: number) {
  const activityCount = (
    db
      .prepare("SELECT COUNT(*) c FROM activities WHERE profile_id = ?")
      .get(profileId) as { c: number }
  ).c;
  // Hard rolling 7-day window (today + the prior 6 days) behind the "Activities
  // (7d)" tile. This is intentionally NOT the journal week summary, which is now
  // week_mode-aware (lib/week-window.ts, #223) — the tile's label says "7d", so
  // keep the fixed window and don't "align" the two.
  const last7 = (
    db
      .prepare(
        "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND date >= ?"
      )
      .get(profileId, shiftDateStr(today(profileId), -6)) as { c: number }
  ).c;
  // Current weight routed through the canonical reconciled reader so it honors the
  // profile's primary-source priority (#14) — the same value the passport, goals,
  // and strength bodyweight calcs show. A raw newest-row query here silently
  // disagreed with every other "current weight" surface (#302); one question, one
  // computation.
  const latestWeight = getLatestBodyMetricDated(profileId, "weight");
  const activeGoals = (
    db
      .prepare(
        "SELECT COUNT(*) c FROM goals WHERE profile_id = ? AND status = 'active' AND archived = 0"
      )
      .get(profileId) as { c: number }
  ).c;
  return { activityCount, last7, latestWeight, activeGoals };
}

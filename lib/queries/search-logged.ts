// SEARCH INTO THE RECORD (#5006) — the seven row-only Logs kinds, as ONE search group.
//
// The record's other domains are ENTITIES with a page of their own, so a hit lands on
// that page. These seven are ROWS: a serving, a dose, a session, a symptom-day, a
// check-in, a reading, a night. They have no page, and #3958 already gave every one of
// them a stable address — `/history?day=<day>&kind=<kind>` opens the day scoped to the
// kind, and the row carries `id={timelineEntryAnchorId(row.id)}` — so the hit's href is
// that address with the row's own anchor as the fragment. No new route, no new page.
//
// ONE GROUP, CAPPED AT FIVE ACROSS ALL SEVEN KINDS (owner ruling, 2026-09-04). Every
// hit carries the single `logged` domain and names its kind in the SUBTITLE
// (`<kind> · <date>`), so the palette shows the five newest rows you logged whatever
// mix of kinds they are — not five of each. Each source still reads its own five
// newest, which is enough: no row outside a source's newest five can be inside the
// union's newest five. The ranker does the rest (`rankAndGroup`, lib/search-rank.ts),
// sorting the union date-first and slicing to five.
//
// ONE SHAPE, SEVEN DECLARATIONS. Every source hands back the same `LoggedEntry`
// (the record row's own id, its title, the profile-local day it is filed under) and
// declares only what differs: the kind, the noun its subtitle names, and the read that
// finds it. `loggedHit` builds the hit — key, subtitle, href, date — once, for all
// seven, so an eighth kind is a table row and not a seventh copy of one idea.
//
// THE ENTRY ID IS THE RECORD'S, NOT A NEW ONE. `dose:<id>`, `food:<id>`,
// `practice:<id>`, `symptom:<day>:<symptom>`, `mood:<id>`, `body:<column>:<id>`,
// `sleep:<wakeDay>` are the ids lib/history.ts composes its rows with, and the anchor
// is built from them by the same `timelineEntryAnchorId` the row's `id=` is built with.
// A spelling that drifts here is a link that scrolls nowhere, which is why
// lib/__db_tests__/search-logged-kinds.test.ts resolves every href against the gather's
// own rows rather than against a re-typed string.
//
// EVERY READ IS PROFILE-SCOPED IN SQL, spelled `profile_id = ?` in the statement text
// (the dose ledger through its parent `intake_items`, which is where a dose log's owner
// lives) — never filtered afterwards in TypeScript. The day view is acting-profile-only
// by ruling, and these hits are doors onto it.

import { db, today } from "../db";
import { zonedDateParts } from "../date";
import { getTimezone } from "../settings";
import { getDisplayFormatPrefs } from "../settings/display";
import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "../format-date";
import { historyHref, type AppRoute } from "../hrefs";
import { timelineEntryAnchorId } from "../timeline-format";
import { normalizePracticeName } from "../practice";
import { searchMoodDays } from "./mood";
import { FOOD_GROUPS, foodGroupBySlug } from "../food-groups";
import { SYMPTOMS, symptomLabel } from "../symptoms";
import { ALCOHOL_FOOD_GROUP } from "../substance-use";
import {
  BODY_METRIC_COLUMNS,
  BODY_METRIC_MEASURE_SLUG,
  type BodyMetricRow,
} from "../body-metric-measures";
import { TREND_METRIC_META } from "../trend-metrics";
import { matchTier, type SearchHit } from "../search-rank";
import type { HistoryKind } from "../history-format";

/**
 * Each source's read bound, and the group's cap: five.
 *
 * `as const satisfies readonly HistoryKind[]` is the whole guard on the kinds — a kind
 * that is not one of the record's own is a type error here rather than a hit whose
 * `?kind=` opens on nothing.
 */
const LOGGED_ENTRY_LIMIT = 5;

const SEARCH_LOGGED_KINDS = [
  "dose",
  "food",
  "practice",
  "symptom",
  "mood",
  "body",
  "sleep",
] as const satisfies readonly HistoryKind[];

export type SearchLoggedKind = (typeof SEARCH_LOGGED_KINDS)[number];

/** One record row, as every source hands it back. */
interface LoggedEntry {
  /** The id lib/history.ts gives this row — the anchor is built from it. */
  entryId: string;
  /** The row's own title, exactly as the record prints it. */
  title: string;
  /** The PROFILE-LOCAL day the row is filed under; never a sliced UTC instant. */
  day: string;
}

interface LoggedQuery {
  /** The raw typed query, for catalog-label matching. */
  query: string;
  /** The escaped `%…%` pattern, for the SQL LIKE. */
  like: string;
}

interface LoggedSource {
  kind: SearchLoggedKind;
  /** The singular noun the subtitle leads with — the record's word for one row. */
  noun: string;
  read: (profileId: number, q: LoggedQuery) => LoggedEntry[];
}

// A `?`-list for an IN clause, or `(NULL)` for the empty set — which matches nothing,
// never everything, and stays valid SQL (the lib/cross-profile.ts shape).
function inList(count: number): string {
  return count === 0 ? "(NULL)" : `(${Array(count).fill("?").join(",")})`;
}

// The catalog slugs whose DISPLAY name answers the query. Food groups and symptoms
// both store a slug and render a curated label, so "leafy greens" and "shortness of
// breath" have to reach rows stored as `leafy_greens` and `shortness-of-breath`. The
// stored column is still LIKE-matched beside this, which is what keeps a row logged
// under a retired or custom key findable by the key it carries.
function slugsNamed(
  entries: readonly { slug: string; label: string }[],
  query: string
): string[] {
  return entries
    .filter((entry) => matchTier(entry.label, query) > 0)
    .map((entry) => entry.slug);
}

// ── The seven reads ────────────────────────────────────────────────────────

// Doses: the item's name and the amount taken, over the ledger the record reads —
// `status = 'taken'`, scoped through the item's own profile.
function doseEntries(profileId: number, q: LoggedQuery): LoggedEntry[] {
  const rows = db
    .prepare(
      `SELECT l.id AS id, l.date AS day, s.name AS title
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ?
          AND l.status = 'taken'
          AND (s.name LIKE ? ESCAPE '\\' OR l.amount LIKE ? ESCAPE '\\')
        ORDER BY l.date DESC, l.id DESC
        LIMIT ?`
    )
    .all(profileId, q.like, q.like, LOGGED_ENTRY_LIMIT) as {
    id: number;
    day: string;
    title: string;
  }[];
  return rows.map((r) => ({
    entryId: `dose:${r.id}`,
    title: r.title,
    day: r.day,
  }));
}

// Servings: the food group's name. The two exclusions are the record's own, so a hit
// can never open a day where its row is filed under another kind — reserved `__`
// observations are not servings, and a drink is a substance row (lib/history.ts).
function foodEntries(profileId: number, q: LoggedQuery): LoggedEntry[] {
  const named = slugsNamed(
    FOOD_GROUPS.map((g) => ({ slug: g.slug, label: g.name })),
    q.query
  );
  const rows = db
    .prepare(
      `SELECT id, group_key, date AS day
         FROM food_log_events
        WHERE profile_id = ?
          AND substr(group_key, 1, 2) != '__'
          AND group_key != ?
          AND (group_key LIKE ? ESCAPE '\\' OR group_key IN ${inList(named.length)})
        ORDER BY date DESC, id DESC
        LIMIT ?`
    )
    .all(
      profileId,
      ALCOHOL_FOOD_GROUP,
      q.like,
      ...named,
      LOGGED_ENTRY_LIMIT
    ) as { id: number; group_key: string; day: string }[];
  return rows.map((r) => ({
    entryId: `food:${r.id}`,
    // The record's own title for a serving: the group's name, the stored key when the
    // catalog no longer knows it (#203).
    title: foodGroupBySlug(r.group_key)?.name ?? r.group_key,
    day: r.day,
  }));
}

// Practice sessions: the practice's name, as stored. Spellings collapse at display —
// `normalizePracticeName` is the record's own title — so the LIKE runs on the column.
function practiceEntries(profileId: number, q: LoggedQuery): LoggedEntry[] {
  const rows = db
    .prepare(
      `SELECT id, practice, date AS day
         FROM practice_logs
        WHERE profile_id = ?
          AND practice LIKE ? ESCAPE '\\'
        ORDER BY date DESC, COALESCE(start_time, '99:99') DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, q.like, LOGGED_ENTRY_LIMIT) as {
    id: number;
    practice: string;
    day: string;
  }[];
  return rows.map((r) => ({
    entryId: `practice:${r.id}`,
    title: normalizePracticeName(r.practice),
    day: r.day,
  }));
}

// Symptoms: the curated label, or the custom name stored verbatim. The record's row is
// per (day, symptom) — its id says so — and `symptom_logs` is unique on that pair, so
// the rows and the entries are one to one.
function symptomEntries(profileId: number, q: LoggedQuery): LoggedEntry[] {
  const named = slugsNamed(SYMPTOMS, q.query);
  const rows = db
    .prepare(
      `SELECT date AS day, symptom
         FROM symptom_logs
        WHERE profile_id = ?
          AND (symptom LIKE ? ESCAPE '\\' OR symptom IN ${inList(named.length)})
        ORDER BY date DESC, symptom
        LIMIT ?`
    )
    .all(profileId, q.like, ...named, LOGGED_ENTRY_LIMIT) as {
    day: string;
    symptom: string;
  }[];
  return rows.map((r) => ({
    entryId: `symptom:${r.day}:${r.symptom}`,
    title: symptomLabel(r.symptom),
    day: r.day,
  }));
}

// Check-ins: a mood row states no instant at all, so its whole vocabulary is the words
// for the thing plus the day it names. `date` IS the profile-local day column.
function moodEntries(profileId: number, q: LoggedQuery): LoggedEntry[] {
  // THROUGH THE MOOD STORE, not a statement of our own: the check-in table is
  // store-private (#992, pinned by lib/__tests__/mood-guardrails.test.ts), so its
  // read layer owns the profile-scoped, bounded query and hands back the day.
  return searchMoodDays(profileId, q.like, LOGGED_ENTRY_LIMIT).map((r) => ({
    entryId: `mood:${r.id}`,
    // The record's title for the row. Its valence, scales, factors and note are the
    // row's detail, and a palette hit is a door, not a second rendering of it.
    title: "Mood",
    day: r.date,
  }));
}

// Body readings: the measure's label, and the value AS STORED.
//
// THE TITLE IS THE LABEL AND NOTHING ELSE, deliberately. Canonical storage is
// kilograms; the number a person sees is the login's display unit, converted at the
// render boundary (`bodyMetricMeasures`). A hit that printed a value would either
// re-do that conversion here — a second place for it to go wrong — or print kilograms
// to a reader who logs pounds. The value is matchable (typing the number you stored
// finds the reading) and unprinted; the row itself states it.
function bodyEntries(profileId: number, q: LoggedQuery): LoggedEntry[] {
  const labelled = BODY_METRIC_COLUMNS.filter(
    (column) =>
      matchTier(
        TREND_METRIC_META[BODY_METRIC_MEASURE_SLUG[column]].title,
        q.query
      ) > 0
  );
  const rows = db
    .prepare(
      `SELECT id, date AS day, weight_kg, body_fat_pct, resting_hr
         FROM body_metrics
        WHERE profile_id = ?
          AND (CAST(weight_kg AS TEXT) LIKE ? ESCAPE '\\'
               OR CAST(body_fat_pct AS TEXT) LIKE ? ESCAPE '\\'
               OR CAST(resting_hr AS TEXT) LIKE ? ESCAPE '\\'
               OR ? = 1)
        ORDER BY date DESC, id DESC
        LIMIT ?`
    )
    .all(
      profileId,
      q.like,
      q.like,
      q.like,
      labelled.length > 0 ? 1 : 0,
      LOGGED_ENTRY_LIMIT
    ) as (BodyMetricRow & { day: string })[];
  const pattern = q.query.trim().toLowerCase();
  return rows.flatMap((row) =>
    BODY_METRIC_COLUMNS.flatMap((column) => {
      const stored = row[column];
      // Renders from state, exactly as the record's row does: an empty cell is no
      // measure, so a hit can only name a reading that exists.
      if (stored == null) return [];
      if (!labelled.includes(column) && !String(stored).includes(pattern))
        return [];
      return [
        {
          entryId: `body:${column}:${row.id}`,
          title: TREND_METRIC_META[BODY_METRIC_MEASURE_SLUG[column]].title,
          day: row.day,
        },
      ];
    })
  );
}

// Sleep nights: the word plus the wake day.
//
// THE DAY IS THE PROFILE-LOCAL DAY OF THE WAKE INSTANT, computed through
// `zonedDateParts` from `ended_at` — the same anchor lib/history.ts files the row
// under, and the reason this one read carries a timezone at all. `metric_samples.date`
// is the SOURCE's own wake-day stamp and can sit a day off it (#3958), so it is the
// LIKE's substrate and the grouping key, never the address.
function sleepEntries(profileId: number, q: LoggedQuery): LoggedEntry[] {
  const rows = db
    .prepare(
      `SELECT MAX(ended_at) AS ended_at
         FROM metric_samples
        WHERE profile_id = ?
          AND metric = 'sleep_min'
          AND julianday(ended_at) > julianday(started_at)
          AND ('sleep' LIKE ? ESCAPE '\\' OR date LIKE ? ESCAPE '\\')
        GROUP BY date
        ORDER BY date DESC
        LIMIT ?`
    )
    .all(profileId, q.like, q.like, LOGGED_ENTRY_LIMIT) as {
    ended_at: string;
  }[];
  if (rows.length === 0) return [];
  const timeZone = getTimezone(profileId);
  const seen = new Set<string>();
  const entries: LoggedEntry[] = [];
  for (const row of rows) {
    const wakeDay = zonedDateParts(timeZone, new Date(row.ended_at)).date;
    // Two stored stamps can resolve onto one local wake day; the record draws ONE row
    // per wake day, so the palette offers one hit.
    if (seen.has(wakeDay)) continue;
    seen.add(wakeDay);
    entries.push({ entryId: `sleep:${wakeDay}`, title: "Sleep", day: wakeDay });
  }
  return entries;
}

// The seven. Declaration order is not display order — the ranker sorts the union.
const LOGGED_SOURCES: readonly LoggedSource[] = [
  { kind: "dose", noun: "Dose", read: doseEntries },
  { kind: "food", noun: "Serving", read: foodEntries },
  { kind: "practice", noun: "Practice", read: practiceEntries },
  { kind: "symptom", noun: "Symptom", read: symptomEntries },
  { kind: "mood", noun: "Check-in", read: moodEntries },
  { kind: "body", noun: "Reading", read: bodyEntries },
  { kind: "sleep", noun: "Sleep", read: sleepEntries },
];

// The one mapping: a record row in, a palette hit out.
//
// THE SUBTITLE'S DATE IS DISPLAY COPY, so it is rendered in the login's date shape and
// never as the stored `YYYY-MM-DD` (#3492/#3545 — a storage-format date in user copy).
// The issue pins the SHAPE `<kind> · <date>`, which "Practice · Aug 31" satisfies and
// the machine spelling does not. `formatMonthDay` is the vocabulary entry for a dense
// in-app label, and its auto-year rule is what puts the year on last year's session
// and leaves it off this morning's. The hit's `date` field keeps the ISO day — that
// one is machine-read (the recency tiebreak), never printed.
function loggedHit(
  source: LoggedSource,
  entry: LoggedEntry,
  display: Display
): SearchHit {
  const day = historyHref({ day: entry.day, kind: source.kind });
  return {
    domain: "logged",
    key: `logged:${entry.entryId}`,
    title: entry.title,
    subtitle: `${source.noun} · ${formatMonthDay(entry.day, display.prefs, {
      today: display.today,
    })}`,
    // The day view, scoped to the kind, scrolled to this row.
    href: `${day}#${timelineEntryAnchorId(entry.entryId)}` as AppRoute,
    date: entry.day,
  };
}

/** What the subtitle's date needs to read in the login's own shape. */
interface Display {
  prefs: DisplayFormatPrefs;
  today: string;
}

/**
 * Every logged-kind hit for one query, acting profile only.
 *
 * Seven statements, each `LIMIT 5` and each capped again after any in-memory fan-out,
 * so the whole group costs a bounded seven reads however dense the record is. Up to 35
 * candidates come back; the ranker keeps the five newest of them.
 *
 * `loginId` is the acting login, for the date shape its owner chose. `null` is the
 * documented login-less channel (a retrieval with a profile but no reader in context):
 * the default shape, declared at the call site rather than defaulted silently.
 */
export function loggedEntryHits(
  profileId: number,
  query: string,
  like: string,
  loginId: number | null
): SearchHit[] {
  const q: LoggedQuery = { query, like };
  const display: Display = {
    prefs:
      loginId == null ? DEFAULT_FORMAT_PREFS : getDisplayFormatPrefs(loginId),
    today: today(profileId),
  };
  return LOGGED_SOURCES.flatMap((source) =>
    source
      .read(profileId, q)
      .slice(0, LOGGED_ENTRY_LIMIT)
      .map((entry) => loggedHit(source, entry, display))
  );
}

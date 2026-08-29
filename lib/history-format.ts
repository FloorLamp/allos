// THE HISTORY PAGE'S GRAMMAR (issue #3958, phase 1) — PURE: no DB, no JSX, no clock.
//
// `/history` is the app's record: one row per recorded event, day-grouped, newest
// first. This module owns the three decisions that had drifted across the four ledger
// routes it replaces, and owns each of them ONCE:
//
//   1. THE ROW MODEL (`HistoryRow`) — (when, kind, what, detail, provenance,
//      mutability), the unit the issue names. Every kind's gather produces this shape
//      and nothing else, so a new kind cannot bring a new row grammar with it.
//   2. THE CLOCK GRAMMAR (`historyClock`) — a stated time renders bare ("10:07am");
//      a filing-time fallback renders "logged 10:07am". One meridiem style, page-wide.
//      This retires the shipped drift: food's ledger said "Ate 2:03 PM" and the dose
//      ledger said "recorded 12:02pm" on the same app.
//   3. THE DETAIL SEGMENT (`detailSegment`) — quantity → context → source, joined with
//      "·", empties dropped, NEVER truncated at the string level (overflow is the
//      row's CSS ellipsis, which is the only thing that knows the viewport).
//
// ONE GRAMMAR, MANY COMPOSERS — the `formatDateShape` architecture. `detailSegment`
// joins; it does not know what a dose or a serving is. The per-kind composers live
// beside their readers in lib/history.ts and go through the domain formatters that
// already exist (`fmtWeight`, `formatMedicationDoseLine`, `formatMinutes`,
// `formatClockValue`). No shared owner existed before this: `compactList` is a
// comma-list TRUNCATOR, a different job, and each timeline gather composed ad hoc —
// which is exactly how the clock drift happened.
//
// ORDERING IS NOT HERE, DELIBERATELY. Day bucketing and within-day order come from
// `mergeMemberTimelines` (lib/timeline-multi.ts), which already implements the
// contract this page needs — instant descending, date-only rows sinking below timed
// ones (a null `sortTime` compares as "", which sorts last under a descending
// compare), and a same-instant tie-break on id so the order is byte-stable across
// renders. A second grouping engine here would be the parallel concept CLAUDE.md
// forbids; the generalization that let one engine serve both feeds is a type
// parameter, not a fork.

import { formatClockValue, type DisplayFormatPrefs } from "./format-date";
import { FOOD_GROUPS } from "./food-groups";
import { ALCOHOL_FOOD_GROUP } from "./substance-use";
import { BODY_METRIC_MEASURE_SLUG } from "./body-metric-measures";
import type { AppRoute } from "./hrefs";
import type { MergeableRow } from "./timeline-multi";

// The Logs family's kinds, in the order their filter chips render. Phase 1's whole
// registry: sleep and symptoms join in phase 2, and the Training/Clinical/Life
// families with them.
export const HISTORY_LOG_KINDS = [
  "dose",
  "food",
  "practice",
  "substance",
  "body",
] as const;
export type HistoryLogKind = (typeof HISTORY_LOG_KINDS)[number];

export const HISTORY_KIND_LABELS: Record<HistoryLogKind, string> = {
  dose: "Doses",
  food: "Food",
  practice: "Practices",
  substance: "Substances",
  body: "Body",
};

// The families the closed kind registry sorts into. Phase 1 renders only `logs`;
// the union is stated whole so `?family=` parsing is already the final one and a
// phase-2 link written today does not 404.
export const HISTORY_FAMILIES = [
  "logs",
  "training",
  "clinical",
  "life",
] as const;
export type HistoryFamily = (typeof HISTORY_FAMILIES)[number];

/** The family a kind belongs to. Every phase-1 kind is a Logs kind. */
export function historyKindFamily(_kind: HistoryLogKind): HistoryFamily {
  return "logs";
}

// WHAT MAY EDIT THIS ROW IN PLACE. The trailing affordance is exclusive — ⋯ or › —
// and provenance decides which, never whether an editor exists at all. Every phase-1
// kind is user-logged, so every phase-1 row is a ⋯ row when the caller may write.
// `null` is the read-only viewer's answer (#2106: write access is re-checked
// server-side per row, and a row the caller may not write simply carries no menu).
export type HistoryRowEdit =
  | {
      kind: "dose";
      logId: number;
      itemId: number;
      doseId: number;
      statedAt: string | null;
      amount: string | null;
      itemKind: "supplement" | "medication";
    }
  | {
      kind: "food";
      eventId: number;
      groupKey: string;
      mealSlot: string;
      clock: string | null;
      clockKind: HistoryClockKind;
    }
  | {
      kind: "practice";
      sessionId: number;
      /**
       * The session's OWN `time` column, and never `sortTime`.
       *
       * They are different questions and the difference is the #2205 substitution:
       * `sortTime` is `bestKnownInstant`, which falls back to the record chain when
       * nobody stated a session time, so a quick-path tick carries the minute it was
       * TYPED. `editPracticeSession` writes what it is handed, so posting that back
       * while correcting a duration stamps the filing clock into the event column and
       * the row stops saying "logged 19:43" and starts claiming 19:43 as the session.
       * This field exists so the form physically cannot reach the other one.
       */
      statedTime: string | null;
      durationMin: number | null;
      notes: string | null;
    }
  | {
      kind: "substance";
      rowId: number;
      substance: string;
      amount: number;
      notes: string | null;
    }
  | { kind: "body"; target: string; slug: string; value: number; unit: string };

/** Whether a row's clock is the event's own or the record chain's (#2205/#2228). */
export type HistoryClockKind = "stated" | "logged";

/**
 * ONE RECORDED EVENT, as the page renders it.
 *
 * `sortTime` is the row's profile-LOCAL wall clock ("HH:MM") and is null for a row
 * that genuinely has no time — a substance day total, an undated body reading. That
 * null is what sinks the row below the day's timed ones, and it is a state rather
 * than a missing value: nobody said when, and the page does not invent one.
 */
export interface HistoryRow extends MergeableRow {
  /** `${kind}:${rowId}` — ASCII, unique across kinds, and the same-instant tie-break. */
  id: string;
  kind: HistoryLogKind;
  profileId: number;
  /** The profile-local day this row counts for (`rowLocalDay`, never re-derived). */
  date: string;
  sortTime: string | null;
  /** The rendered clock, in the page's one meridiem style. Null on a date-only row. */
  clock: string | null;
  clockKind: HistoryClockKind;
  /** The row's identity — what happened. Snapshotted: a retired item keeps its name. */
  title: string;
  /** "Does this thing have a home?" — independent of the trailing affordance. */
  href: AppRoute | null;
  /** `detailSegment`'s output. Empty string when the row has nothing to add. */
  detail: string;
  /** How many media files this row carries — the Photos filter's whole predicate. */
  media: number;
  edit: HistoryRowEdit | null;
}

/**
 * THE DETAIL SEGMENT. Joins with "·", drops empties, and NEVER truncates.
 *
 * The no-truncation rule is the load-bearing half. A string-level cap cannot know the
 * viewport, so every ledger that tried it either clipped a phone row that had room or
 * left a desktop row short — and once one composer caps at three items the next one
 * caps at two. Overflow belongs to the row's CSS ellipsis, which is measured.
 *
 * Order is the caller's, and the issue fixes it: quantity → context → source, with the
 * source last so "· Strava" is always the muted tail.
 */
export function detailSegment(
  parts: readonly (string | null | undefined | false)[]
): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(" · ");
}

/**
 * THE CLOCK, PAGE-WIDE. A stated time renders bare; a filing-time fallback says so.
 *
 * "logged" is lower-case and leads the clock because the row's identity is already
 * the title — the word is a qualifier on the time, not a second label. The meridiem
 * style is `lower-nospace` ("10:07am") everywhere, which is the decision that retires
 * the two spellings the ledgers shipped.
 */
export function historyClock(
  hhmm: string | null,
  clockKind: HistoryClockKind,
  prefs: DisplayFormatPrefs
): string | null {
  const clock = formatClockValue(hhmm, prefs.timeFormat, "", "lower-nospace");
  if (!clock) return null;
  return clockKind === "stated" ? clock : `logged ${clock}`;
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * `?kind=` → a Logs kind, or undefined for All.
 *
 * A bad deep link degrades TO THE PAGE, never to a 404 (the issue's ruling): an
 * unknown kind, a phase-2 kind that has not shipped, a hand-typed typo all fall back
 * to All, which is a page that answers the reader's question rather than an error that
 * does not.
 */
export function resolveHistoryKind(
  value: string | string[] | undefined
): HistoryLogKind | undefined {
  const raw = first(value)?.trim().toLowerCase();
  return (HISTORY_LOG_KINDS as readonly string[]).includes(raw ?? "")
    ? (raw as HistoryLogKind)
    : undefined;
}

/** `?family=` → a family, or undefined for All. Same degrade-to-All rule. */
export function resolveHistoryFamily(
  value: string | string[] | undefined
): HistoryFamily | undefined {
  const raw = first(value)?.trim().toLowerCase();
  return (HISTORY_FAMILIES as readonly string[]).includes(raw ?? "")
    ? (raw as HistoryFamily)
    : undefined;
}

/**
 * `?item=` → an item this kind can actually be narrowed to, or undefined.
 *
 * The page's degrade rule reaches the ITEM axis too: an unmatchable item renders an
 * empty page that ASSERTS there is nothing, which is the same defect a 404 would be
 * with a friendlier status. Only the closed vocabularies can be answered purely —
 * food groups and the three body measures — and `alcohol` is deliberately not among
 * the food groups here, because the record files a drink under substances.
 *
 * Dose items and practice names are OPEN per-profile vocabularies: membership is a DB
 * question, so their readers answer it by returning nothing, and this cannot.
 */
export function resolveHistoryItem(
  kind: HistoryLogKind | undefined,
  raw: string | undefined
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (kind === "food") {
    return value !== ALCOHOL_FOOD_GROUP &&
      FOOD_GROUPS.some((group) => group.slug === value)
      ? value
      : undefined;
  }
  if (kind === "body") {
    return BODY_METRIC_SLUGS.includes(value) ? value : undefined;
  }
  return value;
}

/**
 * The measure slugs a `body_metrics` row can be narrowed to — DERIVED from the one
 * column→slug map, never restated. A hand-written trio here would be a second
 * registry free to drift from `bodyMetricMeasures`, which is the fan-out this filter
 * is filtering, and a fourth measure column would then be filterable by the gather
 * and unfilterable by the URL.
 */
export const BODY_METRIC_SLUGS: readonly string[] = Object.values(
  BODY_METRIC_MEASURE_SLUG
);

/** `?class=` → the old two-door dose pre-filter, preserved as a param. */
export function resolveHistoryDoseClass(
  value: string | string[] | undefined
): "supplement" | "medication" | undefined {
  const raw = first(value)?.trim().toLowerCase();
  return raw === "supplement" || raw === "medication" ? raw : undefined;
}

// The page's read bound. The record is navigated rather than windowed (#2657), so
// there is no pager: `?show` grows cumulatively and the folds do the rest.
export const HISTORY_DEFAULT_SHOW = 200;
export const HISTORY_SHOW_STEP = 200;
export const HISTORY_MAX_SHOW = 1000;

export function parseHistoryShow(value: string | string[] | undefined): number {
  const n = Number(first(value));
  if (!Number.isFinite(n)) return HISTORY_DEFAULT_SHOW;
  return Math.min(
    Math.max(Math.trunc(n), HISTORY_DEFAULT_SHOW),
    HISTORY_MAX_SHOW
  );
}

/**
 * THE RECORD ENDS AT NOW. A `?day` in the future clamps to today rather than 404ing
 * or rendering an empty speculative day — symmetric with the Add door's
 * never-the-future rule, and with the timeline's future fold NOT being inherited.
 *
 * A malformed day is dropped entirely (undefined = no day view).
 */
export function clampHistoryDay(
  value: string | string[] | undefined,
  todayStr: string
): string | undefined {
  const raw = first(value)?.trim();
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return raw > todayStr ? todayStr : raw;
}

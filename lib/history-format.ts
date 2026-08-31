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
import type { TimelineEvent } from "./timeline-format";

// THE CLOSED KIND REGISTRY (#3958), one family at a time and in chip order.
//
// Phase 2 completes it. The four lists ARE the registry — `historyKindFamily` is
// derived from them rather than restated, so a kind cannot belong to two families or
// to none, and adding one is a single edit in a single list.
export const HISTORY_LOG_KINDS = [
  "dose",
  "food",
  "practice",
  "substance",
  "body",
  "sleep",
  "symptom",
] as const;
export type HistoryLogKind = (typeof HISTORY_LOG_KINDS)[number];

export const HISTORY_TRAINING_KINDS = [
  "activity",
  "endurance",
  "milestone",
] as const;

export const HISTORY_CLINICAL_KINDS = [
  "lab",
  "visit",
  "imaging",
  "medication",
  "immunization",
  "condition",
  "allergy",
  "document",
] as const;

export const HISTORY_LIFE_KINDS = [
  "protocol",
  "goal",
  "illness",
  "injury",
  "cycle",
  "insight",
] as const;

export type HistoryKind =
  | HistoryLogKind
  | (typeof HISTORY_TRAINING_KINDS)[number]
  | (typeof HISTORY_CLINICAL_KINDS)[number]
  | (typeof HISTORY_LIFE_KINDS)[number];

// The families the closed kind registry sorts into, in chip order.
export const HISTORY_FAMILIES = [
  "logs",
  "training",
  "clinical",
  "life",
] as const;
export type HistoryFamily = (typeof HISTORY_FAMILIES)[number];

export const HISTORY_FAMILY_KINDS: Record<
  HistoryFamily,
  readonly HistoryKind[]
> = {
  logs: HISTORY_LOG_KINDS,
  training: HISTORY_TRAINING_KINDS,
  clinical: HISTORY_CLINICAL_KINDS,
  life: HISTORY_LIFE_KINDS,
};

export const HISTORY_FAMILY_LABELS: Record<HistoryFamily, string> = {
  logs: "Logs",
  training: "Training",
  clinical: "Clinical",
  life: "Life",
};

export const HISTORY_KINDS: readonly HistoryKind[] = HISTORY_FAMILIES.flatMap(
  (family) => HISTORY_FAMILY_KINDS[family]
);

// SHORT DOMAIN WORDS (#3958's own instruction for the refinement row). Plural, because
// a chip names a set of rows and the day headers do the counting.
export const HISTORY_KIND_LABELS: Record<HistoryKind, string> = {
  dose: "Doses",
  food: "Food",
  practice: "Practices",
  substance: "Substances",
  body: "Body",
  sleep: "Sleep",
  symptom: "Symptoms",
  activity: "Activities",
  endurance: "Events",
  milestone: "Milestones",
  lab: "Labs",
  visit: "Visits",
  imaging: "Imaging",
  medication: "Meds",
  immunization: "Vax",
  condition: "Conditions",
  allergy: "Allergies",
  document: "Docs",
  protocol: "Protocols",
  goal: "Goals",
  illness: "Illness",
  injury: "Injuries",
  cycle: "Cycles",
  insight: "Insights",
};

// DERIVED FROM THE FOUR LISTS, never restated: the map is built once from the registry
// above, so a kind added to a family list is answered here with no second edit — and a
// kind that belongs to no list is a TYPE error at the `Record` rather than a silent
// "logs" default, which is what the phase-1 stub returned for everything.
const KIND_FAMILY = new Map<HistoryKind, HistoryFamily>(
  HISTORY_FAMILIES.flatMap((family) =>
    HISTORY_FAMILY_KINDS[family].map(
      (kind) => [kind, family] as [HistoryKind, HistoryFamily]
    )
  )
);

export function historyKindFamily(kind: HistoryKind): HistoryFamily {
  return KIND_FAMILY.get(kind)!;
}

// WHICH KINDS COLLAPSE INTO A DAY'S ROLLUP LINE, and the one that never does.
//
// #3958: "high-frequency log kinds collapse to one expandable line per day per
// member … Sleep never rolls up." Sleep is named as the exception AMONG the log kinds,
// which is what makes the exception mean anything — so the set is every Logs kind but
// sleep, rather than a hand-picked subset that would need its own justification per
// kind and would drift the first time a kind's frequency changed.
//
// The Training/Clinical/Life kinds are the RARE events the rollup exists to keep
// visible ("a lab, a milestone, a protocol change"), so none of them is here.
export const HISTORY_ROLLUP_KINDS: readonly HistoryKind[] =
  HISTORY_LOG_KINDS.filter((kind) => kind !== "sleep");

// The noun a rollup counts in. Deliberately NOT the chip label: a chip names a filter
// ("Food"), a rollup counts things that happened ("4 servings"), and #3958 writes the
// line as "6 doses · 4 servings" in exactly those words.
const ROLLUP_NOUNS: Partial<Record<HistoryKind, [string, string]>> = {
  dose: ["dose", "doses"],
  food: ["serving", "servings"],
  practice: ["practice", "practices"],
  substance: ["substance", "substances"],
  body: ["reading", "readings"],
  symptom: ["symptom", "symptoms"],
};

export function historyRollupNoun(kind: HistoryKind, count: number): string {
  const nouns = ROLLUP_NOUNS[kind];
  if (!nouns) return `${count} ${kind}`;
  return `${count} ${count === 1 ? nouns[0] : nouns[1]}`;
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
      statedStart: string | null;
      /** The stated END of the window (#3142), NULL for every tap. Rides along for
       *  the same reason the start does: the action rewrites what it reads. */
      statedEnd: string | null;
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
  | { kind: "body"; target: string; slug: string; value: number; unit: string }
  | {
      /**
       * A SYMPTOM-DAY, ADDRESSED BY (date, symptom) AND NOT BY A ROW ID.
       *
       * `symptom_logs` is `UNIQUE(profile_id, date, symptom)` (lib/logged-via.ts says
       * so): the store holds one upserted DAY-ROW per symptom carrying that day's worst
       * severity, and every write core in lib/symptom-log-write.ts already takes
       * (profileId, symptom, date). So the correction posts what those cores read.
       * Carrying a numeric id here would mean inventing an address the write path
       * cannot use.
       */
      kind: "symptom";
      symptom: string;
      severity: number;
      note: string | null;
    }
  | {
      /**
       * A recorded period, by its `cycles` row id. `period_end` is the INCLUSIVE last
       * bleeding day and NULL means ongoing, so the marker rows below are two views of
       * one row — the correction addresses the ROW, never the marker.
       */
      kind: "cycle";
      cycleId: number;
      periodStart: string;
      periodEnd: string | null;
      flow: string | null;
      note: string | null;
    };

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
  kind: HistoryKind;
  profileId: number;
  /**
   * The SUBJECT's timezone (#4009 item 1). Carried on the row because a correction
   * form for a row in `?view=everyone` collects a wall clock on the SUBJECT's day, and
   * the action re-anchors it in the subject's zone — so a form that used the acting
   * profile's zone would shift the instant on a save that changed nothing. One value
   * per member gather, already resolved there; nothing re-derives it.
   */
  tz: string;
  /** The profile-local day this row counts for (`rowLocalDay`, never re-derived). */
  date: string;
  sortTime: string | null;
  /** The rendered clock, in the page's one meridiem style. Null on a date-only row. */
  clock: HistoryClock | null;
  clockKind: HistoryClockKind;
  /** The row's identity — what happened. Snapshotted: a retired item keeps its name. */
  title: string;
  /** "Does this thing have a home?" — independent of the trailing affordance. */
  href: AppRoute | null;
  /** `detailSegment`'s output. Empty string when the row has nothing to add. */
  detail: HistoryDetail;
  /** How many media files this row carries — the Photos filter's whole predicate. */
  media: number;
  edit: HistoryRowEdit | null;
  /**
   * WHAT THE ROW CANNOT SAY ON ONE LINE (#662/#2920, #3958 phase 2d).
   *
   * The feed's gathers have always computed a lab panel's per-marker breakdown, an
   * activity's set summaries, a sleep session's stages and a visit's lineage refs.
   * Their only renderer was `/timeline`'s two-line card; the record's rows are ONE
   * line and carried no disclosure, so between phase 2c and here the data was
   * gathered and shown nowhere.
   *
   * BOTH FIELDS ARE THE TIMELINE'S OWN TYPES, not restatements of them. A second
   * spelling of the same shape at this seam is how a formatter and its source drift,
   * and the composers that build them are unchanged — this row carries them across.
   *
   * `linkedScope` says which lineage the refs came from, and the panel's heading
   * claims exactly that much: "visit" means rows carrying a real encounter link to
   * THIS visit, "document" means everything the import document produced and is only
   * ever set where that document stands for a single visit (#2920). Absent with no
   * refs — a reference chip that cannot honestly name its visit says nothing.
   */
  detailItems?: TimelineEvent["detailItems"];
  linkedRefs?: TimelineEvent["linkedRefs"];
  linkedScope?: TimelineEvent["linkedRefsScope"];
}

/**
 * THE TWO GRAMMARS, AS TYPES (#4452). Only `historyClock` and `detailSegment` produce
 * these, so "one clock grammar and one `detailSegment` grammar page-wide" is enforced
 * by the compiler rather than remembered by every future gather: a hand-written
 * `clock: "2:03 PM"` on a row does not typecheck, and that is the whole guard.
 *
 * NOT `HistoryRowEdit`'s food `clock`, which is the raw "HH:MM" the correction form
 * seeds and posts back to a write core — a stored wall clock, not a rendered one.
 * Branding it would push a display string into the database.
 */
declare const RENDERED: unique symbol;
export type HistoryClock = string & { readonly [RENDERED]: "clock" };
export type HistoryDetail = string & { readonly [RENDERED]: "detail" };

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
): HistoryDetail {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(" · ") as HistoryDetail;
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
): HistoryClock | null {
  const clock = formatClockValue(hhmm, prefs.timeFormat, "", "lower-nospace");
  if (!clock) return null;
  return (clockKind === "stated" ? clock : `logged ${clock}`) as HistoryClock;
}

/**
 * A ROW'S THREE TIME FIELDS, ANSWERED ONCE (#4452). Nine gathers spelled the
 * (sortTime, clock, clockKind) triple out by hand, two computing the same ternary
 * twice — one minute in, one call. It is also how a gather obtains a `clock` at all.
 */
export function historyClockFields(
  hhmm: string | null,
  clockKind: HistoryClockKind,
  prefs: DisplayFormatPrefs
): Pick<HistoryRow, "sortTime" | "clock" | "clockKind"> {
  return {
    sortTime: hhmm,
    clock: historyClock(hhmm, clockKind, prefs),
    clockKind,
  };
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
): HistoryKind | undefined {
  const raw = first(value)?.trim().toLowerCase();
  return (HISTORY_KINDS as readonly string[]).includes(raw ?? "")
    ? (raw as HistoryKind)
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
  kind: HistoryKind | undefined,
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

// ── ROLLUPS — THE DENSITY ANSWER (#3958 phase 2) ─────────────────────────────
//
// In Everything, a day's high-frequency log rows collapse to ONE expandable line per
// day PER MEMBER, so the rare events that share the day — a lab, a milestone, a
// protocol change — stay visible instead of being buried under forty servings.
//
// PER MEMBER IS THE LOAD-BEARING HALF, and it is why a mixed count would be a bug
// rather than a shortcut: "7 doses" across two members hides whose doses they were, and
// the row set it stands for is the one place that answer lived. So the grouping key is
// (day, profileId) and the line names its subject.
//
// FILTERED TO A FAMILY THE PAGE IS THE PLAIN RECORD: the caller passes `rollup: false`
// and this returns every row visible, in merge order. Same function, no second
// renderer — a rollup is a state of the day, not a mode of the page.

/** One day's collapsed log rows for one member. Neither ⋯ nor › — expand is the verb. */
export interface HistoryRollup {
  /** `${date}:${profileId}` — the `?expand=` key, and the React key. */
  key: string;
  profileId: number;
  /** "6 doses · 4 servings", in `detailSegment`'s one separator. */
  label: HistoryDetail;
  /** How many rows it stands for — what the day header already counted. */
  count: number;
  /** The collapsed rows, in the merge's own order. Rendered only when expanded. */
  rows: HistoryRow[];
}

/** A day as the feed draws it: the rows that stayed, then the day's fixed last lines. */
export interface HistoryDayLayout {
  visible: HistoryRow[];
  rollups: HistoryRollup[];
}

/**
 * COLLAPSE ONE DAY'S ROLLUP-KIND ROWS, per member.
 *
 * The rollup line is the day's FIXED LAST LINE (#3958: "an aggregate has no honest
 * single instant — a fixed position is the legible rule"), and with several members in
 * view the lines are ordered by profile id — the same tie-break `compareMerged` uses,
 * so the order is byte-stable across renders for the same reason the rows are.
 *
 * The label counts KINDS IN REGISTRY ORDER, not in the order the day happened to
 * produce them: two days with the same contents must read the same.
 */
export function layoutHistoryDay(
  rows: readonly HistoryRow[],
  opts: { rollup: boolean }
): HistoryDayLayout {
  if (!opts.rollup) return { visible: [...rows], rollups: [] };
  const visible: HistoryRow[] = [];
  const byMember = new Map<number, HistoryRow[]>();
  for (const row of rows) {
    if (!HISTORY_ROLLUP_KINDS.includes(row.kind)) {
      visible.push(row);
      continue;
    }
    const list = byMember.get(row.profileId);
    if (list) list.push(row);
    else byMember.set(row.profileId, [row]);
  }
  const rollups: HistoryRollup[] = [];
  for (const profileId of [...byMember.keys()].sort((a, b) => a - b)) {
    const group = byMember.get(profileId)!;
    const counts = new Map<HistoryKind, number>();
    for (const row of group)
      counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    rollups.push({
      key: `${group[0].date}:${profileId}`,
      profileId,
      label: detailSegment(
        HISTORY_ROLLUP_KINDS.filter((kind) => counts.has(kind)).map((kind) =>
          historyRollupNoun(kind, counts.get(kind)!)
        )
      ),
      count: group.length,
      rows: group,
    });
  }
  return { visible, rollups };
}

/**
 * `?expand=` → the rollup lines the reader has opened.
 *
 * A SECOND PARAM RATHER THAN `?open=`, because they answer different questions and
 * `parseTimelineOpen` validates its keys against the fold vocabulary (a year, a month,
 * the ahead key). A rollup key is `YYYY-MM-DD:<profileId>`; a malformed one is dropped
 * rather than 404ing, like every other parser on this page.
 */
export function parseHistoryExpand(
  value: string | string[] | undefined
): Set<string> {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = new Set<string>();
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const key = part.trim();
      if (/^\d{4}-\d{2}-\d{2}:\d+$/.test(key)) out.add(key);
    }
  }
  return out;
}

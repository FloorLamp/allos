// Bristol stool form (issue #2785) — the pure vocabulary, its guard, and the two
// shapes its surfaces read. No DB, no React, no clock.
//
// ── WHERE IT LIVES (issue #5872 overturned the answer this header used to give) ──
//
// THIS SECTION USED TO ARGUE THAT THERE IS NO TABLE, and the argument was sound for the
// thing it was about. A Bristol READING is a dated observation carrying one small
// ordinal number, which is precisely what `metric_samples` is — so it lived there under
// a metric key, at INSTANT grain rather than day grain, because several movements a day
// is ordinary and each is its own observation.
//
// The premise that failed is in the first clause. A stool is not a reading that always
// carries a type; it is an OCCURRENCE that may carry one. "I had a poop this morning
// but didn't see what form" is a thing that happened, and `metric_samples.value` is
// REAL NOT NULL, so the old store could not record it at all — there was no value to
// put in the column the row is built around. Two more defects rode on the same shape:
// the samples natural key (profile, metric, source, origin, started_at) UPSERTS, so a
// second movement stated at a minute already recorded overwrote the first, and an
// unstated tap was stamped at the wall clock, so the row could not tell "happened at
// 7:41" from "filed at 7:41".
//
// So a stool is an event in `stool_events` (lib/stool-log-write.ts, lib/queries/
// bristol-stool.ts), the shape `food_log_events` and `substance_log_events` already
// have: the occurrence is the row, the type is a nullable fact about it, the ledger is
// append-only, and an instant nobody stated is NULL rather than the clock.
//
// WHAT DID NOT CHANGE IS EVERYTHING BELOW. The scale is still the whole vocabulary, it
// still has no canonical twin, and it still must never be averaged — a table of its own
// is not a claim that it measures the same quantity a curated entry judges. The two
// sections that follow are the arguments three other modules cite, and they stand.
//
// ── WHY IT IS **NOT** IN `READING_IDENTITY_MAP` ──────────────────────────────
//
// That map's discipline is explicit: registering a stream there CLAIMS that it measures
// the same quantity a curated canonical entry judges, and weight, height, HRV and steps
// are absent from it precisely because the canonical vocabulary has no entry for them.
// Bristol has none either, and it must not get one — #2785 is emphatic that the stool
// panel's "Stool Consistency: Soft" document rows are a LAB's qualitative result about a
// specimen and stay where they are. A self-reported daily form score and a lab's
// consistency finding are two different observations that happen to share a word.
//
// So Bristol takes the answer sleep and HRV already take (lib/offline/writes.ts): its
// own writer, no canonical name, no placement, and therefore no entry in the identity
// map and none in `METRIC_KNOWLEDGE`, whose domain is the trend-metric enum and the
// identities those two registries derive. That is not knowledge going undeclared — it
// is the #482 exclusion discipline holding on a quantity that genuinely has no
// canonical twin. The knowledge that DOES exist is the scale itself, and it is right
// here: the seven types are the whole vocabulary, and the app states no verdict about
// them (see below).
//
// ── NO VERDICT IN v1 ─────────────────────────────────────────────────────────
//
// A recording surface. There is no finding, no send, no "type 6-7 runs alongside your
// illness episode" — that is a later decision under the findings doctrine, and nothing
// in this module produces a field a renderer could make one out of. There is no
// `optimal` type here and no `abnormal` one, only the scale's own ordering.
//
// ── AND NO MEAN, EVER ────────────────────────────────────────────────────────
//
// The series is CATEGORICAL-ORDINAL. Type 1 and type 7 are opposite dysfunctions and
// their mean is 4, the very middle of the scale — so an averaged Bristol line reports a
// week of alternating constipation and diarrhea as textbook-normal. "Mean stool type
// 3.4" is not a sentence. Both readers below therefore COUNT; neither averages, and the
// panel shape carries no field an averaging renderer could reach for.

import { lastNDates } from "./date";

/**
 * THE RETIRED `metric_samples` METRIC KEY (#5872). No writer produces it and the
 * 20260911-stool-events migration removed every row that carried it, so nothing the app
 * does can put one back.
 *
 * It is still NAMED, in one place: `CATEGORICAL_METRICS` (lib/metric-buckets.ts), whose
 * job is to make the aggregation layer DECLINE rather than sum or average. That guard
 * is about rows in the table, not about the app's writers — a restored backup or an
 * import can carry the old key into `metric_samples` — and "type 3 + type 3 = mushy"
 * is exactly as wrong for such a row as it ever was. Removing the entry would leave the
 * additive default as the answer for a key this app once used, which is the one outcome
 * the entry exists to prevent.
 */
export const BRISTOL_STOOL_METRIC = "bristol_stool_type";

/** The scale's bounds. Types are 1-7 — there is no 0 and no 8. */
export const MIN_BRISTOL_TYPE = 1;
export const MAX_BRISTOL_TYPE = 7;

export interface BristolStoolType {
  /** 1-7. The stored value, and the number the button shows. */
  type: number;
  /** The button's short caption — two words at most, so seven fit on a phone. */
  label: string;
  /** The scale's own description. The button's `aria-label` reads this. */
  description: string;
}

/**
 * The Bristol Stool Form Scale (Lewis & Heaton, 1997), types 1-7 in scale order.
 *
 * The DESCRIPTIONS are the scale's, unedited in meaning: they are what makes a
 * self-reported type comparable between two people and between one person's Tuesday
 * and their Friday, which is the entire value of using a published scale instead of
 * inventing three buckets. The short labels are ours, for a button that has room for
 * two words.
 */
export const BRISTOL_STOOL_TYPES: readonly BristolStoolType[] = [
  {
    type: 1,
    label: "Hard lumps",
    description: "Separate hard lumps, like nuts, and hard to pass",
  },
  { type: 2, label: "Lumpy", description: "Sausage-shaped but lumpy" },
  {
    type: 3,
    label: "Cracked",
    description: "Like a sausage but with cracks on the surface",
  },
  {
    type: 4,
    label: "Smooth",
    description: "Like a sausage or snake, smooth and soft",
  },
  {
    type: 5,
    label: "Soft blobs",
    description: "Soft blobs with clear-cut edges, passed easily",
  },
  {
    type: 6,
    label: "Mushy",
    description: "Fluffy pieces with ragged edges, a mushy stool",
  },
  {
    type: 7,
    label: "Liquid",
    description: "Watery, no solid pieces, entirely liquid",
  },
];

/**
 * The scale, whole, as one label — `1 Hard lumps — Separate hard lumps, like nuts, and
 * hard to pass` through `7 Liquid — Watery, no solid pieces, entirely liquid`, one type
 * per line.
 *
 * BUILT FROM THE VOCABULARY, never retyped (#5756). The tiles show a picture and two
 * words, the record's correction form lists the sentences in its select, and the sheet
 * shows them behind an info glyph; all three read this array, so the sentence that says
 * what a picture means cannot come to differ from the sentence stored beside the type.
 */
export function bristolScaleLines(): string {
  return BRISTOL_STOOL_TYPES.map(
    (t) => `${t.type} ${t.label} — ${t.description}`
  ).join("\n");
}

const BY_TYPE = new Map(BRISTOL_STOOL_TYPES.map((t) => [t.type, t]));

/**
 * Whether a value is a real Bristol type — the ONE guard every write path runs.
 *
 * It is deliberately not a range comparison at the call sites: a `>= 1 && <= 7` written
 * out four times is four chances to write `>= 0`, and a fractional 3.5 passes such a
 * check while naming no type at all. This asks the vocabulary whether the number is a
 * MEMBER, so 0, 8, 3.5, NaN, Infinity and a numeric string are all refused by the same
 * question, and the answer moves with the vocabulary rather than beside it.
 */
export function isBristolType(value: unknown): value is number {
  return typeof value === "number" && BY_TYPE.has(value);
}

/** The scale entry for a type, or null when the number names none. */
export function bristolStoolType(value: unknown): BristolStoolType | null {
  return isBristolType(value) ? (BY_TYPE.get(value) ?? null) : null;
}

/**
 * THE POSTED VALUE THAT CLEARS A ROW'S TYPE (#5872), back to an occurrence nobody saw
 * the form of.
 *
 * A SENTINEL RATHER THAN AN EMPTY STRING, because an empty field is what a browser
 * sends for a control that was never touched, and "untouched" must never mean "erase
 * the type somebody recorded". It lives here, in the vocabulary, rather than beside the
 * action that reads it: `app/(app)/stool-actions.ts` is a `"use server"` module, and
 * such a module may export nothing but async functions — a const exported from one
 * makes EVERY export in the file invisible to the bundler, which is a build failure
 * several import traces away from its cause.
 */
export const UNTYPED_FIELD_VALUE = "none";

/**
 * Parse a submitted form field into a stored type, or null when it names none.
 * Whole numbers only — "4.0" is a type, "3.5" is not.
 */
export function parseBristolType(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return isBristolType(n) ? n : null;
}

// ── The two read shapes ──────────────────────────────────────────────────────

/** One stored reading, as the query layer hands it over. */
export interface BristolReading {
  /** Profile-local YYYY-MM-DD. */
  date: string;
  /** 1-7. A row outside the vocabulary is dropped by both builders below. */
  type: number;
}

/** The window a Bristol panel reads — four whole weeks, the fiber panel's span. */
export const BRISTOL_PANEL_DAYS = 28;

/** The window's dates for a profile-local today, oldest → newest. */
export function bristolPanelDates(today: string): string[] {
  return lastNDates(today, BRISTOL_PANEL_DAYS);
}

/** One day of the strip. */
export interface BristolStripDay {
  /** Profile-local YYYY-MM-DD. */
  date: string;
  /**
   * The day's types in scale order, or an EMPTY array for a day with no reading.
   * A day with nothing recorded is a HOLE, not a zero and not a carried-forward
   * value (#2258: a missing day occupies space) — and it is distinguishable here
   * because there is no other way for the array to be empty.
   */
  types: number[];
}

/** How many readings each type drew over the window. */
export interface BristolTypeCount {
  type: number;
  count: number;
}

export interface BristolPanel {
  /** One entry per calendar day, oldest → newest, spanning the whole window. */
  days: BristolStripDay[];
  /** Every type 1-7 with its count — including the zeroes, so the shape is fixed. */
  distribution: BristolTypeCount[];
  /** Readings in the window. Zero means the panel has nothing to show. */
  total: number;
  /** The tallest bar, for scaling the distribution. At least 1, never 0. */
  maxCount: number;
}

/**
 * Assemble the panel: a per-day strip and a per-type distribution over one window.
 *
 * Pure — the gather resolves the window and the readings; this aligns, filters and
 * COUNTS. A reading outside the window is ignored and a value outside the vocabulary is
 * dropped, so a hand-edited row can never put an eighth bar on the chart.
 */
export function buildBristolPanel(
  dates: readonly string[],
  readings: readonly BristolReading[]
): BristolPanel {
  const inWindow = new Set(dates);
  const byDate = new Map<string, number[]>();
  const counts = new Map<number, number>(
    BRISTOL_STOOL_TYPES.map((t) => [t.type, 0])
  );
  let total = 0;

  for (const r of readings) {
    if (!isBristolType(r.type) || !inWindow.has(r.date)) continue;
    const list = byDate.get(r.date) ?? [];
    list.push(r.type);
    byDate.set(r.date, list);
    counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    total += 1;
  }
  for (const list of byDate.values()) list.sort((a, b) => a - b);

  const distribution = BRISTOL_STOOL_TYPES.map((t) => ({
    type: t.type,
    count: counts.get(t.type) ?? 0,
  }));

  return {
    days: dates.map((date) => ({ date, types: byDate.get(date) ?? [] })),
    distribution,
    total,
    maxCount: Math.max(1, ...distribution.map((d) => d.count)),
  };
}

// ── THE SHEET'S RECEIPT ROWS (#5663) ────────────────────────────────────────
//
// The owner's report was "quicklogging stool provides no feedback or description": a
// tap moved a count, painted 300ms of motion, and toasted a NUMBER — while the sentence
// that says what that number means was reachable only as a button's accessible name or
// behind the title row's info glyph (#5756). The owner's ruling (2026-09-11) is that
// the sheet lists EACH OF TODAY'S ENTRIES as its own receipt row, newest first, in two
// lines:
//
//     Type 6 · Mushy
//     Fluffy pieces with ragged edges, a mushy stool · 8:31am
//
// Built from the vocabulary above, never retyped — the #5756 rule, and the reason the
// sentence beside a picture cannot come to differ from the one stored beside the type.

/** One receipt row's two lines. Separate, because they are two elements on the row. */
export interface BristolReceiptLines {
  /** `Type 6 · Mushy` — the number the button showed, and its two-word caption. */
  heading: string;
  /**
   * `Fluffy pieces with ragged edges, a mushy stool · 8:31am` — the scale's own
   * sentence and the reading's clock, in the practice row's facts grammar (#5431:
   * facts joined by " · ").
   */
  facts: string;
}

/**
 * A reading's two receipt lines, or null when the number names no type.
 *
 * THE CLOCK ARRIVES FORMATTED. A model emits a time and ONE formatter produces the
 * string (#1163): the login's 12h/24h preference belongs to the render layer, and
 * reaching for it here would put a second clock convention in a pure module. An empty
 * clock drops the trailing slot rather than printing an empty one — a separator with
 * nothing after it reads as a missing value.
 *
 * Null rather than a best effort, because the question is the same membership one
 * `isBristolType` asks everywhere else: a replayed or hand-edited value can never put
 * "Type 8 · undefined" on the sheet.
 */
export function bristolReceiptLines(
  type: unknown,
  clock: string
): BristolReceiptLines | null {
  const entry = bristolStoolType(type);
  if (!entry) return null;
  return {
    heading: `Type ${entry.type} · ${entry.label}`,
    facts: clock ? `${entry.description} · ${clock}` : entry.description,
  };
}

// Bristol stool form (issue #2785) — the pure vocabulary, its guard, and the two
// shapes its surfaces read. No DB, no React, no clock.
//
// ── WHERE IT LIVES, AND WHY THERE IS NO TABLE ────────────────────────────────
//
// A Bristol reading is a dated observation carrying one small ordinal number, which
// is precisely what `metric_samples` is (docs/internals/reading-model.md: a new dated
// reading reuses an existing store). It lands there under `BRISTOL_STOOL_METRIC`, at
// INSTANT grain rather than day grain, because several movements a day is ordinary and
// each is its own observation — the same reason peak expiratory flow could not use
// `body_metrics`' one-row-per-day shape.
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

/** The `metric_samples` metric key Bristol readings live under. */
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

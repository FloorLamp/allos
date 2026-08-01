// The PURE core of the daily wellbeing check (issue #992): the 1–5 scales, the
// factor-chip vocabulary, input normalization shared by every write path (the
// dashboard card's server action, the offline-queue replay, and the Telegram
// check-in button — one validation, no drift), and the opt-in reminder's
// auto-pause decision. No DB, no network, no clock — fully unit-tested in
// lib/__tests__/mood.test.ts.
//
// SENSITIVITY CONTRACT (product-decided in #992, same hard lines as #716):
//   • No gamification, ever — nothing here (or anywhere) computes a mood streak,
//     milestone, or score-to-beat; pinned by lib/__tests__/mood-guardrails.test.ts.
//   • Never flagged — a mood value is a subjective self-rating, not a lab: it gets
//     no reference-range flag and no retest clock (same guard test).
//   • Calm and optional — skipping is frictionless and never escalates; the only
//     downstream signals are coaching-tier observations (lib/mood-observation.ts).

export const MOOD_MIN = 1;
export const MOOD_MAX = 5;

// The 5-point valence scale, 1 (rough) → 5 (great). One emoji face + label per
// step, shared by the dashboard tap row, the Telegram check-in keyboard, and the
// trend tooltip so every surface names a rating identically.
export const MOOD_FACES: readonly string[] = ["😞", "🙁", "😐", "🙂", "😄"];
export const MOOD_LABELS: readonly string[] = [
  "Rough",
  "Low",
  "Okay",
  "Good",
  "Great",
];

export function moodFace(valence: number): string {
  return MOOD_FACES[valence - 1] ?? "😐";
}

export function moodLabel(valence: number): string {
  return MOOD_LABELS[valence - 1] ?? String(valence);
}

// The factor-chip vocabulary. Stored as a JSON array of these slugs; anything
// off-vocabulary is dropped at normalization so the stored blob is always a subset
// of this closed set.
//
// SHRUNK to work/social (issue #1311): the three former slugs `sleep`, `health`,
// and `cycle` each had a situation/context TWIN on the same check-in card — Poor
// sleep (declared/derived, #1292), the illness door, and Period (#1298) — so one
// assertion had two disconnected entry points. Factors are display-only (verified:
// lib/sleep-summary passes them through, telegram-callbacks preserves them, no
// trends/coaching consumer keys on a slug), so the overlapping slugs left the
// vocabulary AND the validation set outright — no migration, no legacy tolerance
// (parseMoodFactors already filters to known slugs, so any stray stored value
// simply stops rendering). `work` and `social` survive as the mood-only day-chips
// the merged "What's going on?" group renders alongside the sticky situations.
export const MOOD_FACTORS: readonly { slug: string; label: string }[] = [
  { slug: "work", label: "Work" },
  { slug: "social", label: "Social" },
];

const FACTOR_SLUGS = new Set(MOOD_FACTORS.map((f) => f.slug));

// ---- Calm (anxiety) axis relabel (issue #1313 fold-in) -----------------------
//
// The Calm scale's DIRECTION was inverted relative to Energy: the stored `anxiety`
// value is 1 = calm/good … 5 = anxious/bad, while Energy is 1 = drained/bad …
// 5 = energized/good. The fix is PRESENTATION-only — store semantics are UNCHANGED
// (`anxiety` stays anxiety; the normalizer/queries never see this map) — the UI maps
// so the RIGHT (high) end is the good end (calm) on both scales. Display slot d ↔
// stored value (6 − d): an involution, so display↔stored is the same map both ways.
// These live in mood.ts (not mood-anxiety-gate.ts) so the client check-in card can
// import the relabel without pulling the gate's drug-dataset dependency.
export const ANXIETY_CALM_LOW_LABEL = "anxious"; // display slot 1 (left) = anxious
export const ANXIETY_CALM_HIGH_LABEL = "calm"; // display slot 5 (right) = calm

// Map a stored anxiety value to its DISPLAY slot (calm on the right). 6 − stored.
export function anxietyDisplaySlot(stored: number): number {
  return 6 - stored;
}

// Map a DISPLAY slot back to the stored anxiety value. Same 6 − x involution.
export function anxietyStoredValue(displaySlot: number): number {
  return 6 - displaySlot;
}

// ---- The three charted check-in series (issue #1408) -------------------------
//
// A check-in row carries THREE 1–5 self-ratings — valence, energy, and the gated
// anxiety scale — but only valence was ever plotted, so a user who rated energy or
// anxiety every day had nowhere to review it. These are the series ids the Body
// census cards, the metric tiles and the `/trends/metric/<slug>` detail pages key
// on, and they are the SAME strings as the metric slugs (`mood` aside, whose slug
// predates this and stays).
//
// `calm`, not `anxiety`, deliberately: the charted value is the #1313 DISPLAY slot
// (high = calm), the same relabelled axis the check-in card offers, so the trend and
// the input can't disagree about which end is the good end. The STORE is untouched —
// `anxiety` stays anxiety in the column, in the normalizer, and in the query layer;
// the map lives here at the presentation boundary exactly as #1313 requires.
export const MOOD_CHART_SERIES = ["valence", "energy", "calm"] as const;
export type MoodChartSeries = (typeof MOOD_CHART_SERIES)[number];

// The STORED counterpart — the check-in row's three rating columns, named as the
// store names them. The read layer and the write core both switch on this, and the
// pair of vocabularies is what keeps `calm` a display word and `anxiety` a storage
// word instead of one leaking into the other.
export const MOOD_RATING_COLUMNS = ["valence", "energy", "anxiety"] as const;
export type MoodRatingColumn = (typeof MOOD_RATING_COLUMNS)[number];

// Which column a charted series reads. The only place the two vocabularies meet.
export function moodRatingColumn(series: MoodChartSeries): MoodRatingColumn {
  return series === "calm" ? "anxiety" : series;
}

// One check-in's value on one series, or null when that scale went unanswered
// (energy and the Calm scale are expand-only, so most rows carry valence alone).
export function moodSeriesValue(
  log: { valence: number; energy: number | null; anxiety: number | null },
  series: MoodChartSeries
): number | null {
  switch (series) {
    case "valence":
      return log.valence;
    case "energy":
      return log.energy;
    case "calm":
      return log.anxiety == null ? null : anxietyDisplaySlot(log.anxiety);
  }
}

// The chartable points for one series — the ONE computation behind every surface
// that plots a check-in (#221): the census card, its tile, the detail page and a
// starred reconstruction all read the SAME mood rows and map them here, so three
// series can never be windowed, rounded, or relabelled three different ways.
//
// Unanswered days are DROPPED rather than emitted as null holes: a skipped scale is
// an absent reading, not a zero, and the chart bridges the gap like every other
// sparse body series.
export function moodSeriesPoints(
  logs: readonly {
    date: string;
    valence: number;
    energy: number | null;
    anxiety: number | null;
  }[],
  series: MoodChartSeries
): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  for (const log of logs) {
    const value = moodSeriesValue(log, series);
    if (value != null) out.push({ date: log.date, value });
  }
  return out;
}

// A 1–5 scale value, or null for "not answered" (energy/anxiety are expand-only).
function scaleOrNull(v: unknown): number | null | "invalid" {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return "invalid";
  return n >= MOOD_MIN && n <= MOOD_MAX ? n : "invalid";
}

export interface MoodInput {
  valence: unknown;
  energy?: unknown;
  anxiety?: unknown;
  factors?: unknown;
  note?: unknown;
}

export interface NormalizedMood {
  valence: number;
  energy: number | null;
  anxiety: number | null;
  // Validated, deduped factor slugs (subset of MOOD_FACTORS), in vocabulary order.
  factors: string[];
  note: string | null;
}

// Normalize + validate one check-in. Returns { error } when the required valence
// is missing/out of range or an optional scale is out of range; off-vocabulary
// factor slugs are dropped (never an error — a stale client chip must not lose the
// tap), and the note is trimmed to null when empty.
export function normalizeMoodInput(
  input: MoodInput
): NormalizedMood | { error: string } {
  const valence = scaleOrNull(input.valence);
  if (valence === null || valence === "invalid") {
    return { error: "Mood must be a rating from 1 to 5." };
  }
  const energy = scaleOrNull(input.energy);
  if (energy === "invalid") return { error: "Energy must be from 1 to 5." };
  const anxiety = scaleOrNull(input.anxiety);
  if (anxiety === "invalid") return { error: "Anxiety must be from 1 to 5." };

  const raw = Array.isArray(input.factors) ? input.factors : [];
  const picked = new Set(
    raw.map((f) => String(f)).filter((f) => FACTOR_SLUGS.has(f))
  );
  const factors = MOOD_FACTORS.map((f) => f.slug).filter((s) => picked.has(s));

  const note =
    typeof input.note === "string" && input.note.trim() !== ""
      ? input.note.trim()
      : null;

  return { valence, energy, anxiety, factors, note };
}

// Parse a stored `factors` JSON blob back to validated slugs. Malformed or
// off-vocabulary content degrades to [] — never a throw on a read path.
export function parseMoodFactors(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const picked = new Set(
      arr.map((f) => String(f)).filter((f) => FACTOR_SLUGS.has(f))
    );
    return MOOD_FACTORS.map((f) => f.slug).filter((s) => picked.has(s));
  } catch {
    return [];
  }
}

// ---- The opt-in check-in reminder (#992: engagement-aware, off by default) ----

// After this many consecutive sent-but-unanswered check-ins the reminder AUTO-
// PAUSES — it must never nag someone who's disengaged, which is often exactly when
// mood is lowest. A submitted check-in (any write path) resets the counter, which
// re-arms the reminder.
export const MOOD_CHECKIN_AUTOPAUSE_DAYS = 5;

// Decide whether tonight's check-in should send. Pure — the tick supplies the
// three facts. Never sends when the day is already logged (nothing to ask), and
// holds silently once the ignored streak reaches the auto-pause line.
export function shouldSendMoodCheckin(input: {
  enabled: boolean;
  alreadyLoggedToday: boolean;
  ignoredCount: number;
}): boolean {
  if (!input.enabled) return false;
  if (input.alreadyLoggedToday) return false;
  return input.ignoredCount < MOOD_CHECKIN_AUTOPAUSE_DAYS;
}

// ---- Announcing the pause (issue #1668) ----
//
// The auto-pause was INVISIBLE: reminders simply stopped, which reads as "notifications
// broke", and there was no in-app trace of the paused state or way to resume short of
// remembering to log a mood. The mechanism itself is right (#992: a disengaged user
// must not be nagged) — this is a visibility gap, not a doctrine violation.
//
// CONFIRM-TO-KEEP, not suggest-and-confirm. A "tap to pause?" question is
// self-defeating for contact REDUCTION: if ignoring it keeps reminders coming, the
// disengaged user is nagged forever (the exact harm #992 forbids); if ignoring it
// pauses anyway, the confirmation is theater. Consent gates apply to STARTING contact
// and CHANGING user state — never to stopping contact. So the final reminder announces
// the pause and offers to KEEP it going; ignoring lets the pause proceed exactly as
// today, now as informed silence.

// Whether THIS send is the last one before the hold takes effect — i.e. the streak is
// one short of the auto-pause line, so bumping it after this send reaches it.
export function isFinalMoodCheckin(ignoredCount: number): boolean {
  return ignoredCount === MOOD_CHECKIN_AUTOPAUSE_DAYS - 1;
}

// Whether the reminder is currently HELD by the auto-pause. Derived state, never a
// stored flag: `enabled` stays true and the hold lifts the moment a mood is logged, so
// the in-app "paused" presentation reads this rather than a second source of truth.
export function isMoodCheckinPaused(input: {
  enabled: boolean;
  ignoredCount: number;
}): boolean {
  return input.enabled && input.ignoredCount >= MOOD_CHECKIN_AUTOPAUSE_DAYS;
}

// The extra line the final reminder carries. No guilt, no streak language — the #992 /
// #716 sensitivity contract, which the no-gamification guard test keeps authoritative.
export const MOOD_CHECKIN_PAUSE_NOTICE =
  "No pressure — I'll pause these until you next log.";

// The in-app paused-state copy, shared by the dashboard card and the mood settings row
// so the two can't describe the same derived state differently.
export const MOOD_CHECKIN_PAUSED_LABEL = "Check-ins paused after quiet days";

// The ONE keep/resume decision (#1668), shared by the Telegram button and the in-app
// Resume action. Pure: the caller supplies the current state and performs the reset on
// a "kept" outcome, so both entry points answer identically and neither invents its own
// idea of what a resume means.
export function decideMoodKeep(input: {
  enabled: boolean;
  ignoredCount: number;
}): MoodKeepDecision {
  if (!input.enabled) return "not-enabled";
  // A streak already at zero means a logged mood re-armed it — the auto-resume path.
  return input.ignoredCount > 0 ? "kept" : "already-active";
}

export type MoodKeepDecision = "kept" | "already-active" | "not-enabled";

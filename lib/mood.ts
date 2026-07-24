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

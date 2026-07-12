// Deterministic, observational adherence-PATTERN findings (issue #45, domain 3).
// The plain adherence percentage says "you're at 78%"; these say WHERE the misses
// cluster and suggest a concrete schedule edit — the more actionable signal the
// issue asks for ("you miss the evening slot most Fridays — move it to morning?",
// weekday-vs-weekend asymmetry, slot-specific failure).
//
// Pure and client-safe — no DB/network. The detectors run over a single dose's
// per-day adherence strip (lib/supplement-adherence.doseStrip: "taken"/"partial"/
// "skipped"/"missed"/"na", oldest-first), which the server builder in
// lib/rule-findings.ts assembles from the already profile-scoped intake reads. Each
// finding rides the shared findings bus with a stable, dose-id-keyed dedupeKey
// (ids never recycle — AGENTS.md #203) so a page dismiss silences it. Every
// threshold is a named constant with its rationale; the boundaries are unit-tested
// in lib/__tests__/adherence-patterns.test.ts.
//
// These are OBSERVATIONS, not safety reminders — the scheduled dose reminder /
// missed-dose escalation stay their own (deliberately un-suppressible) machinery.
// A pattern finding just nudges a schedule tweak; it never competes with the tick.

import type { AdherenceDot } from "./supplement-adherence";
import type { TimeBucket } from "./supplement-schedule";

// ---- Window + thresholds --------------------------------------------------

// How many trailing days the pattern detectors read. Eight weeks gives ~8
// occurrences of each weekday — enough to tell a real Friday habit from a couple of
// coincidental misses, while old, already-fixed lapses roll off the back.
export const ADHERENCE_PATTERN_DAYS = 56;

// Don't infer any pattern until there's enough overall history for this dose (due,
// non-skipped days). Below this a single bad week reads as a "pattern".
export const MIN_APPLICABLE_DAYS = 14;

// ---- Weekday-specific miss (the "most Fridays" case) ----

// A weekday must recur at least this many times in the window before its miss rate
// is trustworthy — four Fridays, not one unlucky one.
export const MIN_WEEKDAY_OCCURRENCES = 4;

// …and that weekday must be missed at least this often to flag it.
export const WEEKDAY_MISS_RATE = 0.6;

// …AND be clearly worse than the other days: at least this many times their miss
// rate (or the other days near-perfect), so a uniformly-so-so dose isn't singled
// out on its worst weekday.
export const WEEKDAY_RATIO = 2;

// ---- Weekend vs weekday asymmetry ----

// Need at least this many applicable days on EACH side (weekend and weekday) before
// comparing the two rates.
export const WEEKEND_MIN_EACH = 6;

// Weekends must be missed at least this often, and at least WEEKEND_RATIO× the
// weekday miss rate, to call it an asymmetry.
export const WEEKEND_MISS_RATE = 0.5;
export const WEEKEND_RATIO = 2;

// ---- Signal keys (single source of truth) ---------------------------------
//
// Every adherence-pattern finding shares ONE dedupeKey namespace (`adherence:`) so
// the /medicine dismiss action guards the whole domain with a single prefix check
// (mirroring the training-observation / trajectory actions, #39/#45). Keyed on the
// DOSE id (AUTOINCREMENT, never recycles — AGENTS.md #203), so a rename/re-time of
// the supplement never re-attaches a stale dismissal to a different slot.
export const ADHERENCE_PREFIX = "adherence:";

// Legacy (pre-#436, episode-less) key builders — the old dose+weekday shapes. Kept
// only so a dismissal stored before #436 still suppresses the current finding via
// Finding.supersedes rather than orphaning; fresh dismissals write the episodic keys.
export function weekdayMissLegacyKey(doseId: number, weekday: number): string {
  return `${ADHERENCE_PREFIX}weekday:${doseId}:${weekday}`;
}

export function weekendAsymmetryLegacyKey(doseId: number): string {
  return `${ADHERENCE_PREFIX}weekend:${doseId}`;
}

// Episodic keys (#436): append a coarse PERIOD anchor (the builder passes the current
// year, YYYY) so a recurring same-weekday habit that returns a year later isn't
// silenced forever by one dismissal — a new period re-fires. The dose-id segment
// still keys on the AUTOINCREMENT id (never recycles, #203), so a rename/re-time
// never re-attaches a stale dismissal to a different slot.
export function weekdayMissSignalKey(
  doseId: number,
  weekday: number,
  periodAnchor: string
): string {
  return `${weekdayMissLegacyKey(doseId, weekday)}:${periodAnchor}`;
}

export function weekendAsymmetrySignalKey(
  doseId: number,
  periodAnchor: string
): string {
  return `${weekendAsymmetryLegacyKey(doseId)}:${periodAnchor}`;
}

// ---- Types ----------------------------------------------------------------

export type AdherencePatternKind = "weekday" | "weekend";

export interface AdherencePattern {
  kind: AdherencePatternKind;
  // Stable suppression/identity key (the finding's dedupeKey) — now episode-anchored
  // (#436). See the *SignalKey helpers above.
  key: string;
  // The pre-#436, episode-less shape of `key`, honored for suppression via
  // Finding.supersedes so upgrading the key never orphans a live dismissal.
  legacyKey: string;
  title: string;
  detail: string;
  // The dose the pattern is about — for the deep link + the re-key.
  doseId: number;
}

// The per-dose slice the detectors read: a scheduled dose's identity, its bucket
// (for the copy + the "move to morning" suggestion), and its per-day adherence
// strip over the window (oldest-first).
export interface DoseAdherenceInput {
  doseId: number;
  supplementName: string;
  bucket: TimeBucket;
  strip: AdherenceDot[];
  // The coarse period anchor (the current year, YYYY) appended to the finding's
  // episodic dedupeKey (#436), so a same-weekday habit recurring a year later isn't
  // permanently silenced by one dismissal. Supplied by the server builder from
  // `today`; optional (defaults to "") so older callers/tests are unchanged.
  periodAnchor?: string;
  // Suppress the "move it earlier in the day" schedule tweak (#430.4): a bedtime
  // slot ("Before sleep") is already as early as the day allows for its purpose,
  // and a medication's timing is prescribed, so "move it to the morning" is wrong
  // advice for a melatonin or an at-bedtime med. The builder sets this for the
  // Before-sleep bucket and for kind='medication'; the finding then falls back to
  // the neutral "a reminder might help" copy. Optional (defaults false) so older
  // callers/tests are unchanged.
  suppressMoveSuggestion?: boolean;
}

// The lower bound (YYYY-MM-DD) a dose's adherence pattern may be inferred from —
// the day the dose has existed with its CURRENT schedule (#430). A pattern window
// must never reach back before this, or it manufactures "phantom misses" on days
// the dose didn't exist (defeating the min-history gate) and re-accuses a re-timed
// dose for the weeks it sat in its OLD slot. Derived from the timestamps the
// builder reads:
//   - the parent item's created_at is the earliest the dose could have existed;
//   - the dose's own created_at (when present) refines that;
//   - the dose's updated_at (set whenever the schedule/time is edited) resets the
//     window on a re-time, so a dose moved evening→morning is judged only on days
//     it was actually a morning dose.
// The effective start is the LATEST of these (a re-time can only move it forward,
// never expose pre-creation days). Pure string-date math (each timestamp is
// "YYYY-MM-DD…", which sorts chronologically), so it's client-safe and testable.
export function doseAdherenceSince(
  itemCreatedAt: string | null | undefined,
  doseCreatedAt: string | null | undefined,
  doseUpdatedAt: string | null | undefined
): string | null {
  const dateOf = (t: string | null | undefined): string | null =>
    t ? t.slice(0, 10) : null;
  // The dose's own lifetime lower bound: its last re-time, else its creation,
  // else (no dose timestamps stored yet) the parent item's creation.
  const doseSince =
    dateOf(doseUpdatedAt) ?? dateOf(doseCreatedAt) ?? dateOf(itemCreatedAt);
  const candidates = [dateOf(itemCreatedAt), doseSince].filter(
    (d): d is string => d != null
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a >= b ? a : b));
}

// ---- Helpers --------------------------------------------------------------

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// UTC weekday index (0 = Sunday … 6 = Saturday) for an ISO YYYY-MM-DD date, or -1
// if unparseable. UTC so it never drifts with the runner's local timezone.
export function weekdayIndex(dateISO: string): number {
  const t = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(t)) return -1;
  return new Date(t).getUTCDay();
}

export function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? "that day";
}

// A day counts toward a pattern only when the dose was actually DUE and not a
// deliberate skip — "na" (not due) and "skipped" (a decision, #232) are transparent,
// exactly as they are to the adherence percentage.
function isApplicable(dot: AdherenceDot): boolean {
  return dot.state !== "na" && dot.state !== "skipped";
}

// A "missed" applicable day. "taken"/"partial" both count as a hit (some dose taken).
function isMiss(dot: AdherenceDot): boolean {
  return dot.state === "missed";
}

// The concrete schedule suggestion for a slot that keeps slipping. An evening/late
// slot most often slips because the day got away — an earlier slot tends to stick,
// so we suggest moving it; a morning slot that still slips wants a reminder, not an
// earlier time. `suppressMove` (#430.4) forces the reminder copy for slots where an
// "earlier in the day" nudge is wrong — a bedtime dose or a prescribed medication.
function moveSuggestion(bucket: TimeBucket, suppressMove: boolean): string {
  return bucket === "Morning" || suppressMove
    ? "A reminder on those days might help it stick."
    : "Moving it earlier in the day — to the morning — tends to help it stick.";
}

// ---- 1. Weekday-specific miss ---------------------------------------------

// The single worst weekday for a dose, when one weekday is both frequently missed
// AND clearly worse than the rest. Returns null when no weekday stands out. At most
// one weekday is flagged per dose (the worst), so the finding stays calm.
export function detectWeekdayMissPattern(
  input: DoseAdherenceInput
): AdherencePattern | null {
  const applicable = input.strip.filter(isApplicable);
  if (applicable.length < MIN_APPLICABLE_DAYS) return null;

  // Per-weekday occurrence + miss tallies.
  const occ = new Array(7).fill(0);
  const miss = new Array(7).fill(0);
  for (const dot of applicable) {
    const wd = weekdayIndex(dot.date);
    if (wd < 0) continue;
    occ[wd] += 1;
    if (isMiss(dot)) miss[wd] += 1;
  }

  let bestWd = -1;
  let bestRate = 0;
  for (let wd = 0; wd < 7; wd++) {
    if (occ[wd] < MIN_WEEKDAY_OCCURRENCES) continue;
    const rate = miss[wd] / occ[wd];
    if (rate < WEEKDAY_MISS_RATE) continue;
    // How this weekday compares to every OTHER day pooled together.
    const otherOcc = occ.reduce((a, v, i) => a + (i === wd ? 0 : v), 0);
    const otherMiss = miss.reduce((a, v, i) => a + (i === wd ? 0 : v), 0);
    const otherRate = otherOcc > 0 ? otherMiss / otherOcc : 0;
    // Clearly worse: the other days are near-perfect, or this day is ≥ratio× them.
    if (otherRate > 0 && rate < WEEKDAY_RATIO * otherRate) continue;
    // Keep the worst-offending weekday; ties break toward more occurrences.
    if (
      rate > bestRate ||
      (rate === bestRate && occ[wd] > (occ[bestWd] ?? 0))
    ) {
      bestWd = wd;
      bestRate = rate;
    }
  }
  if (bestWd < 0) return null;

  const day = weekdayName(bestWd);
  const bucketLower = input.bucket.toLowerCase();
  return {
    kind: "weekday",
    key: weekdayMissSignalKey(input.doseId, bestWd, input.periodAnchor ?? ""),
    legacyKey: weekdayMissLegacyKey(input.doseId, bestWd),
    title: `${input.supplementName}: ${day}s slip`,
    detail:
      `You miss your ${bucketLower} ${input.supplementName} dose most ${day}s ` +
      `— ${miss[bestWd]} of the last ${occ[bestWd]}. ` +
      `${moveSuggestion(input.bucket, input.suppressMoveSuggestion ?? false)}`,
    doseId: input.doseId,
  };
}

// ---- 2. Weekend vs weekday asymmetry --------------------------------------

// A weekend-vs-weekday miss asymmetry for a dose, or null when the two sides are
// comparable / there isn't enough of each. Weekend = Saturday + Sunday.
export function detectWeekendAsymmetry(
  input: DoseAdherenceInput
): AdherencePattern | null {
  const applicable = input.strip.filter(isApplicable);
  if (applicable.length < MIN_APPLICABLE_DAYS) return null;

  let weOcc = 0;
  let weMiss = 0;
  let wdOcc = 0;
  let wdMiss = 0;
  for (const dot of applicable) {
    const wd = weekdayIndex(dot.date);
    if (wd < 0) continue;
    const weekend = wd === 0 || wd === 6;
    if (weekend) {
      weOcc += 1;
      if (isMiss(dot)) weMiss += 1;
    } else {
      wdOcc += 1;
      if (isMiss(dot)) wdMiss += 1;
    }
  }
  if (weOcc < WEEKEND_MIN_EACH || wdOcc < WEEKEND_MIN_EACH) return null;

  const weRate = weMiss / weOcc;
  const wdRate = wdMiss / wdOcc;
  if (weRate < WEEKEND_MISS_RATE) return null;
  if (
    !(wdRate === 0
      ? weRate >= WEEKEND_MISS_RATE
      : weRate >= WEEKEND_RATIO * wdRate)
  )
    return null;

  const wePct = Math.round(weRate * 100);
  const wdPct = Math.round(wdRate * 100);
  const bucketLower = input.bucket.toLowerCase();
  return {
    kind: "weekend",
    key: weekendAsymmetrySignalKey(input.doseId, input.periodAnchor ?? ""),
    legacyKey: weekendAsymmetryLegacyKey(input.doseId),
    title: `${input.supplementName}: weekends slip`,
    detail:
      `Your ${bucketLower} ${input.supplementName} dose slips more on weekends ` +
      `— missed ${wePct}% of weekend days versus ${wdPct}% on weekdays. A ` +
      `weekend-specific reminder might help.`,
    doseId: input.doseId,
  };
}

// ---- Composition ----------------------------------------------------------

// The (at most one) pattern for a single dose. Prefer the sharper weekday signal —
// if a specific weekday stands out, a Saturday/Sunday asymmetry over the same misses
// would just restate it, so we don't double-flag one dose. Falls back to the weekend
// asymmetry when no single weekday dominates.
export function detectDoseAdherencePatterns(
  input: DoseAdherenceInput
): AdherencePattern[] {
  const weekday = detectWeekdayMissPattern(input);
  if (weekday) return [weekday];
  const weekend = detectWeekendAsymmetry(input);
  return weekend ? [weekend] : [];
}

// Every adherence-pattern finding across a profile's scheduled doses, deterministic
// (by supplement name, then dose id). The caller applies the shared findings-bus
// suppression filter.
export function detectAdherencePatterns(
  inputs: readonly DoseAdherenceInput[]
): AdherencePattern[] {
  const out: { pat: AdherencePattern; name: string; doseId: number }[] = [];
  for (const input of inputs)
    for (const pat of detectDoseAdherencePatterns(input))
      out.push({ pat, name: input.supplementName, doseId: input.doseId });
  return out
    .sort((a, b) => a.name.localeCompare(b.name) || a.doseId - b.doseId)
    .map((x) => x.pat);
}

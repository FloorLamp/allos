// Pure parser for the command palette's inline quick-log syntax (issue #29, extended
// for wellness practices in #1633).
//
// The highest-value one-liner is logging bodyweight: typing `weight 82.5` (or
// `wt 82.5`, `w 82.5 kg`, `bw 180 lb`) into the palette parses to a body-metrics
// weight entry that Enter commits directly — no navigation. The second is logging a
// practice you already track: `log sauna` commits one session for today. This module is
// the PURE half: it recognizes the command, extracts what it needs, and reuses the same
// guards the real forms use, so the palette can show a live preview and the server
// action can re-parse the exact same way. DB-free, so it lives in the pure vitest suite.

import { validateBodyMetricInput } from "./body-metric-input";
import { practiceIdentity } from "./practice";
import type { WeightUnit } from "./settings";

export interface QuickLogWeight {
  type: "weight";
  // The parsed magnitude, in `unit` (the display unit — never converted here;
  // the write boundary converts to canonical kg).
  value: number;
  unit: WeightUnit;
  // A short human preview for the palette row ("Log weight · 82.5 kg").
  label: string;
  // Non-null when the command was recognized but the value is unusable, so the
  // palette can show the reason and refuse to commit. null when valid.
  error: string | null;
}

// One tracked practice as the parser needs to recognize it: the folded identity and the
// stored spelling to write. The set is FINITE and server-owned (the practice-scope
// frequency targets, lib/queries/wellness.ts `getTrackedPractices`) — the #394
// finite-preimage posture, so free text can never invent a practice here. The palette
// gathers it once per open; the server action re-derives it before writing.
export interface QuickLogPracticeOption {
  identity: string;
  name: string;
}

export interface QuickLogPractice {
  type: "practice";
  // The stored spelling to log, exactly as the tracked target names it — so a quick log
  // lands in the same identity family the Wellness card counts.
  practice: string;
  identity: string;
  label: string;
  // Kept for a uniform row shape with the weight command; a practice command is only
  // ever produced for a name that IS tracked, so it is always null today.
  error: string | null;
}

export type QuickLogCommand = QuickLogWeight | QuickLogPractice;

// Keywords that introduce a weight quick-log. Matched case-insensitively as the
// first whitespace-delimited token.
const WEIGHT_KEYWORDS = new Set(["weight", "wt", "w", "bw", "bodyweight"]);

// Verbs that introduce a practice quick-log. A practice command deliberately REQUIRES
// one: a bare "sauna" is a search — the word people type when they want to find the
// practice — and turning it into a highlighted row that Enter commits would make an
// accidental session log the cost of looking something up. `log <thing>` is already the
// palette's taught shape ("log workout" is in its placeholder), so the safe grammar is
// also the familiar one. None of these is a weight keyword, so the two commands cannot
// collide by construction, whatever a user names their practice.
const PRACTICE_KEYWORDS = new Set(["log", "did", "done"]);

// Parse a palette input into a quick-log command, or null when the input is not
// a quick-log at all (so the palette falls through to normal search). A
// recognized-but-invalid command returns an object with a non-null `error`.
//
// `weightUnit` is the login's display preference; a value with no explicit unit
// is interpreted in it. An explicit trailing `kg`/`lb` overrides the preference.
// `practices` is the caller's tracked-practice set; an empty list (the default) simply
// means no input can parse as a practice.
export function parseQuickLog(
  input: string,
  weightUnit: WeightUnit,
  practices: readonly QuickLogPracticeOption[] = []
): QuickLogCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx < 0) return null; // a bare keyword with no value isn't a command yet
  const keyword = trimmed.slice(0, spaceIdx).toLowerCase();
  const rest = trimmed.slice(spaceIdx + 1).trim();

  // Weight FIRST: its keywords are the older, shorter vocabulary, and a practice
  // someone happened to name "weight" must not be able to shadow `weight 82.5`.
  if (WEIGHT_KEYWORDS.has(keyword)) return parseWeightEntry(rest, weightUnit);
  if (PRACTICE_KEYWORDS.has(keyword)) return parsePractice(rest, practices);
  return null;
}

// Parse a bare weight ENTRY — the part after the palette's keyword, and the whole of a
// Telegram `/weight` reply (#1895). Exported because those two surfaces ask the same
// question ("is this text a weight, and is it plausible?") and a second grammar for it
// is how "82,5" or "180 lbs" comes to mean one thing in the palette and another in the
// chat. `weightUnit` is the unit an unsuffixed number is read in — the login's display
// preference in the palette, canonical kg in a chat, which has no login context.
export function parseWeightEntry(
  rest: string,
  weightUnit: WeightUnit
): QuickLogWeight {
  // Accept an optional trailing unit: "82.5", "82.5kg", "180 lb".
  const m = rest.match(/^([0-9]*\.?[0-9]+)\s*(kg|lb|lbs)?$/i);
  if (!m) {
    return {
      type: "weight",
      value: NaN,
      unit: weightUnit,
      label: "Log weight",
      error: "Enter a number, e.g. weight 82.5",
    };
  }
  const value = Number(m[1]);
  const unitToken = m[2]?.toLowerCase();
  const unit: WeightUnit = unitToken
    ? unitToken.startsWith("lb")
      ? "lb"
      : "kg"
    : weightUnit;

  // Reuse the form's range guard so the palette and the form reject the same
  // out-of-range values with the same message.
  const error = validateBodyMetricInput({
    weight: m[1],
    bodyFatPct: null,
    restingHr: null,
  });

  return {
    type: "weight",
    value,
    unit,
    label: `Log weight · ${m[1]} ${unit}`,
    error,
  };
}

// Match the remainder against the tracked set through `practiceIdentity` — the ONE
// practice identity every surface keys on, so "Cold Plunge", "cold plunge" and
// " cold  plunge " all reach the same practice, and nothing else does (case and
// whitespace only; synonyms are deliberately not folded). An unrecognized name is NOT a
// command — it falls through to search rather than offering to create something.
function parsePractice(
  rest: string,
  practices: readonly QuickLogPracticeOption[]
): QuickLogPractice | null {
  const identity = practiceIdentity(rest);
  if (!identity) return null;
  const match = practices.find((p) => p.identity === identity);
  if (!match) return null;
  return {
    type: "practice",
    practice: match.name,
    identity: match.identity,
    label: `Log practice · ${match.name}`,
    error: null,
  };
}

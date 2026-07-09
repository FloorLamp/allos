// Pure parser for the command palette's inline quick-log syntax (issue #29).
//
// The highest-value one-liner is logging bodyweight: typing `weight 82.5` (or
// `wt 82.5`, `w 82.5 kg`, `bw 180 lb`) into the palette parses to a body-metrics
// weight entry that Enter commits directly — no navigation. This module is the
// PURE half: it recognizes the command, extracts the number + unit, and reuses
// the same range guard the body-metrics form uses (validateBodyMetricInput), so
// the palette can show a live preview and the server action can re-parse the
// exact same way. DB-free, so it lives in the pure vitest suite.

import { validateBodyMetricInput } from "./body-metric-input";
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

// Keywords that introduce a weight quick-log. Matched case-insensitively as the
// first whitespace-delimited token.
const WEIGHT_KEYWORDS = new Set(["weight", "wt", "w", "bw", "bodyweight"]);

// Parse a palette input into a quick-log command, or null when the input is not
// a quick-log at all (so the palette falls through to normal search). A
// recognized-but-invalid command returns an object with a non-null `error`.
//
// `weightUnit` is the login's display preference; a value with no explicit unit
// is interpreted in it. An explicit trailing `kg`/`lb` overrides the preference.
export function parseQuickLog(
  input: string,
  weightUnit: WeightUnit
): QuickLogWeight | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx < 0) return null; // a bare keyword with no value isn't a command yet
  const keyword = trimmed.slice(0, spaceIdx).toLowerCase();
  if (!WEIGHT_KEYWORDS.has(keyword)) return null;

  const rest = trimmed.slice(spaceIdx + 1).trim();
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

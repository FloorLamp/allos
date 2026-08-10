// Pure normalization for the manual waist-circumference field on the combined "Log
// measurements" form (no DB, no React) — unit-tested in
// lib/__tests__/waist-input.test.ts. Waist circumference has a single home in
// metric_samples (metric 'waist_circumference_cm'), the same place the
// document-extraction writer lands it, so a tape reading typed at home is picked up
// by the `waist-circ` chart identically to an imported one.
//
// It is the SIBLING of lib/growth-input.ts, not a member of it: "growth" is the
// life-stage-gated height/head-circumference pair the WHO/CDC percentile card reads,
// and a waist measurement is neither gated nor plotted against a growth curve. What
// the two share is the discipline — reuse the extract module's converter
// (`waistCircToCm`) so a manual entry passes the exact same plausibility band and
// cm/in/m unit handling as an imported reading, never a second divergent parser.

import { waistCircToCm } from "./waist-circ-extract";

export interface WaistInputRaw {
  waistCirc: string | null;
  waistCircUnit: string | null; // 'cm' | 'in'
}

// A blank/whitespace field is "not measured" (skipped); a present-but-unparseable
// number is a hard error so the form can't show a false "saved".
function parseField(raw: string | null): number | null | "blank" {
  const t = (raw ?? "").trim();
  if (t === "") return "blank";
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type WaistInputResult = { valueCm: number } | { error: string };

// Fold the raw form field into the canonical cm value to upsert, or a single
// user-facing error. A present-but-implausible value (caught by the shared converter's
// band) is a hard error rather than a silent skip.
export function normalizeWaistInput(input: WaistInputRaw): WaistInputResult {
  const w = parseField(input.waistCirc);
  if (w === null || w === "blank") {
    return { error: "Enter a valid waist measurement." };
  }
  const cm = waistCircToCm(w, input.waistCircUnit);
  if (cm == null)
    return { error: "That waist measurement looks out of range." };
  return { valueCm: cm };
}

// Client-side pre-check mirroring the action: returns the error message, or null when
// the input would persist. Lets the form surface an inline error instead of a silent
// no-op.
export function validateWaistInput(input: WaistInputRaw): string | null {
  const res = normalizeWaistInput(input);
  return "error" in res ? res.error : null;
}

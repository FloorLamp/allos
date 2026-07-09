// Pure normalization for the manual height / head-circumference quick-add on the
// Trends → Body tab (no DB, no React) — unit-tested in
// lib/__tests__/growth-input.test.ts. Height and head circumference have a single
// home in metric_samples (metrics 'height_cm' / 'head_circumference_cm'), the same
// place the document-extraction writers land them, so a manually entered value is
// picked up identically by the WHO/CDC growth charts. This mirrors the reused
// converters (heightToCm / headCircToCm from the extract modules) so a manual
// entry passes the exact same plausibility bands + cm/in/m unit handling as an
// imported reading — never a second, divergent parser.

import { heightToCm } from "./height-extract";
import { headCircToCm } from "./head-circ-extract";

export interface GrowthInputRaw {
  height: string | null;
  heightUnit: string | null; // 'cm' | 'in'
  headCirc: string | null;
  headCircUnit: string | null; // 'cm' | 'in'
}

// One canonical metric_samples sample to upsert (value already in cm).
export interface GrowthSample {
  metric: "height_cm" | "head_circumference_cm";
  value: number;
}

export type GrowthInputResult = { samples: GrowthSample[] } | { error: string };

// A blank/whitespace field is "not measured" (skipped); a present-but-unparseable
// number is a hard error so the form can't show a false "saved".
function parseField(raw: string | null): number | null | "blank" {
  const t = (raw ?? "").trim();
  if (t === "") return "blank";
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Fold the raw form fields into the metric_samples cm values to upsert, or a
// single user-facing error. At least one measurement is required; a
// present-but-implausible value (caught by the shared cm converters' bands) is a
// hard error rather than a silent skip.
export function normalizeGrowthInput(input: GrowthInputRaw): GrowthInputResult {
  const samples: GrowthSample[] = [];

  const h = parseField(input.height);
  if (h === null) return { error: "Enter a valid height." };
  if (h !== "blank") {
    const cm = heightToCm(h, input.heightUnit);
    if (cm == null) return { error: "That height looks out of range." };
    samples.push({ metric: "height_cm", value: cm });
  }

  const hc = parseField(input.headCirc);
  if (hc === null) return { error: "Enter a valid head circumference." };
  if (hc !== "blank") {
    const cm = headCircToCm(hc, input.headCircUnit);
    if (cm == null)
      return { error: "That head circumference looks out of range." };
    samples.push({ metric: "head_circumference_cm", value: cm });
  }

  if (samples.length === 0) {
    return { error: "Enter a height or head circumference." };
  }
  return { samples };
}

// Client-side pre-check mirroring the action: returns the first error message, or
// null when the input would persist at least one sample. Lets the form surface an
// inline error instead of a silent no-op.
export function validateGrowthInput(input: GrowthInputRaw): string | null {
  const res = normalizeGrowthInput(input);
  return "error" in res ? res.error : null;
}

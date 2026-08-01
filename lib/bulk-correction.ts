// Bulk corrections (issue #1603) — the PURE half.
//
// A bad RUN of data (a scale miscalibrated for three months, an import that landed
// pounds as kilograms) is otherwise fixable only row-at-a-time, so in practice the
// bad run stays and skews trends, coaching, and goal pacing. This module owns the
// closed vocabulary of what can be corrected and the plan → signature math; the
// impure half (lib/bulk-correction-db.ts) applies a plan in one writeTx and the
// Server Actions in app/(app)/data/bulk-correction-actions.ts own the gate.
//
// Deliberately CLOSED, not freeform: the v1 fields are scalar numeric columns on
// body_metrics / metric_samples plus activities.distance_km, and the operations are
// add / multiply / set plus a unit preset that is just multiply wired to the
// existing lb→kg / mi→km boundary constants. No SQL, no expressions.
// `medical_records` values (flag re-derivation + corrected-lab semantics, #1404)
// and bulk DELETE (row-ops-carry-side-state, a v2 with its own undo story) are
// intentionally out of scope.
//
// Values crossing this module are in CANONICAL stored units (kg, km, %, bpm, ms).
// Display-unit conversion happens once, at the action boundary
// (`resolveCorrectionOp` / `formatCorrectionValue`), as everywhere else.

import type { DistanceUnit, WeightUnit } from "./settings";
import { kgTo, kmTo, LB_PER_KG, MI_PER_KM, round } from "./units";

export type CorrectionFieldId =
  "weight" | "body-fat" | "resting-hr" | "hrv" | "distance";

export interface CorrectionFieldSpec {
  id: CorrectionFieldId;
  /** Human name for pickers and summaries. */
  label: string;
  /** The store the field lives in (SQL stays literal in the impure half). */
  table: "body_metrics" | "metric_samples" | "activities";
  /** The stored column (or `value` for metric_samples), for the non-PHI label. */
  column: string;
  /** metric_samples discriminator; absent for column-per-metric stores. */
  metric?: string;
  /** Canonical stored unit, for display suffixes ("" for unitless %). */
  unit: string;
  /** Whole-number field (resting HR) — results are rounded to integers. */
  integer?: boolean;
  /** Upper bound where the domain has one (body fat can't exceed 100%). */
  max?: number;
  /**
   * The field's unit-mixup preset ("these values were imported in the wrong
   * unit"), compiled to a plain multiply at the boundary. Only fields whose
   * canonical unit has a common imperial twin carry one.
   */
  preset?: { id: "lb-to-kg" | "mi-to-km"; label: string; factor: number };
}

// The closed v1 field registry. Tables/columns/metric names mirror
// lib/metric-readings.ts' METRIC_READING_STORE (which the detail pages read
// through); they are re-declared here because this module must stay pure (that
// registry's module imports the db singleton).
export const CORRECTION_FIELDS: Record<CorrectionFieldId, CorrectionFieldSpec> =
  {
    weight: {
      id: "weight",
      label: "Weight",
      table: "body_metrics",
      column: "weight_kg",
      unit: "kg",
      preset: {
        id: "lb-to-kg",
        label: "Convert lb → kg (values were imported as pounds)",
        factor: 1 / LB_PER_KG,
      },
    },
    "body-fat": {
      id: "body-fat",
      label: "Body fat",
      table: "body_metrics",
      column: "body_fat_pct",
      unit: "%",
      max: 100,
    },
    "resting-hr": {
      id: "resting-hr",
      label: "Resting heart rate",
      table: "body_metrics",
      column: "resting_hr",
      unit: "bpm",
      integer: true,
    },
    hrv: {
      id: "hrv",
      label: "HRV",
      table: "metric_samples",
      column: "value",
      metric: "hrv_ms",
      unit: "ms",
    },
    distance: {
      id: "distance",
      label: "Activity distance",
      table: "activities",
      column: "distance_km",
      unit: "km",
      preset: {
        id: "mi-to-km",
        label: "Convert mi → km (values were imported as miles)",
        factor: 1 / MI_PER_KM,
      },
    },
  };

export function isCorrectionFieldId(raw: unknown): raw is CorrectionFieldId {
  return typeof raw === "string" && raw in CORRECTION_FIELDS;
}

// The closed operation set, in CANONICAL units. A preset has already been
// compiled to its multiply by the time an op reaches the planner.
export type CorrectionOp =
  | { kind: "add"; amount: number }
  | { kind: "multiply"; factor: number }
  | { kind: "set"; value: number };

// What the client submits: the op kind, one number (display units for add/set),
// or the field's unit preset (no number). Kept serializable-flat on purpose.
export interface RawCorrectionOp {
  kind: "add" | "multiply" | "set" | "unit-preset";
  value?: number | null;
}

/**
 * Resolve a submitted op to a canonical one — the ONE unit boundary for this
 * feature. Weight offsets/targets arrive in the login's weight unit and convert
 * to kg; distance likewise to km; factors are unitless; a preset compiles to the
 * field's registered multiply. Returns null for anything malformed (zero/negative
 * factor, non-finite number, preset on a field without one) — a refused no-op,
 * never a guessed write.
 */
export function resolveCorrectionOp(
  field: CorrectionFieldId,
  raw: RawCorrectionOp,
  units: { weightUnit: WeightUnit; distanceUnit: DistanceUnit }
): CorrectionOp | null {
  const spec = CORRECTION_FIELDS[field];
  if (raw.kind === "unit-preset") {
    return spec.preset
      ? { kind: "multiply", factor: spec.preset.factor }
      : null;
  }
  const value = raw.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Linear unit scale for the two fields whose display unit can differ from
  // canonical. Offsets and absolute targets scale identically (no affine units
  // here), so one factor serves both `add` and `set`.
  const scale =
    field === "weight" && units.weightUnit === "lb"
      ? 1 / LB_PER_KG
      : field === "distance" && units.distanceUnit === "mi"
        ? 1 / MI_PER_KM
        : 1;
  switch (raw.kind) {
    case "add":
      return value === 0 ? null : { kind: "add", amount: value * scale };
    case "multiply":
      return value <= 0 ? null : { kind: "multiply", factor: value };
    case "set":
      return value < 0 ? null : { kind: "set", value: value * scale };
    default:
      return null;
  }
}

/** One input row, in canonical units (as selected by the impure half). */
export interface CorrectionRow {
  id: number;
  value: number;
}

/** One planned change — the unit the preview, apply, and undo all share. */
export interface CorrectionChange {
  id: number;
  field: CorrectionFieldId;
  before: number;
  after: number;
}

export interface CorrectionSummary {
  count: number;
  beforeMin: number;
  beforeMax: number;
  afterMin: number;
  afterMax: number;
}

export type CorrectionPlanResult =
  | {
      ok: true;
      changes: CorrectionChange[];
      /** Rows the op leaves exactly as they are (excluded from the plan). */
      unchanged: number;
      /** null when every row is unchanged. */
      summary: CorrectionSummary | null;
    }
  // The transform is supposed to be uniform over the run, so a result outside the
  // field's domain (a negative weight, body fat above 100%) refuses the WHOLE
  // plan rather than silently correcting a subset.
  | { ok: false; error: "out-of-range"; count: number };

// Canonical result rounding: integers for whole-number fields, otherwise 6
// decimals so float noise (79.00000000000001) never lands in storage or makes a
// no-op look like a change.
function roundResult(spec: CorrectionFieldSpec, x: number): number {
  return spec.integer ? Math.round(x) : round(x, 6);
}

function applyOp(op: CorrectionOp, before: number): number {
  switch (op.kind) {
    case "add":
      return before + op.amount;
    case "multiply":
      return before * op.factor;
    case "set":
      return op.value;
  }
}

/**
 * Plan a correction over a run of rows: each row's before → after under the op,
 * with no-op rows counted but excluded. Pure — the impure half re-runs this under
 * the write lock so preview and apply can never disagree about the math.
 */
export function planCorrection(
  field: CorrectionFieldId,
  rows: readonly CorrectionRow[],
  op: CorrectionOp
): CorrectionPlanResult {
  const spec = CORRECTION_FIELDS[field];
  const changes: CorrectionChange[] = [];
  let unchanged = 0;
  let outOfRange = 0;
  for (const row of rows) {
    const after = roundResult(spec, applyOp(op, row.value));
    if (
      !Number.isFinite(after) ||
      after < 0 ||
      (spec.max != null && after > spec.max)
    ) {
      outOfRange++;
      continue;
    }
    if (after === row.value) {
      unchanged++;
      continue;
    }
    changes.push({ id: row.id, field, before: row.value, after });
  }
  if (outOfRange > 0)
    return { ok: false, error: "out-of-range", count: outOfRange };
  let summary: CorrectionSummary | null = null;
  for (const c of changes) {
    if (!summary) {
      summary = {
        count: 0,
        beforeMin: c.before,
        beforeMax: c.before,
        afterMin: c.after,
        afterMax: c.after,
      };
    }
    summary.count++;
    summary.beforeMin = Math.min(summary.beforeMin, c.before);
    summary.beforeMax = Math.max(summary.beforeMax, c.before);
    summary.afterMin = Math.min(summary.afterMin, c.after);
    summary.afterMax = Math.max(summary.afterMax, c.after);
  }
  return { ok: true, changes, unchanged, summary };
}

/**
 * Canonical signature of a plan's (id, before) pairs — the compare-and-set token
 * (the #467 grantSignature treatment, applied to a bulk write). The preview hands
 * it to the client; apply re-reads under the write lock, re-plans, and refuses
 * when the signatures no longer match (a sync can land mid-preview). FNV-1a 64-bit
 * over the canonical pair list: deterministic, dependency-free, and the failure
 * mode of a (astronomically unlikely) collision is applying exactly the numbers
 * the user previewed — the same trust boundary as the data itself.
 */
export function correctionSignature(
  changes: readonly { id: number; before: number }[]
): string {
  const text = `${changes.length};${changes
    .map((c) => `${c.id}:${c.before}`)
    .join("|")}`;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

// ---- The deleted_rows snapshot (undo) ----

/** The deleted_rows.kind for a bulk-correction inverse snapshot. */
export const BULK_CORRECTION_KIND = "bulk-correction";

/**
 * The non-PHI deleted_rows.label — table · column · row count, like
 * "body_metrics · weight_kg · 92 rows". Identifying content stays in the payload.
 */
export function bulkCorrectionLabel(
  field: CorrectionFieldId,
  count: number
): string {
  const spec = CORRECTION_FIELDS[field];
  return `${spec.table} · ${spec.column} · ${count} ${count === 1 ? "row" : "rows"}`;
}

export interface BulkCorrectionPayloadChange {
  id: number;
  before: number;
  after: number;
  /** Whether THIS correction set the row's #133 edit lock (so undo clears it). */
  lockSet: boolean;
}

export interface BulkCorrectionPayload {
  v: 1;
  kind: typeof BULK_CORRECTION_KIND;
  field: CorrectionFieldId;
  changes: BulkCorrectionPayloadChange[];
}

export function serializeBulkCorrectionPayload(
  field: CorrectionFieldId,
  changes: readonly BulkCorrectionPayloadChange[]
): string {
  const payload: BulkCorrectionPayload = {
    v: 1,
    kind: BULK_CORRECTION_KIND,
    field,
    changes: [...changes],
  };
  return JSON.stringify(payload);
}

/** Parse + validate a stored payload. Returns null on any shape mismatch. */
export function parseBulkCorrectionPayload(
  json: string
): BulkCorrectionPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const p = parsed as BulkCorrectionPayload;
  if (
    !p ||
    p.v !== 1 ||
    p.kind !== BULK_CORRECTION_KIND ||
    !isCorrectionFieldId(p.field) ||
    !Array.isArray(p.changes)
  ) {
    return null;
  }
  for (const c of p.changes) {
    if (
      !c ||
      !Number.isInteger(c.id) ||
      typeof c.before !== "number" ||
      typeof c.after !== "number" ||
      typeof c.lockSet !== "boolean"
    ) {
      return null;
    }
  }
  return p;
}

/**
 * A canonical value formatted for the preview, in the login's display unit — the
 * read-side twin of resolveCorrectionOp's write-side conversion.
 */
export function formatCorrectionValue(
  field: CorrectionFieldId,
  canonical: number,
  units: { weightUnit: WeightUnit; distanceUnit: DistanceUnit }
): string {
  switch (field) {
    case "weight":
      return `${round(kgTo(canonical, units.weightUnit), 1)} ${units.weightUnit}`;
    case "distance":
      return `${round(kmTo(canonical, units.distanceUnit), 2)} ${units.distanceUnit}`;
    case "body-fat":
      return `${round(canonical, 1)}%`;
    case "resting-hr":
      return `${Math.round(canonical)} bpm`;
    case "hrv":
      return `${round(canonical, 1)} ms`;
  }
}

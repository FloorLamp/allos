// Read/derive layer for N-of-1 protocols (issue #161). Protocol CRUD reads plus
// the DB SEAM over the pure comparison engine: it gathers each declared outcome
// metric's profile-scoped time-series (biomarker readings, body metrics, or a
// derived index) and hands them to lib/protocol-compare, so the detail page's
// before/during panels are a thin formatter over ONE pure computation (the
// "one question, one computation" rule). Body-weight samples are converted to the
// login's display unit HERE (the units boundary), keeping the engine unit-agnostic.

import { db } from "../db";
import { getBiomarkerSeries, getCanonicalBiomarker } from "./medical";
import { getBodyMetrics } from "./metrics";
import { getBioAgeReadings } from "./derived";
import { getSleepRegularityTrend } from "./sleep";
import { kgTo } from "../units";
import type { WeightUnit } from "../settings";
import type { Protocol } from "../types";
import {
  FIXED_OUTCOME_METRICS,
  fixedMetricDef,
  outcomeMetricLabel,
  parseOutcomeKey,
  type OutcomeDirection,
} from "../protocol-metrics";
import {
  compareProtocol,
  type OutcomeSample,
  type OutcomeSeries,
  type ProtocolComparison,
} from "../protocol-compare";
import { getUsedCanonicalNames } from "./medical";

interface ProtocolRow {
  id: number;
  name: string;
  start_date: string;
  end_date: string | null;
  notes: string | null;
  situation: string | null;
  outcome_keys: string;
  created_at: string;
}

// Parse the stored JSON outcome-key array defensively — a malformed blob yields an
// empty set rather than throwing.
function parseOutcomeKeys(v: string | null): string[] {
  if (!v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function toProtocol(r: ProtocolRow): Protocol {
  return {
    id: r.id,
    name: r.name,
    start_date: r.start_date,
    end_date: r.end_date,
    notes: r.notes,
    situation: r.situation,
    outcomeKeys: parseOutcomeKeys(r.outcome_keys),
    created_at: r.created_at,
  };
}

// All protocols for a profile: ongoing (no end date) first, then most-recently
// started. Profile-scoped.
export function getProtocols(profileId: number): Protocol[] {
  const rows = db
    .prepare(
      `SELECT * FROM protocols WHERE profile_id = ?
       ORDER BY (end_date IS NOT NULL) ASC, start_date DESC, id DESC`
    )
    .all(profileId) as ProtocolRow[];
  return rows.map(toProtocol);
}

// A single protocol by id, scoped to the profile so a guessed id from another
// profile 404s. Null when absent.
export function getProtocol(profileId: number, id: number): Protocol | null {
  const row = db
    .prepare("SELECT * FROM protocols WHERE id = ? AND profile_id = ?")
    .get(id, profileId) as ProtocolRow | undefined;
  return row ? toProtocol(row) : null;
}

// True when any OTHER (still-ongoing) protocol for this profile declares the given
// situation label — used to decide whether ending/deleting a protocol should also
// deactivate the situation it activated (row-side-state rule: don't clobber a
// situation another live protocol still needs).
export function situationUsedByOtherProtocol(
  profileId: number,
  situation: string,
  exceptId: number
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM protocols
       WHERE profile_id = ? AND id != ? AND end_date IS NULL
         AND situation = ? COLLATE NOCASE LIMIT 1`
    )
    .get(profileId, exceptId, situation);
  return !!row;
}

// An option in the outcome-metric picker: the fixed metrics plus the profile's
// tracked biomarkers. Grouped so the form can render headings.
export interface OutcomeOption {
  key: string;
  label: string;
  group: "Body & indices" | "Biomarkers";
}

export function getProtocolOutcomeOptions(profileId: number): OutcomeOption[] {
  const fixed: OutcomeOption[] = FIXED_OUTCOME_METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    group: "Body & indices",
  }));
  const biomarkers: OutcomeOption[] = getUsedCanonicalNames(profileId).map(
    (name) => ({
      key: `biomarker:${name}`,
      label: name,
      group: "Biomarkers",
    })
  );
  return [...fixed, ...biomarkers];
}

// Resolve one outcome key to its labeled series for a profile. Returns null when
// the key doesn't parse. Body weight is converted to the login's display unit.
function resolveOutcomeSeries(
  profileId: number,
  key: string,
  weightUnit: WeightUnit
): OutcomeSeries | null {
  const parsed = parseOutcomeKey(key);
  if (!parsed) return null;

  if (parsed.kind === "biomarker") {
    const cb = getCanonicalBiomarker(parsed.id);
    const samples: OutcomeSample[] = getBiomarkerSeries(profileId, parsed.id)
      .filter((r) => r.value_num != null)
      .map((r) => ({ date: r.date, value: r.value_num as number }));
    return {
      key,
      label: parsed.id,
      unit: cb?.unit ?? null,
      direction: (cb?.direction as OutcomeDirection | undefined) ?? "in_range",
      samples,
    };
  }

  if (parsed.kind === "body") {
    const def = fixedMetricDef(key);
    const rows = getBodyMetrics(profileId);
    const samples: OutcomeSample[] = [];
    for (const r of rows) {
      if (parsed.id === "weight" && r.weight_kg != null) {
        samples.push({ date: r.date, value: kgTo(r.weight_kg, weightUnit) });
      } else if (parsed.id === "resting_hr" && r.resting_hr != null) {
        samples.push({ date: r.date, value: r.resting_hr });
      } else if (parsed.id === "body_fat" && r.body_fat_pct != null) {
        samples.push({ date: r.date, value: r.body_fat_pct });
      }
    }
    return {
      key,
      label: def?.label ?? outcomeMetricLabel(key),
      unit: parsed.id === "weight" ? weightUnit : (def?.unit ?? null),
      direction: def?.direction ?? "neutral",
      samples,
    };
  }

  // index:*
  const def = fixedMetricDef(key);
  let samples: OutcomeSample[] = [];
  if (parsed.id === "phenoage") {
    samples = getBioAgeReadings(profileId).draws.map((d) => ({
      date: d.date,
      value: d.bioAge,
    }));
  } else if (parsed.id === "sri") {
    samples = getSleepRegularityTrend(profileId).map((t) => ({
      date: t.date,
      value: t.sri,
    }));
  }
  return {
    key,
    label: def?.label ?? outcomeMetricLabel(key),
    unit: def?.unit ?? null,
    direction: def?.direction ?? "neutral",
    samples,
  };
}

// The full before/during comparison for a protocol. `today` is the profile-local
// date (tz-window convention); the caller passes it so this stays a pure pass-
// through over compareProtocol once the series are gathered.
export function getProtocolComparison(
  profileId: number,
  protocol: Protocol,
  today: string,
  weightUnit: WeightUnit
): ProtocolComparison {
  const series = protocol.outcomeKeys
    .map((k) => resolveOutcomeSeries(profileId, k, weightUnit))
    .filter((s): s is OutcomeSeries => s != null);
  return compareProtocol(series, {
    startDate: protocol.start_date,
    endDate: protocol.end_date,
    today,
  });
}

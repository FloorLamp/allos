// Pure reprocess-DIFF logic (issue #208, Phase 3). A reprocess re-runs extraction
// and REPLACES a document's imported rows; before Phase 3 that happened silently.
// This module lets the UI PREVIEW what a fresh re-extraction would change against
// what's currently persisted, per entity type, so the user confirms an informed
// diff instead of a blind overwrite.
//
// It is strictly pure (no DB/network) so it unit-tests in lib/__tests__: the DB
// side (lib/queries/imports.getReprocessSnapshot) reads the currently-persisted
// rows and the extraction side (a fresh PersistInput, never written) both reduce
// to the SAME neutral `ImportSnapshot` via the row builders exported here, and
// `computeImportDiff` set-matches the two. Matching reuses each entity's natural
// dedup key — the source-scoped external_id when the deterministic path stamped
// one, else a content identity key — so a changed reading is a CHANGE, not a
// remove+add. Rows with no stable identity (the AI path leaves external_id null)
// key on their date+name identity, so only their VALUE fields drive change/equal.

import { cleanMedicationName } from "./prescription-parse";
import type { PersistInput, PersistRecord } from "./import-shape";

// The entity kinds an import writes that the diff tracks. Kept in a fixed display
// order so the UI renders sections consistently.
export type DiffEntity =
  | "records"
  | "immunizations"
  | "allergies"
  | "conditions"
  | "encounters"
  | "medications"
  | "bodyMetrics"
  | "heights"
  | "headCircs";

export const DIFF_ENTITY_ORDER: DiffEntity[] = [
  "records",
  "immunizations",
  "allergies",
  "conditions",
  "encounters",
  "medications",
  "bodyMetrics",
  "heights",
  "headCircs",
];

export const DIFF_ENTITY_LABEL: Record<DiffEntity, string> = {
  records: "Records",
  immunizations: "Immunizations",
  allergies: "Allergies",
  conditions: "Conditions",
  encounters: "Visits",
  medications: "Medications",
  bodyMetrics: "Body metrics",
  heights: "Height",
  headCircs: "Head circumference",
};

// One normalized row to diff. `key` is the entity's natural identity (dedup key);
// `label` is the human display; `fields` is a canonical serialization of the
// COMPARABLE payload — two rows with the same key but different `fields` are a
// CHANGE, same `fields` are UNCHANGED. `detail` is an optional presentational
// hint (e.g. the value) surfaced in the itemized list.
export interface DiffRow {
  key: string;
  label: string;
  fields: string;
  detail: string | null;
}

// A full per-document snapshot — every tracked entity's rows, in one neutral
// shape both the persisted (DB) and freshly-extracted (PersistInput) sides map to.
export type ImportSnapshot = Record<DiffEntity, DiffRow[]>;

export function emptySnapshot(): ImportSnapshot {
  return {
    records: [],
    immunizations: [],
    allergies: [],
    conditions: [],
    encounters: [],
    medications: [],
    bodyMetrics: [],
    heights: [],
    headCircs: [],
  };
}

// A changed pair keeps both sides so the UI can show old → new.
export interface DiffChange {
  before: DiffRow;
  after: DiffRow;
}

export interface EntityDiff {
  entity: DiffEntity;
  label: string;
  added: DiffRow[];
  removed: DiffRow[];
  changed: DiffChange[];
  unchanged: DiffRow[];
}

export interface DiffTotals {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

export interface ImportDiff {
  // Only entities that carry at least one row on either side (so empty sections
  // aren't rendered). Ordered by DIFF_ENTITY_ORDER.
  entities: EntityDiff[];
  totals: DiffTotals;
  // True when the reprocess would add, remove, or change anything (drives the
  // "no changes" preview state).
  hasChanges: boolean;
}

// The source-scoping prefix import-persist stamps onto a parsed external_id
// (`document:<docId>|<raw>`), so a reading in two documents keeps its own row.
// The persisted side carries the prefix; the freshly-extracted PersistInput
// carries the raw id — strip the prefix on the persisted side so the two match.
export function unscopeExternalId(id: string | null): string | null {
  if (id == null) return null;
  return id.replace(/^document:\d+\|/, "");
}

// Canonical serialize a payload object into a stable, comparable string. Keys are
// sorted so field order never spuriously flags a change; null/undefined collapse
// to the same token.
function serializeFields(payload: Record<string, unknown>): string {
  return Object.keys(payload)
    .sort()
    .map((k) => {
      const v = payload[k];
      return `${k}=${v == null ? "" : String(v)}`;
    })
    .join("|");
}

// ---- Per-entity row builders (shared by both sides) ----
// Each takes NEUTRAL primitive fields so the DB reader and the PersistInput
// adapter build identical rows. The DB reader unscopes external_id before calling.

export interface RecordFields {
  date: string;
  category: string;
  name: string;
  value: string | null;
  value_num: number | null;
  unit: string | null;
  reference_range: string | null;
  panel: string | null;
  flag: string | null;
  canonical: string | null;
  notes: string | null;
  external_id: string | null;
}

export function recordRow(f: RecordFields): DiffRow {
  // Identity: the stable external_id when present (deterministic path), else a
  // content identity (date + category + name) so an AI-extracted reading's VALUE
  // change reads as a change rather than a remove+add.
  const key = f.external_id
    ? `ext:${f.external_id}`
    : `rec:${f.date}|${f.category}|${f.name.trim().toLowerCase()}`;
  const value = f.value ?? (f.value_num != null ? String(f.value_num) : "");
  return {
    key,
    label: `${f.name}${value ? ` — ${value}${f.unit ? ` ${f.unit}` : ""}` : ""}`,
    detail: f.date,
    fields: serializeFields({
      value: f.value,
      value_num: f.value_num,
      unit: f.unit,
      reference_range: f.reference_range,
      panel: f.panel,
      flag: f.flag,
      canonical: f.canonical,
      notes: f.notes,
      // Include date/category/name so an external_id-keyed row still flags a
      // moved date or a renamed reading as a change.
      date: f.date,
      category: f.category,
      name: f.name,
    }),
  };
}

export interface ImmunizationFields {
  date: string;
  vaccine: string;
  dose_label: string | null;
  notes: string | null;
  external_id: string | null;
}

export function immunizationRow(f: ImmunizationFields): DiffRow {
  const key = f.external_id
    ? `ext:${f.external_id}`
    : `imm:${f.date}|${f.vaccine.trim().toLowerCase()}`;
  return {
    key,
    label: f.vaccine,
    detail: f.date,
    fields: serializeFields({
      date: f.date,
      vaccine: f.vaccine,
      dose_label: f.dose_label,
      notes: f.notes,
    }),
  };
}

export interface AllergyFields {
  substance: string;
  reaction: string | null;
  severity: string | null;
  status: string;
  onset_date: string | null;
  external_id: string | null;
}

export function allergyRow(f: AllergyFields): DiffRow {
  const key = f.external_id
    ? `ext:${f.external_id}`
    : `alg:${f.substance.trim().toLowerCase()}`;
  return {
    key,
    label: f.substance,
    detail: f.reaction ?? f.status,
    fields: serializeFields({
      substance: f.substance,
      reaction: f.reaction,
      severity: f.severity,
      status: f.status,
      onset_date: f.onset_date,
    }),
  };
}

export interface ConditionFields {
  name: string;
  status: string;
  onset_date: string | null;
  resolved_date: string | null;
  code: string | null;
  external_id: string | null;
}

export function conditionRow(f: ConditionFields): DiffRow {
  const key = f.external_id
    ? `ext:${f.external_id}`
    : `cond:${f.name.trim().toLowerCase()}`;
  return {
    key,
    label: f.name,
    detail: f.status,
    fields: serializeFields({
      name: f.name,
      status: f.status,
      onset_date: f.onset_date,
      resolved_date: f.resolved_date,
      code: f.code,
    }),
  };
}

export interface EncounterFields {
  date: string;
  end_date: string | null;
  type: string | null;
  class_code: string | null;
  reason: string | null;
  diagnoses: string; // already joined ("A; B") for stored parity
  external_id: string | null;
}

export function encounterRow(f: EncounterFields): DiffRow {
  const key = f.external_id
    ? `ext:${f.external_id}`
    : `enc:${f.date}|${(f.type ?? "").trim().toLowerCase()}`;
  return {
    key,
    label: `${f.type ?? "Visit"}${f.date ? ` (${f.date})` : ""}`,
    detail: f.reason,
    fields: serializeFields({
      date: f.date,
      end_date: f.end_date,
      type: f.type,
      class_code: f.class_code,
      reason: f.reason,
      diagnoses: f.diagnoses,
    }),
  };
}

// Medications are the structured intake_items projection of prescription records.
// Keyed on the cleaned grouping name (the same name import-persist stores), so a
// reprocess that re-derives the same drug is unchanged.
export function medicationRow(name: string): DiffRow {
  const clean = cleanMedicationName(name);
  return {
    key: `med:${clean.toLowerCase()}`,
    label: clean,
    detail: null,
    fields: serializeFields({ name: clean }),
  };
}

export function bodyMetricRow(f: {
  date: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  resting_hr: number | null;
}): DiffRow {
  const parts = [
    f.weight_kg != null ? `${f.weight_kg} kg` : null,
    f.body_fat_pct != null ? `${f.body_fat_pct}% bf` : null,
    f.resting_hr != null ? `${f.resting_hr} bpm` : null,
  ].filter(Boolean);
  return {
    key: `bm:${f.date}`,
    label: parts.length ? parts.join(", ") : f.date,
    detail: f.date,
    fields: serializeFields({
      weight_kg: f.weight_kg,
      body_fat_pct: f.body_fat_pct,
      resting_hr: f.resting_hr,
    }),
  };
}

export function sampleRow(
  prefix: string,
  date: string,
  value: number
): DiffRow {
  return {
    key: `${prefix}:${date}`,
    label: `${value} cm`,
    detail: date,
    fields: serializeFields({ value }),
  };
}

// ---- PersistInput → snapshot (the "next" / freshly-extracted side) ----

// Group a document's prescription records into the medications it would project,
// mirroring persistExtractedMedications: one row per cleaned drug name. The
// existing-manual-med skip is NOT replicated here — a preview shows what THIS
// document derives, and that skip needs the DB (documented in the UI copy).
function medicationsFromRecords(records: PersistRecord[]): DiffRow[] {
  const seen = new Set<string>();
  const rows: DiffRow[] = [];
  for (const r of records) {
    if (r.category !== "prescription" || !r.name?.trim()) continue;
    const row = medicationRow(r.name);
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    rows.push(row);
  }
  return rows;
}

export function snapshotFromPersistInput(input: PersistInput): ImportSnapshot {
  return {
    records: input.records.map((r) =>
      recordRow({
        date: r.date,
        category: r.category,
        name: r.name,
        value: r.value,
        value_num: r.value_num,
        unit: r.unit,
        reference_range: r.reference_range,
        panel: r.panel,
        flag: r.flag,
        canonical: r.canonical,
        notes: r.notes,
        external_id: r.external_id, // raw on this side
      })
    ),
    immunizations: input.immunizations.map((im) =>
      immunizationRow({
        date: im.date,
        vaccine: im.vaccine,
        dose_label: im.dose_label,
        notes: im.notes,
        external_id: im.external_id,
      })
    ),
    allergies: input.allergies.map((a) =>
      allergyRow({
        substance: a.substance,
        reaction: a.reaction,
        severity: a.severity,
        status: a.status,
        onset_date: a.onset_date,
        external_id: a.external_id,
      })
    ),
    conditions: input.conditions.map((c) =>
      conditionRow({
        name: c.name,
        status: c.status,
        onset_date: c.onset_date,
        resolved_date: c.resolved_date,
        code: c.code,
        external_id: c.external_id,
      })
    ),
    encounters: input.encounters.map((e) =>
      encounterRow({
        date: e.date,
        end_date: e.end_date,
        type: e.type,
        class_code: e.class_code,
        reason: e.reason,
        diagnoses: e.diagnoses.length ? e.diagnoses.join("; ") : "",
        external_id: e.external_id,
      })
    ),
    medications: medicationsFromRecords(input.records),
    bodyMetrics: input.bodyMetrics.map((b) =>
      bodyMetricRow({
        date: b.date,
        weight_kg: b.weight_kg,
        body_fat_pct: b.body_fat_pct,
        resting_hr: b.resting_hr,
      })
    ),
    heights: input.heights.map((h) => sampleRow("h", h.date, h.height_cm)),
    headCircs: input.headCircs.map((h) =>
      sampleRow("hc", h.date, h.head_circumference_cm)
    ),
  };
}

// ---- The diff itself ----

function groupByKey(rows: DiffRow[]): Map<string, DiffRow[]> {
  const m = new Map<string, DiffRow[]>();
  for (const r of rows) {
    const list = m.get(r.key);
    if (list) list.push(r);
    else m.set(r.key, [r]);
  }
  return m;
}

// Multiset diff of two row lists by key: rows with the same key are paired in
// order (extra on the `next` side are added, extra on `current` are removed);
// paired rows compare `fields` to split into changed vs unchanged. Duplicate keys
// (e.g. two labs of the same name on the same day with no external_id) are handled
// by the pairing, so a genuine second reading isn't collapsed away.
export function diffRows(
  current: DiffRow[],
  next: DiffRow[]
): Omit<EntityDiff, "entity" | "label"> {
  const cur = groupByKey(current);
  const nxt = groupByKey(next);
  const added: DiffRow[] = [];
  const removed: DiffRow[] = [];
  const changed: DiffChange[] = [];
  const unchanged: DiffRow[] = [];

  const keys = new Set([...cur.keys(), ...nxt.keys()]);
  for (const key of keys) {
    const c = cur.get(key) ?? [];
    const n = nxt.get(key) ?? [];
    // First pass: match identical-field rows order-INSENSITIVELY, so two same-key
    // rows that merely swapped positions (e.g. two AI-path readings with the same
    // content key and values [5,6] re-extracted as [6,5]) read as unchanged rather
    // than two spurious "changed". Consume matched `current` rows from a per-fields
    // multiset; whatever's left on each side is a genuine value change/add/remove.
    const byFields = new Map<string, DiffRow[]>();
    for (const r of c) {
      const list = byFields.get(r.fields);
      if (list) list.push(r);
      else byFields.set(r.fields, [r]);
    }
    const remainingNext: DiffRow[] = [];
    for (const nr of n) {
      const list = byFields.get(nr.fields);
      if (list && list.length > 0) {
        list.shift();
        unchanged.push(nr);
      } else {
        remainingNext.push(nr);
      }
    }
    const remainingCur: DiffRow[] = [];
    for (const list of byFields.values()) remainingCur.push(...list);
    // Second pass: pair the leftovers positionally as changes; the overflow on
    // either side is an add (next) or a remove (current).
    const pairs = Math.min(remainingCur.length, remainingNext.length);
    for (let i = 0; i < pairs; i++) {
      changed.push({ before: remainingCur[i], after: remainingNext[i] });
    }
    for (let i = pairs; i < remainingNext.length; i++) {
      added.push(remainingNext[i]);
    }
    for (let i = pairs; i < remainingCur.length; i++) {
      removed.push(remainingCur[i]);
    }
  }
  return { added, removed, changed, unchanged };
}

export function computeImportDiff(
  current: ImportSnapshot,
  next: ImportSnapshot
): ImportDiff {
  const entities: EntityDiff[] = [];
  const totals: DiffTotals = { added: 0, removed: 0, changed: 0, unchanged: 0 };

  for (const entity of DIFF_ENTITY_ORDER) {
    const c = current[entity];
    const n = next[entity];
    if (c.length === 0 && n.length === 0) continue;
    const d = diffRows(c, n);
    totals.added += d.added.length;
    totals.removed += d.removed.length;
    totals.changed += d.changed.length;
    totals.unchanged += d.unchanged.length;
    entities.push({
      entity,
      label: DIFF_ENTITY_LABEL[entity],
      ...d,
    });
  }

  const hasChanges =
    totals.added > 0 || totals.removed > 0 || totals.changed > 0;
  return { entities, totals, hasChanges };
}

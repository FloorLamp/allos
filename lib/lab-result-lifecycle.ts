// The lab RESULT LIFECYCLE (issue #1404): a result's status vocabulary, the ONE
// decision about when an incoming re-import SUPERSEDES a stored reading, and the
// collection attributes a reading carries alongside its value.
//
// WHY THIS EXISTS. A source-owned reading is keyed by `external_id`, and the sync
// upsert updates that row in place. Labs re-issue results — a corrected potassium,
// an amended differential — so an in-place update silently replaced a number the
// user had already read, with no record that it changed and no way to see what it
// was. FHIR models this explicitly as `Observation.status`
// (preliminary / final / corrected / amended); this module is the app's half of it.
//
// One computation: the ingest path (lib/integrations/normalize.upsertVitals), the
// importer adapters, the record form, and the display copy all resolve status,
// fasting and "was this a correction?" through here, so no two surfaces can decide
// differently whether a re-import overwrote something the user should be told about.
//
// Pure — no DB, no network, auth-blind, safe on the client.

// ---- The status vocabulary --------------------------------------------------

// The four result statuses we model, mirroring the FHIR `Observation.status`
// values that describe a RESULT (registered/cancelled/entered-in-error describe the
// request or a retraction and are handled at the importer boundary, which drops
// those observations entirely). Order is display order: the lifecycle a result
// walks. Mirrors the medical_records CHECK (migration 120) — growing it needs a
// rebuild migration AND an edit here.
export const RESULT_STATUSES = [
  "preliminary",
  "final",
  "corrected",
  "amended",
] as const;

export type ResultStatus = (typeof RESULT_STATUSES)[number];

// The statuses that assert the value CHANGED after it was first reported. These are
// the ones a surface must never render silently: a corrected potassium is a
// different clinical fact than a final one.
const CORRECTION_STATUSES: readonly ResultStatus[] = ["corrected", "amended"];

export function isResultStatus(v: unknown): v is ResultStatus {
  return (
    typeof v === "string" && (RESULT_STATUSES as readonly string[]).includes(v)
  );
}

// True when the status itself claims a re-issue.
export function isCorrectionStatus(v: string | null | undefined): boolean {
  return isResultStatus(v) && CORRECTION_STATUSES.includes(v);
}

// A raw status string from ANY source (a FHIR `Observation.status`, a model's
// extraction, a form post) normalized onto the vocabulary, or null when it isn't
// one of ours. Deliberately strict: an unknown word means "unstated", which is NOT
// the same claim as 'final' — a legacy or manual reading asserts nothing about its
// place in the lifecycle, and inventing 'final' for it would let a corrected result
// look like it had always been the final one.
export function normalizeResultStatus(
  raw: string | null | undefined
): ResultStatus | null {
  const v = (raw ?? "").trim().toLowerCase();
  return isResultStatus(v) ? v : null;
}

// The display label for a status. `null` has no label — a reading with no stated
// status renders no badge at all, rather than a misleading "Final".
export const RESULT_STATUS_LABELS: Record<ResultStatus, string> = {
  preliminary: "Preliminary",
  final: "Final",
  corrected: "Corrected",
  amended: "Amended",
};

export function resultStatusLabel(
  status: string | null | undefined
): string | null {
  return isResultStatus(status) ? RESULT_STATUS_LABELS[status] : null;
}

// ---- Fasting (a nullable TRI-STATE) ----------------------------------------

// 1 = drawn fasting, 0 = explicitly not fasting, null = the source didn't say.
// "We don't know" is a real third answer — a 0/1 NOT NULL column would silently
// assert every legacy reading was non-fasting.
export type FastingState = 0 | 1 | null;

// Parse a form/import value into the tri-state. Anything unrecognized is null
// (unstated), never a guessed 0.
export function parseFasting(raw: unknown): FastingState {
  if (raw === 1 || raw === 0) return raw;
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "1" || v === "yes" || v === "true" || v === "fasting") return 1;
  if (v === "0" || v === "no" || v === "false" || v === "non-fasting") return 0;
  return null;
}

export function fastingLabel(value: FastingState | number | null): string | null {
  if (value === 1) return "Fasting";
  if (value === 0) return "Non-fasting";
  return null;
}

// ---- Specimen ---------------------------------------------------------------

// Suggested specimen spellings for the record form's datalist. Deliberately a
// SUGGESTION list over a free-text column, not an enum: lab menus name specimens far
// more diversely than any vocabulary we could freeze ("Serum or Plasma", "Random
// Urine", "Capillary Whole Blood"), and the canonical biomarker vocabulary already
// splits the analytes whose specimen changes the interpretation ("Folate, RBC" vs
// "Folate", "Creatinine, Urine" vs "Creatinine").
export const SPECIMEN_SUGGESTIONS = [
  "Serum",
  "Plasma",
  "Whole blood",
  "Red blood cells",
  "Urine",
  "Urine, 24-hour",
  "Saliva",
  "Stool",
  "Capillary blood",
] as const;

// Trim/collapse a specimen string; blank becomes null. Capped like the other short
// free-text fields on a reading.
export function sanitizeSpecimen(raw: string | null | undefined): string | null {
  const v = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return v || null;
}

// ---- The supersession decision ---------------------------------------------

// The part of a reading a re-import can overwrite and a user could already have
// read. Deliberately NOT the whole row: a re-canonicalization or a category
// re-classification changes how a reading is FILED, not what it SAID, and must not
// manufacture a correction record.
export interface ReadingState {
  date: string | null;
  value: string | null;
  value_num: number | null;
  unit: string | null;
  result_status?: string | null;
}

function sameText(a: unknown, b: unknown): boolean {
  const x = a == null ? "" : String(a).trim();
  const y = b == null ? "" : String(b).trim();
  return x === y;
}

function sameNumber(a: number | null | undefined, b: number | null | undefined) {
  if (a == null || b == null) return a == null && b == null;
  return a === b;
}

// THE decision: does the incoming result supersede the stored one — i.e. is this a
// re-issue the user must be able to see, rather than an idempotent re-send?
//
// True when the reported result actually changed (value, numeric value, unit, or the
// date it is filed under), OR when the source itself calls the incoming result a
// correction/amendment of a differently-stated prior status. False for a byte-equal
// re-send of the same rolling window — the overwhelmingly common sync case, which
// must stay a no-op and must never accumulate revision rows.
export function supersedesReading(
  prior: ReadingState,
  next: ReadingState
): boolean {
  if (!sameText(prior.date, next.date)) return true;
  if (!sameText(prior.value, next.value)) return true;
  if (!sameNumber(prior.value_num, next.value_num)) return true;
  if (!sameText(prior.unit, next.unit)) return true;
  const nextStatus = normalizeResultStatus(next.result_status);
  const priorStatus = normalizeResultStatus(prior.result_status);
  if (isCorrectionStatus(nextStatus) && nextStatus !== priorStatus) return true;
  return false;
}

// ---- Display copy -----------------------------------------------------------

// One line naming what a preserved revision held, e.g.
// `Corrected — was 5.2 % (2026-03-04)`. `statusNow` is the status the LIVE reading
// carries after the overwrite, so an unstated re-issue still reads honestly as
// "Superseded" rather than claiming the lab called it a correction.
export function revisionSummary(rev: {
  value: string | null;
  value_num: number | null;
  unit: string | null;
  superseded_at: string;
  superseded_by_status?: string | null;
}): string {
  const shown =
    rev.value != null && rev.value !== ""
      ? rev.value
      : rev.value_num != null
        ? String(rev.value_num)
        : "—";
  const unit = rev.unit ? ` ${rev.unit}` : "";
  const lead = isCorrectionStatus(rev.superseded_by_status)
    ? RESULT_STATUS_LABELS[rev.superseded_by_status as ResultStatus]
    : "Superseded";
  const day = rev.superseded_at.slice(0, 10);
  return `${lead} — was ${shown}${unit} (${day})`;
}

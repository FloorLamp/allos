// Pure period/status → medication-course derivation for imports.
// Both deterministic importers reduce a source medication to a small,
// provider-neutral shape — its effective/therapy period(s) plus a normalized
// lifecycle status — and this module turns that into the medication COURSES the
// persist layer writes. No DB, no XML/JSON parsing here, so every rule is
// unit-tested in lib/__tests__/medication-course-import.test.ts.
//
// The importers own the format-specific extraction (a C-CDA IVL_TS low/high +
// statusCode; a FHIR effectivePeriod/effectiveDateTime + status); they hand off
// the normalized primitives below so the course-shaping logic stays shared.

import type { MedStopReason } from "./types";
import type { ImportedMedicationCourse } from "./health-import";

// The medication lifecycle status folded to a small provider-neutral set. Both
// the C-CDA medication statusCode / status-observation vocabulary and the FHIR
// MedicationRequest/MedicationStatement.status vocabulary normalize into this.
export type ImportMedStatus =
  | "active"
  | "completed"
  | "stopped"
  | "on-hold"
  | "entered-in-error"
  | "unknown";

// One effective/therapy period pulled off a source medication. `low`/`high` are
// YYYY-MM-DD (or null). A point date (a FHIR effectiveDateTime or a bare C-CDA
// effectiveTime @value) is a period with a `low` and no `high`.
export interface ImportMedPeriod {
  low: string | null;
  high: string | null;
}

// C-CDA substanceAdministration statusCode / status-observation value → status.
// active/new → active, completed → completed, aborted/cancelled → stopped,
// suspended/held/on-hold → on-hold, nullified/error → entered-in-error, else
// unknown (a med with no stated status is assumed ongoing → an open course).
export function normalizeCcdaMedStatus(raw: unknown): ImportMedStatus {
  switch (
    String(raw ?? "")
      .trim()
      .toLowerCase()
  ) {
    case "active":
    case "new":
      return "active";
    case "completed":
      return "completed";
    case "aborted":
    case "cancelled":
    case "canceled":
    case "discontinued":
      return "stopped";
    case "suspended":
    case "held":
    case "on-hold":
    case "on hold":
      return "on-hold";
    case "nullified":
    case "error":
    case "entered-in-error":
      return "entered-in-error";
    default:
      return "unknown";
  }
}

// FHIR MedicationRequest/MedicationStatement.status → status. active → active,
// completed → completed, stopped/cancelled/not-taken → stopped, on-hold →
// on-hold, entered-in-error → entered-in-error, draft/intended/unknown → unknown.
export function normalizeFhirMedStatus(raw: unknown): ImportMedStatus {
  switch (
    String(raw ?? "")
      .trim()
      .toLowerCase()
  ) {
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "stopped":
    case "cancelled":
    case "canceled":
    case "not-taken":
      return "stopped";
    case "on-hold":
      return "on-hold";
    case "entered-in-error":
      return "entered-in-error";
    default:
      // draft / intended / unknown / anything else: no evidence the course ended.
      return "unknown";
  }
}

// The controlled stop_reason a closed course inherits from the source status.
// Returns null for active/unknown (nothing says the course ended).
function statusStopReason(status: ImportMedStatus): MedStopReason | null {
  switch (status) {
    case "completed":
      return "completed_course";
    case "stopped":
      return "provider_discontinued";
    case "on-hold":
      return "other";
    default:
      return null;
  }
}

function joinNotes(...parts: (string | null | undefined)[]): string | null {
  const kept = parts
    .map((p) => (p == null ? "" : p.trim()))
    .filter((p) => p.length > 0);
  return kept.length ? kept.join("; ") : null;
}

// Clean the raw periods: drop the empty (frequency-only) ones, dedup by
// started_on (matching the persist-side (item_id, started_on) dedup — a repeated
// start collapses, preferring the entry that also carries an end), and sort
// chronologically so the LAST entry is the most recent episode.
function normalizePeriods(periods: ImportMedPeriod[]): ImportMedPeriod[] {
  const usable = periods.filter((p) => p.low != null || p.high != null);
  const byKey = new Map<string, ImportMedPeriod>();
  for (const p of usable) {
    const key = p.low ?? `~${p.high}`;
    const prev = byKey.get(key);
    if (!prev || (prev.high == null && p.high != null)) byKey.set(key, p);
  }
  return [...byKey.values()].sort((a, b) => {
    const as = a.low ?? a.high ?? "";
    const bs = b.low ?? b.high ?? "";
    return as < bs ? -1 : as > bs ? 1 : 0;
  });
}

// Derive the medication COURSES from a source med's effective period(s) + status.
//
// Rules:
//   - entered-in-error → return null (the caller drops the whole medication).
//   - No usable period, but a status that says the med ENDED
//     (completed/stopped/on-hold) AND a fallbackStopDate → one CLOSED, undated
//     course (started_on null, stopped_on = fallbackStopDate). Without this, a
//     dateless "suspended"/"Not-Taking" med-list entry (the eClinicalWorks shape —
//     statusCode present, effectiveTime nullFlavor'd) fell through to the open
//     fallback and imported as an ACTIVE medication, inverting the source's truth.
//     The stop date is required because `active` syncs to "an open course exists":
//     a closed course with stopped_on null would read as open.
//   - No usable period otherwise → return [] (the caller falls back to the
//     Phase-1 single open initial course).
//   - Each period → one course: started_on = low, stopped_on = high.
//   - Earlier (superseded) episodes are always closed; one lacking an explicit
//     high is closed at the next episode's start (best-effort), else its own start.
//   - The LAST (most recent) episode reflects the med's current status:
//       · a status that says it ended (completed/stopped/on-hold) → CLOSED, with
//         the status-derived stop_reason. stopped_on prefers the period's own
//         high, else the caller's fallbackStopDate (doc date / today), else its
//         own start — so a closed course always carries a stop date and lands in
//         Past, upholding active=0 ⇔ no open course.
//       · active/unknown → OPEN (stopped_on null) unless the period itself carried
//         an explicit high, in which case the bound wins (a finished episode).
//
// `opts.note` is a short free-text detail (a FHIR statusReason / reasonCode) put
// on the final course alongside any status note (e.g. "On hold").
export function coursesFromImportedMedication(
  periods: ImportMedPeriod[],
  status: ImportMedStatus,
  opts: { note?: string | null; fallbackStopDate?: string | null } = {}
): ImportedMedicationCourse[] | null {
  if (status === "entered-in-error") return null;

  const cleaned = normalizePeriods(periods);
  const reason = statusStopReason(status);
  const statusNote = status === "on-hold" ? "On hold" : null;

  if (cleaned.length === 0) {
    // Dateless but ended: close the course at the fallback date so the med
    // imports inactive. Dateless and active/unknown (or no stop date to anchor
    // to) keeps the [] fallback.
    if (reason != null && opts.fallbackStopDate != null) {
      return [
        {
          started_on: null,
          stopped_on: opts.fallbackStopDate,
          stop_reason: reason,
          notes: joinNotes(opts.note, statusNote),
        },
      ];
    }
    return [];
  }

  return cleaned.map((p, i) => {
    const isLast = i === cleaned.length - 1;
    if (isLast) {
      if (reason != null) {
        return {
          started_on: p.low,
          stopped_on: p.high ?? opts.fallbackStopDate ?? p.low,
          stop_reason: reason,
          notes: joinNotes(opts.note, statusNote),
        };
      }
      // active / unknown: open unless the period carried an explicit end.
      if (p.high != null) {
        return {
          started_on: p.low,
          stopped_on: p.high,
          stop_reason: "completed_course",
          notes: joinNotes(opts.note),
        };
      }
      return {
        started_on: p.low,
        stopped_on: null,
        stop_reason: null,
        notes: joinNotes(opts.note),
      };
    }
    // A superseded earlier episode → closed.
    const next = cleaned[i + 1];
    return {
      started_on: p.low,
      stopped_on: p.high ?? next.low ?? p.low,
      stop_reason: null,
      notes: null,
    };
  });
}

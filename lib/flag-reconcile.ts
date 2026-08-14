import { ageFromBirthdate } from "./date";
import { reconciledFlag, qualitativeFlagResolution } from "./reference-range";
import { isEditLocked } from "./integrations/sync-log";
import { cyclePhaseOnDate, type CyclePeriod } from "./cycle";
import type { ReproductiveStatus, Sex } from "./types";

// The canonical-ranges shape reconciledFlag needs to judge a value. Kept loose so
// both callers (queries/medical.ts with full CanonicalResultDefinition rows, db.ts with a
// column-subset row) can pass their own map without a cast at the boundary.
type CanonicalLike = Parameters<typeof reconciledFlag>[3];

export interface FlagReconcileRow {
  id: number;
  value_num: number;
  unit: string | null;
  canonical_name: string;
  flag: string | null;
  // The record's stored free-text reference range, for the unit-mislabel cross-check
  // (issue #761): reconciledFlag consults it to decline deriving a false out-of-range
  // flag from a mislabeled unit. Optional — a caller without it (or a test) just
  // gets the pre-#761 behavior (no mislabel suppression).
  reference?: string | null;
  // The record's collection date (YYYY-MM-DD). Used with the profile's birthdate
  // to pick the age-banded reference range for the age the subject was ON THAT
  // DATE (not today), so childhood labs never re-flag as the person ages. Optional
  // so callers without age context (or tests) can omit it — then the adult band.
  date?: string | null;
}

// The profile-level context needed to resolve age-banded ranges: the subject's
// sex and, for age bands, their birthdate (preferred) and/or a stored age
// fallback. Age is computed per row from `birthdate` at the row's collection date,
// falling back to `age` (a bare stored age), then to the adult band when neither
// is known.
interface FlagReconcileSubject {
  sex?: Sex | null;
  birthdate?: string | null;
  age?: number | null;
  // The subject's CURRENT reproductive (menopausal) status, when set. A profile-
  // level attribute with no per-record history, so it applies to every one of the
  // profile's hormone records (the same simplification as the stored-age fallback).
  // Threaded into reconciledFlag alongside sex; only affects female physiology.
  reproductiveStatus?: ReproductiveStatus | null;
}

// The cycle log and the profile-local day it is read against travel TOGETHER (#2613).
// Cycle phase is PER-RECORD — cyclePhaseOnDate resolves the phase on each row's OWN
// collection date, so the phase-specific hormone range applies above the coarse status
// proxy (#718) — and that derivation now refuses a date after `today`, because a phase
// past today is unknowable rather than uncertain. A caller that brings a cycle log must
// therefore say which day is today; a caller with no log (the pre-#718 shape, and the
// bare-`Sex` form below) states neither and derives no phase, exactly as before.
type FlagReconcileCycle =
  | { periods?: null | undefined; today?: string | null }
  | { periods: CyclePeriod[]; today: string };

export type FlagReconcileContext = FlagReconcileSubject & FlagReconcileCycle;

// The subject's age (whole years) for a record's collection date: derived from the
// birthdate on that date when both are known, else the stored age fallback, else
// null (→ adult band). Kept here so both reconcile callers pick the age the same
// way, honoring the "age on the collection date, not today" rule.
export function ageForRecord(
  ctx: FlagReconcileContext,
  date: string | null | undefined
): number | null {
  if (ctx.birthdate && date) {
    const a = ageFromBirthdate(ctx.birthdate, date);
    if (a != null) return a;
  }
  return ctx.age ?? null;
}

// A flag change to apply: `flag === null` means clear the stored flag (set NULL);
// any other value means set it. Rows the reconcile leaves unchanged are omitted.
export interface FlagChange {
  id: number;
  flag: string | null;
}

// The pure decision half shared by queries.reconcileFlags and the boot-time
// reconcileNonOptimalFlags in lib/db.ts: for each candidate row, look up its
// canonical ranges (case-insensitively, via a caller-preloaded map) and ask
// reconciledFlag what flag the ranges imply — judged against the subject's sex and
// their age ON THE ROW'S COLLECTION DATE (for age-banded biomarkers). `undefined`
// (leave unchanged) is dropped; a concrete flag or `null` (clear) becomes a
// FlagChange. The callers own the row selection, context resolution, and the
// actual UPDATEs — this owns only the per-row derivation, so it has no db
// dependency and breaks the import cycle that forced db.ts to keep its own copy.
//
// The third argument accepts either a bare Sex (back-compat, no age bands) or a
// full FlagReconcileContext carrying birthdate/age for the age-banded case.
export function computeFlagReconciliation<T>(
  rows: FlagReconcileRow[],
  cbByName: Map<string, T>,
  ctx: FlagReconcileContext | Sex | null | undefined
): FlagChange[] {
  const context: FlagReconcileContext =
    ctx == null || typeof ctx === "string" ? { sex: ctx ?? null } : ctx;
  const periods = context.periods ?? null;
  const out: FlagChange[] = [];
  for (const r of rows) {
    const cb = cbByName.get(r.canonical_name.toLowerCase());
    // The cycle phase on THIS record's collection date (#718), or null when there is no
    // cycle log, the date predates the first recorded period, or the date is AFTER today
    // (#2613 — a record dated ahead of the day it is read on has no derivable phase).
    // reconciledFlag only uses it for female physiology on an analyte with phase ranges.
    const cyclePhase =
      periods && periods.length > 0 && r.date && context.today
        ? cyclePhaseOnDate(periods, r.date, context.today)
        : null;
    const next = reconciledFlag(
      r.flag,
      r.value_num,
      r.unit,
      cb as CanonicalLike,
      context.sex ?? null,
      ageForRecord(context, r.date),
      context.reproductiveStatus ?? null,
      r.reference ?? null,
      cyclePhase
    );
    if (next === undefined) continue;
    out.push({ id: r.id, flag: next });
  }
  return out;
}

// A QUALITATIVE (value_num IS NULL) record for the qualitative flag reconcile: the
// name (canonical_name || name, resolved by the caller), the freetext value/notes/
// reference the classifier reads, and the current flag.
export interface QualitativeFlagRow {
  id: number;
  name: string;
  value: string | null;
  notes: string | null;
  reference: string | null;
  flag: string | null;
  // The reading's LOINC, when stored — gives the classifier a deterministic class
  // hint that overrides the name regexes (#684). Optional: rows without a LOINC
  // fall back to name-based classification.
  loinc?: string | null;
  // `medical_records.edited` — the #133 hand-edit lock, read through isEditLocked.
  // Gates the two flag-DELETING transitions — the #2687 no-result clear (#2712 R3) and
  // the #548 §1 clear on an identity-class row (#2715) — so a flag a person chose in
  // the record editor is not deleted by the reconcile that runs on the very next line
  // of the same save. Optional: a not-yet-persisted record has no lock to read.
  edited?: number | null;
}

// The qualitative counterpart of computeFlagReconciliation (issue #549): the numeric
// reconcile bails on value_num IS NULL, so a qualitative value's extractor-guessed
// flag is never revisited. This routes each qualitative row through
// qualitativeFlagResolution (the shared classifier) — promoting a durable-immunity
// titer to "immune" (#544) and clearing a blunt "abnormal" the classifier judges
// context-neutral like a blood type (#548 §1) — while leaving infection-positive
// markers and unrecognized values untouched. `undefined` (no change) is dropped.
// Shared by queries.reconcileFlags and the boot-time reconcile so they can't drift.
export function computeQualitativeFlagChanges(
  rows: QualitativeFlagRow[]
): FlagChange[] {
  const out: FlagChange[] = [];
  for (const r of rows) {
    const next = qualitativeFlagResolution(
      r.name,
      r.value,
      r.notes,
      r.reference,
      r.flag,
      r.loinc,
      { editLocked: isEditLocked(r.edited) }
    );
    if (next === undefined) continue;
    out.push({ id: r.id, flag: next });
  }
  return out;
}

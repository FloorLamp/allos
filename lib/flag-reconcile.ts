import { ageFromBirthdate } from "./date";
import { reconciledFlag } from "./reference-range";
import type { ReproductiveStatus, Sex } from "./types";

// The canonical-ranges shape reconciledFlag needs to judge a value. Kept loose so
// both callers (queries/medical.ts with full CanonicalBiomarker rows, db.ts with a
// column-subset row) can pass their own map without a cast at the boundary.
type CanonicalLike = Parameters<typeof reconciledFlag>[3];

export interface FlagReconcileRow {
  id: number;
  value_num: number;
  unit: string | null;
  canonical_name: string;
  flag: string | null;
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
export interface FlagReconcileContext {
  sex?: Sex | null;
  birthdate?: string | null;
  age?: number | null;
  // The subject's CURRENT reproductive (menopausal) status, when set. A profile-
  // level attribute with no per-record history, so it applies to every one of the
  // profile's hormone records (the same simplification as the stored-age fallback).
  // Threaded into reconciledFlag alongside sex; only affects female physiology.
  reproductiveStatus?: ReproductiveStatus | null;
}

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
  const out: FlagChange[] = [];
  for (const r of rows) {
    const cb = cbByName.get(r.canonical_name.toLowerCase());
    const next = reconciledFlag(
      r.flag,
      r.value_num,
      r.unit,
      cb as CanonicalLike,
      context.sex ?? null,
      ageForRecord(context, r.date),
      context.reproductiveStatus ?? null
    );
    if (next === undefined) continue;
    out.push({ id: r.id, flag: next });
  }
  return out;
}

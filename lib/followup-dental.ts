// The DENTAL domain adapter for the finding → follow-up → resolution chain (issue
// #700 / #705 ask 5) — the dental sibling of the imaging (lib/followup-imaging),
// flagged-labs (lib/followup-labs), and IOP (lib/followup-iop) adapters. PURE — it
// operates on DentalProcedure shapes, no DB/network. It plugs into the domain-
// agnostic core (lib/followup.ts) by answering the same three domain questions: what
// a dental source finding reads as, what its follow-up is called, and which LATER
// dental record resolves it — WITHOUT touching the core.
//
// A dental SOURCE finding is a dental_procedures row a dentist flagged for recheck: a
// "watch #14, recheck in 6 months" caries watch or a "periodontal re-eval in 3
// months" plan — status 'watch' (or 'planned') carrying a follow_up_interval_days.
// That is the finding → follow-up → resolution chain the exam-note narrative would
// otherwise lose (the #700 blind spot). The RESOLUTION is a LATER dental record on
// the SAME tooth (the watched tooth got treated or re-examined) — the tooth-anchored
// analogue of imaging's "a later study of the same anatomy resolves it".

import type { DentalProcedure } from "./types/medical";
import { dentalDisplayLabel, toothLabel } from "./dental";
import type { FollowUpAdapter, FollowUpItemLike } from "./followup";

// The dental source kind stored in care_plan_items.source_kind.
export const DENTAL_FOLLOWUP_KIND = "dental";

// YYYY-MM of a record date (for the compact "(2026-03)" reason tail).
function recordMonth(p: Pick<DentalProcedure, "procedure_date">): string {
  return p.procedure_date ? p.procedure_date.slice(0, 7) : "";
}

// A short human label for the source dental finding. Prefers the free-text `finding`
// impression (that IS the finding — "watch mesial #14, recheck 6mo"), collapsed to
// one line and capped so a paragraph stays legible; falls back to the display label
// ("Caries watch · #14"). A YYYY-MM tail pins WHICH record, so a serial view reads
// unambiguously across time.
export function dentalSourceLabel(p: DentalProcedure): string {
  const finding = p.finding?.replace(/\s+/g, " ").trim();
  const core =
    finding && finding.length > 0
      ? finding.length > 80
        ? `${finding.slice(0, 77)}…`
        : finding
      : dentalDisplayLabel(p);
  const month = recordMonth(p);
  return month ? `${core} (${month})` : core;
}

// The default follow-up title. The tooth (when known) narrows it — "Dental recheck
// #14"; otherwise the generic "Dental recheck".
export function dentalFollowUpTitle(p: DentalProcedure): string {
  const tooth = toothLabel(p);
  return tooth ? `Dental recheck ${tooth}` : "Dental recheck";
}

// Whether two dental records describe the SAME tooth for resolution matching. When
// both name a tooth they must match (case-insensitive, ignoring a leading "#"); a
// record with no tooth matches on recency alone (a general re-exam can resolve a
// general finding). Deliberately loose but never cross-tooth when both are specified.
function sameTooth(a: DentalProcedure, b: DentalProcedure): boolean {
  const ta = a.tooth?.trim().replace(/^#/, "").toLowerCase();
  const tb = b.tooth?.trim().replace(/^#/, "").toLowerCase();
  if (!ta || !tb) return true; // one side unspecified → recency match suffices
  return ta === tb;
}

// The later dental record that resolves a follow-up for `source`, or null when none
// has landed. A candidate qualifies when it is a DIFFERENT record on the same tooth
// whose procedure_date is STRICTLY AFTER the source's date. The MOST RECENT wins.
// Confirm-first: returning a candidate only OFFERS the resolution.
export function findResolvingDentalRecord(
  source: DentalProcedure,
  _followUp: FollowUpItemLike,
  candidates: readonly DentalProcedure[]
): DentalProcedure | null {
  if (!source.procedure_date) return null; // undated source can't order candidates
  let best: DentalProcedure | null = null;
  for (const c of candidates) {
    if (c.id === source.id) continue;
    if (!c.procedure_date || c.procedure_date <= source.procedure_date)
      continue;
    if (!sameTooth(source, c)) continue;
    if (
      !best ||
      c.procedure_date > best.procedure_date! ||
      (c.procedure_date === best.procedure_date! && c.id > best.id)
    )
      best = c;
  }
  return best;
}

// A compact label for a resolving candidate, for the offer copy ("Composite filling ·
// #14 · 2026-09").
export function dentalResolvingLabel(p: DentalProcedure): string {
  const label = dentalDisplayLabel(p);
  const month = recordMonth(p);
  return month ? `${label} · ${month}` : label;
}

// The dental adapter instance the builder consumes. One object satisfying the generic
// FollowUpAdapter<Source, Candidate> contract — the seam imaging/labs/IOP also fill.
export const dentalFollowUpAdapter: FollowUpAdapter<
  DentalProcedure,
  DentalProcedure
> = {
  kind: DENTAL_FOLLOWUP_KIND,
  describeSource: dentalSourceLabel,
  followUpTitle: dentalFollowUpTitle,
  findResolvingRecord: findResolvingDentalRecord,
  describeResolvingRecord: dentalResolvingLabel,
};

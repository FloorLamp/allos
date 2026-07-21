// The optical-prescription → eye-exam bridge (issue #1098). A dated eyeglass /
// contact-lens prescription is near-proof an eye exam happened: a new Rx is
// written *at* a refraction / comprehensive eye visit. So an `optical_prescriptions`
// row SATISFIES the `vision_exam` preventive rule as of its issued date — the SAME
// `(ruleKey, date)` satisfaction stream the manual "mark done" events, the #86
// name/code inference, and the #686 screening results feed. There is NO second
// cadence engine: the one pure assessor (lib/preventive-status.ts) takes the newest
// satisfaction per rule, so this merges cleanly with the appointment/coded/named
// vision sources and never double-counts.
//
// Why a DIRECT source (not the concept map, unlike the dental-procedure analog which
// carries its own CDT codes / "cleaning" names): an Rx row has no CPT code and no
// eye-exam name text to match — its evidence is INTRINSIC to being an optical Rx at
// all. So this maps the row's existence, not its text, to the one rule.
//
// Conservatism (#86): an optical Rx maps to EXACTLY ONE rule (vision_exam), so it can
// never over-satisfy a different rule. An OLD Rx satisfies only as of its old issued
// date, so a stale Rx doesn't suppress a genuinely-due exam — the assessor applies the
// normal interval + grace from that date. The Rx's EXPIRY is irrelevant to the exam
// date (a lapsed Rx still evidences the exam that produced it), so expiry is not
// consulted here. A row with no issued_date is dropped (it can't be placed on the
// cadence timeline), same as every other satisfaction source.

import type { PreventiveSatisfaction } from "./preventive-status";

// The one preventive rule a dated optical prescription satisfies.
const OPTICAL_RX_RULE_KEY = "vision_exam";

export interface OpticalRxSatisfactionInput {
  // The date the prescription was issued (YYYY-MM-DD) — the exam date. A null/blank
  // value drops the row.
  issued_date?: string | null;
}

// Every vision-exam satisfaction implied by a set of optical-prescription rows — the
// SAME `(ruleKey, date)` shape the manual + #86 + #686 streams emit, so the caller
// concatenates these and hands the union to the one assessor (which takes the newest
// per rule).
export function inferOpticalRxSatisfactions(
  rxs: OpticalRxSatisfactionInput[]
): PreventiveSatisfaction[] {
  const out: PreventiveSatisfaction[] = [];
  for (const rx of rxs) {
    const date = (rx.issued_date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({ ruleKey: OPTICAL_RX_RULE_KEY, date });
  }
  return out;
}

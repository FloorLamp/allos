// A small, first-class "reason" carried STRUCTURALLY on Finding (lib/findings.ts)
// and UpcomingItem (lib/upcoming.ts), ALONGSIDE — not replacing — the existing
// display `detail` string (issue #656). PURE (no DB/network).
//
// The problem it solves ("one question, one computation" at the explanation layer):
// many engines decide due/overdue/prioritized and the deciding engine produces a
// good, often CITED reason (the risk-stratification rules, a flagged reading, an
// active situation) — but today those reasons are flattened by string concatenation
// into `detail` at generation, so a compact surface (the Telegram digest) can only
// re-derive per-domain counts and the "why sooner" never reaches the push. Carrying
// the reason as DATA lets each surface decide how much to render from the SAME
// computation: the page/hero render the full detail, the digest surfaces the top
// reason, a reminder can cite it — never a second, drifting derivation.
//
// `code` is a stable machine key (the closed `ReasonCode` union keeps the set
// honest — a source-scan would be overkill here, a union + the shared-fixture pin
// suffices, per the issue). `source` carries provenance where the reason is
// citation-backed (the risk rules carry an ACC/AHA-style informational citation).

import { flagLabel } from "./reference-range";
import type { MedicalFlag } from "./types";

// The closed set of reason kinds carried on the findings/upcoming spine today. A
// new kind is added here deliberately (mirroring the #448 prefix-registry spirit at
// a proportionate weight — a union, not a runtime registry).
export type ReasonCode =
  // A curated risk-stratification rule applies to THIS profile (family history,
  // active condition, occupational/immune status, hereditary variant) — the
  // citation-backed "why this matters / why sooner" line. Carries a `source`.
  | "risk-elevated"
  // The reading is out of range / non-optimal (the flag itself).
  | "biomarker-flagged"
  // A situational (as-needed-by-context) item is due because its situation is
  // currently active ("due because Illness is active").
  | "situation-active"
  // A tracked follow-up exists BECAUSE of a source finding (issue #700): the "why"
  // that turns a bare "follow up in 12 months" into "for the 6 mm RLL nodule
  // (2026-03)". Self-evident from the linked record, so no citation source.
  | "followup-source";

export interface Reason {
  // Stable machine key — the closed union above.
  code: ReasonCode;
  // The human line the surfaces render.
  text: string;
  // Provenance where the reason is citation-backed (the risk rules' informational
  // citation). Absent for reasons that are self-evident facts (a flag, a situation).
  source?: string | null;
}

// The structural shape of a risk-stratification SourcedReason (lib/risk-
// stratification.ts) — kept local so this leaf module doesn't import the risk layer
// (which is imported widely and would risk a cycle). A `RiskRule`'s reason + source.
export interface SourcedReasonLike {
  text: string;
  source: string;
}

// Map the risk layer's sourced reasons onto the shared Reason shape. ONE helper so
// every generator that attaches risk reasons keys the SAME `risk-elevated` code and
// carries the citation, rather than re-shaping ad hoc.
export function riskReasonsFrom(
  sourced: readonly SourcedReasonLike[]
): Reason[] {
  return sourced.map((s) => ({
    code: "risk-elevated" as const,
    text: s.text,
    source: s.source,
  }));
}

// Map text-only risk reason lines (the ones the preventive assessor pre-merges as
// plain strings, where the citation isn't threaded through) onto `risk-elevated`
// Reasons WITHOUT a source. Same code + display as riskReasonsFrom, just no
// citation — used where the sourced form isn't available yet (a documented
// follow-up is to thread `source` through the preventive assessor too).
export function plainRiskReasons(lines: readonly string[]): Reason[] {
  return lines.map((text) => ({ code: "risk-elevated" as const, text }));
}

// A "this reading is flagged" reason — the flag label as its own explanation
// ("Low", "Below optimal"). No source (the flag is a computed fact, not a citation).
export function flaggedReason(
  flag: MedicalFlag | string | null | undefined
): Reason {
  return { code: "biomarker-flagged", text: flagLabel(flag) };
}

// A "due because a situation is active" reason — the situational-dose explanation
// the medicine page shows as a bare tag, lifted into a structured reason so the same
// line can reach the digest / a reminder (issue #656 item 5).
export function situationReason(situation: string): Reason {
  return {
    code: "situation-active",
    text: `Due because ${situation} is active`,
  };
}

// A "this follow-up is for a source finding" reason (issue #700) — the legibility
// line that names WHAT the follow-up is chasing ("for the 6 mm RLL nodule
// (2026-03)"), carried structurally so the digest/reminder can render it, not only
// the Upcoming row. No source (it's a fact about the linked record, not a citation).
export function followUpSourceReason(sourceLabel: string): Reason {
  return { code: "followup-source", text: `for the ${sourceLabel}` };
}

// Concatenate reason groups into one list, or `undefined` when empty — the shape
// UpcomingItem.reasons wants (absent, not an empty array, for the common no-reason
// case). Order is preserved, so callers pass groups most-explanatory-first.
export function concatReasons(
  ...groups: readonly Reason[][]
): Reason[] | undefined {
  const out = groups.flat();
  return out.length ? out : undefined;
}

// The single "top reason" a compact surface (the digest highlight, a reminder)
// renders for an item — the FIRST carried reason, or null when there are none. One
// computation so the digest and the page never pick a different lead reason (the
// generators order reasons most-explanatory-first: the cited risk line leads).
export function primaryReason(
  reasons: readonly Reason[] | null | undefined
): Reason | null {
  return reasons && reasons.length ? reasons[0] : null;
}

// Nav relevance gating (issue #1042, phase 1) — the PURE decision half of the
// server-resolved relevance object threaded once through SidebarContent. This
// extends the existing declarative nav-gating idiom (`requiresMultiProfile` #31,
// `requiresFoodLogging` #591, the age-gate) with per-entry DATA/LIFE-STAGE
// relevance: an entry that can't apply to the active profile is hidden from the
// sidebar. Every gate here is COSMETIC — the pages themselves never hard-block
// (the requiresFoodLogging pattern: a direct URL still renders), and the
// authoritative check stays requireSession() in the page.
//
// The gather (DB reads) lives in lib/queries/nav-relevance.ts; this module is
// DB-free so the full truth table is unit-tested in lib/__tests__.

import { lifeStage } from "./life-stage";
import type { ReproductiveStatus, Sex } from "./types";

// The server-resolved relevance bitset. One key per gated nav entry; a leaf in
// components/Nav.tsx opts in via `relevanceKey`, and isNavLeafVisible hides it
// when its bit is false. Keys exist only for entries that are actually gated —
// the four specialty Medical entries were each evaluated for phase-1 gating
// (#1042): Vision and Dental are gated (Data → Import creates their rows, so a
// no-data profile still has an always-visible creation path); Skin and Mental
// health are NOT gated yet — their pages are the ONLY place their data can be
// created (the skin lesion form / the in-app instrument flow), so hiding them
// would strand a new tracker. Their gating activates in phase 6, when the
// Health-record footer ("Track a new area") becomes the never-gated entry point.
export interface NavRelevance {
  cycle: boolean;
  vision: boolean;
  dental: boolean;
}

export type NavRelevanceKey = keyof NavRelevance;

// All-true default so a caller that doesn't thread the bitset never over-hides —
// the same defaulting posture as `foodLoggingRelevant`.
export const DEFAULT_NAV_RELEVANCE: NavRelevance = {
  cycle: true,
  vision: true,
  dental: true,
};

export interface CycleRelevanceInput {
  // Any `cycles` row exists for the profile.
  hasCycleRows: boolean;
  sex: Sex | null;
  reproductiveStatus: ReproductiveStatus | null;
  // Whole years, null when unknown (getUserAge).
  age: number | null;
}

// Whether the Cycle nav entry is relevant for a profile — ONE pure computation
// from four shipped parts (#1042):
//
//   hasCycleRows                                            ← data always wins
//   OR (sex === "female"
//       AND (reproductiveStatus === "premenopausal"         ← explicit status beats age
//            OR (reproductiveStatus == null
//                AND lifeStage(age) ∈ {adolescent, adult})))  ← #494 age fallback
//
// Data always wins — a profile with logged cycles keeps the entry regardless of
// sex/status (covers trans and unset-sex profiles). An explicit postmenopausal
// status hides it (absent data): the FSH-range precedence rule (explicit status
// beats the age proxy, lib/types/medical.ts) applied to navigation. Unknown sex
// or unknown age hides — the calm default for a directory entry; the page stays
// reachable by URL and (from phase 6) the Health-record footer.
export function cycleTrackingRelevant(input: CycleRelevanceInput): boolean {
  if (input.hasCycleRows) return true;
  if (input.sex !== "female") return false;
  if (input.reproductiveStatus === "premenopausal") return true;
  if (input.reproductiveStatus != null) return false; // explicit postmenopausal
  const stage = lifeStage(input.age);
  return stage === "adolescent" || stage === "adult";
}

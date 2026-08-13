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

// The server-resolved relevance bitset. Originally one key per gated nav entry
// (a leaf in components/Nav.tsx opts in via `relevanceKey`, and isNavLeafVisible
// hides it when its bit is false); since the #1042 final tail the Vision/Dental
// bits ALSO gate the folded /records specialty SECTIONS — the same computation
// drives both, so a hidden nav gate can never disagree with a visible section.
//   - `cycle`  — still a nav gate (the Cycle leaf).
//   - `vision`/`dental` — no longer nav leaves (folded into Health record); these
//     bits now gate the #vision / #dental sections of /records on data presence.
//     Their rows also arrive via Data → Import (an always-visible creation path),
//     so hiding an empty section never strands creation.
// Skin and Mental health carry NO bit: their in-page forms (the skin lesion form /
// the in-app instrument flow) are the ONLY creation path, so their /records
// sections render UNCONDITIONALLY (their former nav leaves were likewise ungated) —
// hiding them would strand a new tracker.
//   - `sleep` — a nav gate for the dedicated Sleep entry (#1066), between Trends
//     and Upcoming. Pure data presence (has any recorded sleep session), exactly
//     like vision/dental: no life-stage logic, and the page stays reachable by URL
//     (the pillar deep-link and dashboard tile both link it) even when hidden.
//   - `wellness` — a nav gate for the dedicated Wellness entry (#1620), beside
//     Longevity. True when any practice target OR practice log exists; the
//     command palette remains the always-visible first-practice creation path.
export interface NavRelevance {
  cycle: boolean;
  vision: boolean;
  dental: boolean;
  sleep: boolean;
  // Progress photos (#1119): pure data presence (any progress_photos row),
  // exactly like sleep — no life-stage logic; the page stays reachable by URL
  // and via the command palette's "Progress photos" action (the always-visible
  // creation path, so the empty-state gate never strands creation).
  progress: boolean;
  wellness: boolean;
}

export type NavRelevanceKey = keyof NavRelevance;

// All-true default so a caller that doesn't thread the bitset never over-hides —
// the same defaulting posture as `foodLoggingRelevant`.
export const DEFAULT_NAV_RELEVANCE: NavRelevance = {
  cycle: true,
  vision: true,
  dental: true,
  sleep: true,
  progress: true,
  wellness: true,
};

export interface WellnessRelevanceInput {
  // Any frequency_targets row with scope_kind = 'practice'.
  hasPracticeTargets: boolean;
  // Any practice_logs row, including a logs-only practice whose target was
  // removed or which arrived through an import.
  hasPracticeLogs: boolean;
}

export function wellnessTrackingRelevant({
  hasPracticeTargets,
  hasPracticeLogs,
}: WellnessRelevanceInput): boolean {
  return hasPracticeTargets || hasPracticeLogs;
}

export interface CycleRelevanceInput {
  // Any `cycles` row exists for the profile.
  hasCycleRows: boolean;
  sex: Sex | null;
  reproductiveStatus: ReproductiveStatus | null;
  // Whole years, null when unknown (getProfileAge).
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

// ── The Records › Specialty pane set, under a MULTI-PROFILE view (#2557) ──────

// The three bits that shape the Specialty sub-tab strip and its per-pane route
// gates. Structurally the `RecordsRelevance` of app/(app)/records/nav.ts; declared
// here because the fold below is the pure decision and that module is the nav model.
export interface SpecialtyRelevance {
  vision: boolean;
  dental: boolean;
  substanceUse: boolean;
}

/**
 * The pane set for a VIEW rather than for one profile (#2557).
 *
 * Converting Dental and Vision to multi-view forced the question the issue calls out:
 * `getNavRelevance(profile.id).dental` gated a route that now LISTS several members,
 * so "relevant to whom?" had to be answered rather than inherited.
 *
 * The answer is not one rule, because the three bits are not one KIND of question:
 *
 *   • `vision` / `dental` are DATA-PRESENCE questions about what the pane will show.
 *     The pane shows every profile in view, so the bit is ANY profile in view has
 *     rows. Gating on the acting profile alone would redirect a caregiver away from
 *     a pane that was about to list their child's dental work — the pane would have
 *     had content, and the gate would have denied it existed. Only when NO member in
 *     view has a row is the pane genuinely empty, which is the state the gate is for.
 *
 *   • `substanceUse` is a LIFE-STAGE question about the CONTENT that pane serves for
 *     one data subject (#1174: AUDIT/DAST are adult-validated). It is deliberately
 *     NOT folded. That section still reads exactly one profile — the acting one — so
 *     the profile whose age governs the content is the acting profile, and ORing an
 *     adult's bit in would unhide adult-validated instruments for a view that a known
 *     minor is acting as. A gate whose subject is the content stays with the subject.
 *
 * Single view (`inView` = the acting profile alone) reproduces today's answer
 * exactly, which is the regression bar: an unconverted instance renders identically.
 * An empty view set yields both data bits false — the pane is hidden, which is the
 * safe answer to "nothing is in view".
 */
export function specialtyRelevanceForView(input: {
  /** The ACTING profile's own bitset — the only source of `substanceUse`. */
  acting: SpecialtyRelevance;
  /** One bitset per profile IN VIEW; the acting profile may not be among them. */
  inView: readonly Pick<SpecialtyRelevance, "vision" | "dental">[];
}): SpecialtyRelevance {
  return {
    vision: input.inView.some((r) => r.vision),
    dental: input.inView.some((r) => r.dental),
    substanceUse: input.acting.substanceUse,
  };
}

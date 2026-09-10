// Frequency-target right-sizing rule findings (#2962).
//
// One dependency cluster of its own: lib/target-rightsize plus the frequency-target
// ledger. It spans practice, training and food targets, so it belongs with none of
// those domains — what its builders share is the weekly-floor question, not a surface.
// The per-candidate envelope is exported so each domain's own card runs its candidates
// through the SAME suppression filter without gathering them twice.

import { getFrequencyTargetWeeklyHistory } from "../queries";
import { frequencyScopeLabel } from "../frequency-targets";
import type { Finding } from "../findings";
import {
  trainingTabHref,
  nutritionTabHref,
  PRACTICES_HREF,
  type AppRoute,
} from "../hrefs";
import {
  detectRightSizeCandidates,
  RIGHTSIZE_WEEKS,
  type RightSizeCandidate,
  type RightSizeDomain,
  type RightSizeInput,
} from "../target-rightsize";
import { COACHING_ENTITY_FINDING_LIMITS } from "./limits";

// ---- Domain: frequency-target right-sizing (coaching tier, issue #1670) ----

// Where each domain's suggestion is acted on — the surface that already owns that
// commitment, so "open it" lands where the user would have gone anyway.
const RIGHTSIZE_ACTION: Record<
  RightSizeDomain,
  { href: AppRoute; label: string }
> = {
  practice: { href: PRACTICES_HREF, label: "Open practices" },
  training: {
    href: trainingTabHref("plan", "goals"),
    label: "Open weekly targets",
  },
  food: { href: nutritionTabHref("food"), label: "Open weekly habits" },
};

// The ONE gather → detect for a profile's right-size candidates: the completed-week
// history of every floor-carrying frequency target, run through the pure detector.
// Shared by the findings builder below AND by each domain's own suggestion card and
// the practice nudge's ride-along, so the card, the finding and the button can never
// disagree about whether a target is a candidate (one question, one computation).
export function collectRightSizeCandidates(
  profileId: number,
  today: string
): RightSizeCandidate[] {
  const inputs: RightSizeInput[] = getFrequencyTargetWeeklyHistory(
    profileId,
    RIGHTSIZE_WEEKS
  ).map(({ target, weeks, existedWholeWindow }) => ({
    targetId: target.id,
    scopeKind: target.scope_kind,
    // The label each domain's own surface shows: the practice's own name, the
    // food group's display name, the training scope's label.
    label:
      target.scope_kind === "practice"
        ? target.scope_value
        : frequencyScopeLabel(target.scope_kind, target.scope_value),
    floor: target.per_week,
    weeklyCounts: weeks.map((w) => w.count),
    existedWholeWindow,
    // Episode anchor = the current year (#436): a drift that recurs a year after
    // being dismissed re-surfaces instead of being silenced forever.
    periodAnchor: today.slice(0, 4),
  }));
  return detectRightSizeCandidates(inputs);
}

// A calm, dismissible SUGGESTION that a weekly floor the profile has been under for a
// month be lowered to what they actually do — or dropped, landing in the domain's own
// no-expectation state (logs-only practice, untracked routine, untracked food habit).
// The user's tap is the only write (#559/#1505 doctrine, generalized off intakes; see
// lib/target-rightsize for the full contract and the substance-cap/cold-start
// exclusions).
//
// COACHING tier (#449) by the same hard product contract the demotion suggestion
// carries: it joins collectCoachingFindings, rides the shared suppression bus under
// RIGHTSIZE_PREFIX, renders on each domain's own page and the calm dashboard rollup —
// and NEVER becomes a send of its own. Its only push presence is decorating the pace
// nudge that already fires for the target's own reasons (the ride-the-nag rule), which
// is exactly the nag this suggestion exists to end.
//
// Reads through the ONE shared weekly-history gather, the same per-scope counting the
// current-week progress rollup uses, so the suggestion and the progress card can never
// disagree about a week. No owned SQL.
export function buildTargetRightSizeFindings(
  profileId: number,
  today: string
): Finding[] {
  return collectRightSizeCandidates(profileId, today)
    .slice(0, COACHING_ENTITY_FINDING_LIMITS.targetRightSize)
    .map(rightSizeCandidateFinding);
}

// One candidate's Finding envelope. Exported so a domain's own suggestion card can
// run its candidates through the SAME suppression filter every other surface uses
// (activeFindings over these keys) without gathering the candidates a second time —
// the card and the coaching rollup then hide and re-appear together, by construction.
export function rightSizeCandidateFinding(c: RightSizeCandidate): Finding {
  return {
    domain: "right-size",
    dedupeKey: c.key,
    supersedes: c.legacyKey,
    title: c.title,
    detail: c.detail,
    // Calm FYI — an observation about the user's own log, never an alarm.
    tone: "info",
    evidence: c.evidence,
    actionHref: RIGHTSIZE_ACTION[c.domain].href,
    actionLabel: RIGHTSIZE_ACTION[c.domain].label,
  };
}

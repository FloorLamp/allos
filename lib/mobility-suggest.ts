// Pure deficit → mobility-habit suggestion logic (issue #840 phase 2). The #577
// "suggestions from your measurements" pattern applied to movement: a measured
// flexibility/balance deficit (from the #834 fitness check) or a #838 RECOVERING injury
// seeds a SUGGEST-ONLY mobility-region habit ("15th percentile — track hips 3×/week?").
//
// COACHING tier (calm; #449): the suggestions surface in the coaching rollup + the
// Training overview, one-tap acceptable into a mobility_region frequency target and
// dismissible through the shared bus. NEVER a push, never a rehab prescription (#838's
// non-goal holds — the injury line is soft, note-only). DB-free; the builder in
// lib/rule-findings.ts gathers the inputs and calls this.

import type { MuscleRegion } from "./lifts";

// The dedupeKey namespace this builder keys under (registered in
// lib/rule-finding-prefixes.ts; the #448 reflection guard enforces it).
export const MOBILITY_SUGGEST_PREFIX = "mobility-suggest:";

// A percentile at or below this is "low enough to nudge" — the bottom quartile. Above it,
// no suggestion (hide, don't nag — #489).
export const LOW_PERCENTILE = 25;

// The default cadence a suggestion proposes.
export const SUGGESTED_PER_WEEK = 3;

// Why a region is suggested. `flexibility`/`balance` are measured deficits; `injury` is a
// soft, note-only nudge for a recovering region.
export type MobilitySuggestSource = "flexibility" | "balance" | "injury";

export interface MobilitySuggestion {
  region: MuscleRegion;
  perWeek: number;
  source: MobilitySuggestSource;
  // The dedupeKey — re-keyed by region + source so a dismissal is scoped to THIS reason for
  // THIS region, and a different deficit for the same region can still surface.
  dedupeKey: string;
  title: string;
  detail: string;
}

// The region a measured flexibility deficit (sit-and-reach) points at: the posterior chain
// (hamstrings roll up to Legs). The region a balance deficit points at: hip/ankle
// stability (the glute-med stabilizers roll up to Glutes).
export const FLEXIBILITY_REGION: MuscleRegion = "Legs";
export const BALANCE_REGION: MuscleRegion = "Glutes";

export function mobilitySuggestSignalKey(
  region: MuscleRegion,
  source: MobilitySuggestSource
): string {
  return `${MOBILITY_SUGGEST_PREFIX}${source}:${region}`;
}

// The inputs the builder gathers.
export interface MobilitySuggestInputs {
  // Sit-and-reach percentile (1..99) or null when unmeasured/ungated. Lower = tighter.
  sitReachPercentile: number | null;
  // Single-leg balance percentile (1..99) or null. Lower = worse balance.
  balancePercentile: number | null;
  // Regions of RECOVERING (#838) injuries — a soft, note-only gentle-mobility nudge.
  recoveringRegions: MuscleRegion[];
  // Regions that ALREADY have a mobility_region target — never re-suggested (the loop is
  // closed once accepted; #580).
  existingTargetRegions: Set<MuscleRegion>;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

// The suggestions to surface, in a stable priority order (flexibility, balance, then
// recovering injuries). A region already targeted, or one already suggested by a
// higher-priority source, is skipped so the same region isn't nudged twice.
export function mobilitySuggestions(
  inputs: MobilitySuggestInputs
): MobilitySuggestion[] {
  const out: MobilitySuggestion[] = [];
  const claimed = new Set<MuscleRegion>(inputs.existingTargetRegions);

  const add = (
    region: MuscleRegion,
    source: MobilitySuggestSource,
    title: string,
    detail: string
  ) => {
    if (claimed.has(region)) return;
    claimed.add(region);
    out.push({
      region,
      perWeek: SUGGESTED_PER_WEEK,
      source,
      dedupeKey: mobilitySuggestSignalKey(region, source),
      title,
      detail,
    });
  };

  if (
    inputs.sitReachPercentile != null &&
    inputs.sitReachPercentile <= LOW_PERCENTILE
  ) {
    add(
      FLEXIBILITY_REGION,
      "flexibility",
      "Track hamstring mobility?",
      `Your sit-and-reach is around the ${ordinal(inputs.sitReachPercentile)} percentile — tight posterior chain. A ${FLEXIBILITY_REGION} mobility habit ${SUGGESTED_PER_WEEK}×/week can help; re-measure at your next fitness check.`
    );
  }

  if (
    inputs.balancePercentile != null &&
    inputs.balancePercentile <= LOW_PERCENTILE
  ) {
    add(
      BALANCE_REGION,
      "balance",
      "Track hip & ankle stability?",
      `Your single-leg balance is around the ${ordinal(inputs.balancePercentile)} percentile. Hip and ankle stability work ${SUGGESTED_PER_WEEK}×/week can help; re-measure at your next fitness check.`
    );
  }

  for (const region of inputs.recoveringRegions) {
    add(
      region,
      "injury",
      `Gentle ${region} mobility while you recover?`,
      `A recovering injury involves your ${region}. Gentle mobility ${SUGGESTED_PER_WEEK}×/week may help you keep moving — this is a soft suggestion, not a rehab plan; follow your clinician's guidance.`
    );
  }

  return out;
}

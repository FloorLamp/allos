// Layout-independent disambiguator for the duplicate-review candidate pair (issue
// #531). The merge/keep affordances labelled each row by a single identity
// dimension — its source ("Merge, keep Strava" / "Keep Strava instead") — so a pair
// the detector surfaces PRECISELY because both rows share that dimension (two Strava
// rows, or two manual weigh-ins both "Manual entry") collapsed to the same word and
// the user couldn't tell which row an action keeps.
//
// Given the two candidates' source labels, return the labels to put on the two
// affordances: keep the distinct source labels when they DIFFER (preserving today's
// good "keep Strava / keep Manual"), else fall back to A / B. `usedFallback` tells
// the caller to render an on-card A/B badge so the letter always has a visible
// referent — an on-ELEMENT anchor, never screen position, because the candidate
// cards are single-column (keeper on top) below `sm` and side-by-side above it, so a
// spatial "left/right" label would be correct in only one layout. One helper shared
// by the activity path, the body-metric PairActions, and MergeConflictDialog so the
// three affordances can't drift. Pure + unit-tested.
export interface DisambiguationLabels {
  a: string;
  b: string;
  // True when the source labels collided and we fell back to A/B — the cards must
  // then render the badge so "A"/"B" has an on-element referent.
  usedFallback: boolean;
}

export function disambiguationLabels(
  labelA: string,
  labelB: string
): DisambiguationLabels {
  if (labelA !== labelB) return { a: labelA, b: labelB, usedFallback: false };
  return { a: "A", b: "B", usedFallback: true };
}

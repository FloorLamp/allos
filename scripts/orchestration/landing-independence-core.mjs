// The judgment behind landing-independence.mjs, as a pure function so the
// merge rule can be tested without git or GitHub.
//
// A merge stales every other PR's CI: their checks ran on a base that did not
// contain it. Re-running costs ~16 minutes per PR and serialises the day. The
// runbook has always allowed the alternative — "write down why the two file
// sets cannot interact" — and this is that sentence made mechanical: the
// candidate merges without a re-run only when no path it changed was changed
// by anything that landed since its CI base, AND neither side touched a file
// where two disjoint diffs still interact (append-only barrels, generated
// manifests, the seed the e2e suite is measured against, lockfiles).

/** Files where two non-overlapping diffs can still conflict in meaning. */
export const SHARED_PATHS = [
  /^lib\/migrations\/versions\/index\.ts$/,
  /^lib\/migrations\/manifest\.json$/,
  /^lib\/queries\.ts$/,
  /^lib\/release-notes\.json$/,
  /^lib\/log-manifest\.ts$/,
  /^e2e\/seed\//,
  /^e2e\/spec-durations\.json$/,
  /^package(-lock)?\.json$/,
];

/**
 * @param {{ candidate: string[], landed: string[] }} sets — paths the
 *   candidate changed since its CI base, and paths main changed since then.
 * @returns {{ independent: boolean, overlap: string[], shared: string[] }}
 */
export function judgeIndependence({ candidate, landed }) {
  const landedSet = new Set(landed);
  const overlap = candidate.filter((p) => landedSet.has(p)).sort();
  const shared = [...new Set([...candidate, ...landed])]
    .filter((p) => SHARED_PATHS.some((re) => re.test(p)))
    .sort();
  return {
    independent: overlap.length === 0 && shared.length === 0,
    overlap,
    shared,
  };
}

/** One line a merge log can carry, and a human can read. */
export function independenceNotice(pr, verdict, landedCount) {
  if (landedCount === 0)
    return `#${pr}: nothing landed since its CI base — merge on its own checks.`;
  if (verdict.independent)
    return `#${pr}: no shared paths with the ${landedCount} merge(s) since its CI base — a type or contract change on either side is not visible here (#5138 broke main this way); merge without a re-run only if none is in play.`;
  const why = [];
  if (verdict.overlap.length)
    why.push(`paths changed on both sides: ${verdict.overlap.join(", ")}`);
  if (verdict.shared.length)
    why.push(`shared files touched: ${verdict.shared.join(", ")}`);
  return `#${pr}: NOT independent (${why.join("; ")}) — rebase and re-run before merging.`;
}

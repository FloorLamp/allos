// The Combobox's EMPTY-QUERY list, when the caller names a group for each row
// (#1675's `groupFor`). Pure, so the rule is testable without a browser.
//
// WHY THIS EXISTS (#3410). The pre-typing list is deliberately SHORT — eight rows,
// so nobody meets a 400-row menu before typing a letter. Taking those eight off the
// front of one ranked list is right for ONE vocabulary and silently wrong the moment
// a picker is fed TWO ranked vocabularies concatenated: the higher-ranked one spends
// all eight rows and the other never appears — no header, no "more", nothing. The
// list looks complete, correct and short. #3220 lost the #1675 analyte groups out of
// a subject picker exactly this way, and only found out by building it and looking.
//
// THE RULE: one row per group first, in the caller's group order; then the REST of
// the budget in the caller's own ranked order. Representation is the defect being
// fixed, so it is guaranteed — every group present gets a row, and therefore a
// header — and nothing beyond that one row overrides the ranking the caller
// declared. A single-vocabulary picker is BYTE-IDENTICAL to the old behaviour (one
// group, so the two passes degenerate to "the first `limit` in order") — the 8-row
// list is the deliberate part and is not the bug.
//
// WHY NOT SHARE THE ROWS OUT EVENLY, which is the obvious reading of "make the cap
// per-group": because for every grouped picker that ships today the caller's group
// order is a PRIORITY order, not a set of peers. `lib/biomarker-rank.ts` leads with
// "Due or flagged" — the app saying ACT ON THIS — and an even split hands half of
// those rows to the ~200-name alphabetical tail behind them. Measured on the record
// form's own shape, a profile with 8 flagged analytes and none of its own would have
// lost 4 of the 8 to that tail; under the rule above it loses exactly one, which is
// the price of the header that fixes the bug. A caller whose groups genuinely ARE
// peers can interleave its own option array — only the caller knows that, and this
// component cannot.
//
// THE RULE FOR MANY GROUPS, which is what makes this honest: the total is still
// capped at `limit`. A caller with more groups than rows CANNOT have all of them
// represented, so the groups past the cap are reported in `droppedGroups` and the
// component says so in development. That is the "or says loudly" half of #3410's
// acceptance: the list either shows every vocabulary, or it names the ones it could
// not fit.
//
// WHAT THIS CANNOT SEE, and the reason a future caller should read this: a picker
// that concatenates two vocabularies WITHOUT passing `groupFor` hands us a flat list
// of strings with no seam in it. There is nothing to detect and nothing to warn
// about. If you are merging ranked vocabularies into one picker, pass `groupFor` —
// that is what buys you both the headers and this guarantee.

export interface RelevanceView {
  // The rows to render, in the caller's original order.
  rows: string[];
  // Groups present in `options` that got no row at all. `null` is the unheaded
  // bucket (a `groupFor` that answered null). Empty in every shipped picker.
  droppedGroups: (string | null)[];
}

// Build the grouped relevance view. `options` is the caller's ranked order. Rows are
// chosen and emitted BY INDEX, so a list carrying the same string twice behaves
// exactly as `options.slice(0, limit)` did — this function needs no uniqueness
// assumption of its own. (`Combobox` keys its rendered rows by the option string, so
// duplicates remain a caller-side problem there, unchanged and pre-existing:
// `[...curatedMedicationOptions(), ...curatedSupplementOptions()]` carries
// "Melatonin" twice.)
export function groupedRelevanceView(
  options: readonly string[],
  groupFor: (option: string) => string | null,
  limit: number
): RelevanceView {
  // Buckets in FIRST-APPEARANCE order — the caller's group order, whatever it is.
  // Indices, not strings, so the emitted rows can be restored to source order.
  const buckets = new Map<string | null, number[]>();
  options.forEach((option, index) => {
    const group = groupFor(option);
    const bucket = buckets.get(group);
    if (bucket) bucket.push(index);
    else buckets.set(group, [index]);
  });

  // One vocabulary: nothing to share out, and this is the path every existing
  // single-group picker takes. Kept explicit so "unchanged" is visible, not derived.
  if (buckets.size <= 1) {
    return { rows: options.slice(0, limit), droppedGroups: [] };
  }

  const taken = new Set<number>();
  // Pass 1 — THE FLOOR. One row per group, in the caller's group order. This is the
  // whole of the fix: a group with a row has a header, and a group with a header is
  // not a vocabulary that vanished.
  for (const [, indices] of buckets) {
    if (taken.size >= limit) break;
    taken.add(indices[0]);
  }
  // Pass 2 — THE REMAINDER, in the CALLER'S order. Indices already taken are a no-op,
  // so this reads as "keep filling from the top of the ranked list". When there are
  // more groups than rows the floor has already spent the budget and this does
  // nothing.
  for (let i = 0; i < options.length && taken.size < limit; i++) taken.add(i);

  const droppedGroups: (string | null)[] = [];
  for (const [group, indices] of buckets) {
    if (!indices.some((index) => taken.has(index))) droppedGroups.push(group);
  }

  return {
    rows: options.filter((_, index) => taken.has(index)),
    droppedGroups,
  };
}

// The sentence the Combobox prints in development when a picker's groups do not fit
// (#3410). Exported so its wording is pinned by a test rather than by a screenshot.
export function droppedGroupsWarning(
  droppedGroups: readonly (string | null)[],
  limit: number
): string {
  const named = droppedGroups.map((g) => (g === null ? "(no header)" : g));
  return (
    `Combobox: the pre-typing list holds ${limit} rows and this picker has more ` +
    `groups than that, so ${named.join(", ")} never appear before the user types. ` +
    `Show fewer groups, or accept that these are search-only. See lib/relevance-view.ts (#3410).`
  );
}

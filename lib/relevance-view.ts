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
// So the budget is shared out a row at a time in the caller's group order instead of
// front-loaded: every group gets its first row before any group gets its second. A
// single-vocabulary picker is BYTE-IDENTICAL to the old behaviour (one group, so the
// round-robin degenerates to "the first `limit` in order") — the 8-row list is the
// deliberate part and is not the bug.
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

// Build the grouped relevance view. `options` is the caller's ranked order and is
// assumed unique (the Combobox keys its rows by the option string).
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
  const cursors = new Map<string | null, number>();
  let progressed = true;
  while (taken.size < limit && progressed) {
    progressed = false;
    for (const [group, indices] of buckets) {
      if (taken.size >= limit) break;
      const cursor = cursors.get(group) ?? 0;
      if (cursor >= indices.length) continue;
      taken.add(indices[cursor]);
      cursors.set(group, cursor + 1);
      progressed = true;
    }
  }

  const droppedGroups: (string | null)[] = [];
  for (const group of buckets.keys()) {
    if ((cursors.get(group) ?? 0) === 0) droppedGroups.push(group);
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

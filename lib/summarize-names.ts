// "Chest, Quads, Calves and 2 more" — the one-line roster a findings ROLLUP prints
// under its group title. Pure.
//
// Extracted from lib/training-findings-rollup (#1496) when the Results hub's
// trajectory rollup (#1499 section B) needed the identical sentence for analyte
// names. Two rollups spelling their own "list the first few, then 'and N more'" is
// the copy-paste the AGENTS.md "one question, one computation" rule exists to stop —
// the drift would be small and invisible (an Oxford comma, an "others" vs "more"),
// which is exactly why it never gets noticed.

// How many names a rollup summary spells out before it counts the rest.
export const SUMMARY_NAME_LIMIT = 3;

/**
 * Join up to `limit` names, then count the remainder: "A, B, C and 2 more".
 * An empty list summarizes as the empty string (a caller renders no detail line).
 */
export function summarizeNames(
  names: readonly string[],
  limit: number = SUMMARY_NAME_LIMIT
): string {
  const shown = names.slice(0, Math.max(0, limit));
  const rest = names.length - shown.length;
  if (shown.length === 0) return "";
  const list = shown.join(", ");
  return rest > 0 ? `${list} and ${rest} more` : list;
}

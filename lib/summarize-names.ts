// "Chest · Quads · Calves and 2 more" — the one-line roster a findings ROLLUP prints
// under its group title. Pure.
//
// Extracted from lib/training-findings-rollup (#1496) when the Results hub's
// trajectory rollup (#1499 section B) needed the identical sentence for analyte
// names. Two rollups spelling their own "list the first few, then 'and N more'" is
// the copy-paste the AGENTS.md "one question, one computation" rule exists to stop —
// the drift would be small and invisible (an Oxford comma, an "others" vs "more"),
// which is exactly why it never gets noticed.

// THE SEPARATOR MAY NOT BE A CHARACTER THE NAMES CONTAIN (#3496; the rule is
// docs/internals/copy.md §9, "Machine text renders at the display boundary").
//
// This joined with ", " until a phone review read the Results trajectory line as
// "5 analytes trending … — Lead, Lymphocytes, Relative, Neutrophils, Absolute and
// 2 more" and counted FIVE names for three: "Lymphocytes, Relative" and
// "Neutrophils, Absolute" are single LOINC-shaped lab names, and a comma inside a
// name is indistinguishable from a comma between names. The count and the list
// then stop agreeing, which is worse than either being wrong alone — the reader
// has no way to tell which one to believe.
//
// A middle dot is the separator no clinical name carries, and this app already
// uses it as its inline "and also" mark (result attributes, chart captions,
// episode headlines). It is not decoration here: it is the property that makes
// the sentence readable at all.
export const NAME_JOIN_SEPARATOR = " · ";

// How many names a rollup summary spells out before it counts the rest.
export const SUMMARY_NAME_LIMIT = 3;

/**
 * Join names for a one-line roster: "A · B · C".
 * The separator is `NAME_JOIN_SEPARATOR` — see the note above for why it is not a
 * comma.
 */
export function joinNames(names: readonly string[]): string {
  return names.join(NAME_JOIN_SEPARATOR);
}

/**
 * Join a SHORT list a sentence reads aloud: "A and B" for two, "A · B · C" beyond.
 *
 * A two-name subject is the common case in a headline that goes on to make one
 * claim about both ("LDL Cholesterol and ApoB are high — eat more:"), and "and"
 * is what a person says there. Past two, a sentence-shaped conjunction stops
 * helping and the roster separator carries it — still never a comma, for the same
 * reason `joinNames` does not use one.
 */
export function joinNamesForSentence(names: readonly string[]): string {
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return joinNames(names);
}

/**
 * Join up to `limit` names, then count the remainder: "A · B · C and 2 more".
 * An empty list summarizes as the empty string (a caller renders no detail line).
 */
export function summarizeNames(
  names: readonly string[],
  limit: number = SUMMARY_NAME_LIMIT
): string {
  const shown = names.slice(0, Math.max(0, limit));
  const rest = names.length - shown.length;
  if (shown.length === 0) return "";
  const list = joinNames(shown);
  return rest > 0 ? `${list} and ${rest} more` : list;
}

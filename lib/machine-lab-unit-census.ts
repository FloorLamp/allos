// THE MACHINE-SPELLED LAB-UNIT CENSUS RULE (#3545).
//
// Like the machine-date sibling, this rule is asked of rendered text nodes. A
// source scan cannot tell a stored string from display copy, and it cannot see the
// value passed through MedicalValue at runtime. The browser census serializes this
// exact pattern, while the pure test proves the pattern can see and stay quiet.

/**
 * An ASCII micro token in rendered lab copy.
 *
 * The word boundary is what keeps the dose vocabulary's `mcg/` and an ordinary
 * word such as `drug/` quiet. Numerator tokens require the slash (allowing stored
 * whitespace around it) that makes them a unit; `uL` is itself the denominator
 * token. `500 mcg` remains deliberate dosing copy, outside this rule.
 */
export const MACHINE_LAB_UNIT_RE =
  /\b(?:ug(?=\s*\/)|uL\b|uIU(?=\s*\/)|uU(?=\s*\/)|umol(?=\s*\/))/g;

/** Every machine-spelled lab unit in one string. Empty when the text is clean. */
export function machineLabUnitHits(text: string): string[] {
  return [...text.matchAll(MACHINE_LAB_UNIT_RE)].map((match) => match[0]);
}

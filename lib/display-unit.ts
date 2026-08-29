// A LAB RESULT'S UNIT AS A PERSON READS IT (#3493/#3545).
//
// This is display vocabulary only. Imported spellings remain evidence in storage,
// and comparison/export paths continue to read those stored strings. Keep the map
// deliberately finite: it translates spellings the lab vocabulary actually uses;
// it does not try to parse or canonicalize an unknown unit.

const ASCII_MICRO_TOKENS = {
  ug: "µg",
  uL: "µL",
  uIU: "µIU",
  uU: "µU",
  umol: "µmol",
} as const;

const ASCII_MICRO_TOKEN_RE = /\b(?:ug|uL|uIU|uU|umol)\b/g;

/**
 * Remove UCUM presentation syntax while preserving the represented unit (#1018).
 *
 * `{annotation}` braces are unity comments; square brackets mark non-metric atoms.
 * Removing braces with their contents and brackets around their contents makes
 * `mm[Hg]` read and compare as `mmHg`, without aliasing it to the distinct `mm`.
 * The international inch and avoirdupois suffixes are the bounded token aliases.
 * Matching and display share this operation; export never calls it.
 */
export function stripUcumUnitSyntax(unit: string): string {
  return unit
    .replace(/\{[^}]*\}/g, "")
    .replace(/[[\]]/g, "")
    .replace(/\bin_i\b/gi, "in")
    .replace(/\blb_av\b/gi, "lb")
    .replace(/\boz_av\b/gi, "oz");
}

/**
 * A stored clinical-result unit at the display boundary.
 *
 * ASCII micro spellings are mapped token by token (`ug/mL` → `µg/mL`,
 * `10^3/uL` → `10^3/µL`). Word boundaries keep unknown units untouched, and
 * `mcg` deliberately stays `mcg`: that is the separate dose/intake vocabulary.
 */
export function displayUnit(unit: string | null | undefined): string | null {
  if (unit == null) return null;
  const stripped = stripUcumUnitSyntax(unit).trim();
  if (stripped.length === 0) return null;
  return stripped.replace(ASCII_MICRO_TOKEN_RE, (token) => {
    return ASCII_MICRO_TOKENS[token as keyof typeof ASCII_MICRO_TOKENS];
  });
}

/** Whether a medical result's stored unit describes the displayed value. */
export function shouldDisplayMedicalValueUnit(
  value: string | null | undefined
): boolean {
  return /\d/.test(value ?? "");
}

import { CANONICAL_BIOMARKERS } from "./datasets/canonical-biomarkers";

// Unit handling for biomarker values, in two layers:
//
// 1. A dimensional parser for concentration units (amount-per-volume). It
//    decomposes a unit like "mg/dL" into a physical dimension (mass / activity /
//    amount) and a scale to a base unit (g/L, IU/L, mol/L). Two units of the same
//    dimension convert by their scale ratio — analyte-INDEPENDENT. This makes
//    functionally identical units equal for free (uIU/mL == mIU/L, mcg/dL ==
//    ug/dL == µg/dL) and SI-prefix rescales automatic (mg/dL <-> mg/L is ×10).
//
// 2. Curated per-analyte factors (canonical-biomarkers.json `conversions`) for
//    CROSS-dimension conversions only — mass<->molar depends on molar mass
//    (mg/dL <-> mmol/L differs for glucose vs cholesterol), so it can't be
//    derived dimensionally.

// SI prefixes (case-sensitive: 'm' milli vs 'M' mega), plus "mc" = micro.
const PREFIX: Record<string, number> = {
  "": 1,
  da: 1e1,
  h: 1e2,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  d: 1e-1,
  c: 1e-2,
  m: 1e-3,
  u: 1e-6,
  mc: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
};

// "activity" is the INTERNATIONAL-unit standard (IU — a biological-activity
// reference preparation); "enzyme" is the bare catalytic unit U (µmol/min). They
// are physically UNRELATED and must never be equated or cross-converted (issue
// #759), so enzyme U carries its own dimension rather than sharing "activity".
type Dim = "mass" | "activity" | "enzyme" | "amount" | "eq";

const SUPERSCRIPTS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

// Normalize unit spelling noise so equivalent strings compare equal: micro sign
// (µ/μ) → "u", superscript / caret exponents (m², m^2) → "m2", whitespace
// removed, lowercased. Lets eGFR's many spellings — "mL/min/1.73m2",
// "mL/min/1.73 m²", "mL/min/1.73 m^2", "ml/min/1.73m2" — collapse to one form,
// and is also applied before the concentration parser so "mg / dL" still parses.
function normalizeUnitText(u: string): string {
  let s = u
    .replace(/µ|μ/g, "u")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (d) => String(SUPERSCRIPTS.indexOf(d)))
    .replace(/\^(\d)/g, "$1")
    .replace(/\s+/g, "")
    .toLowerCase();
  s = aliasUnitTokens(s);
  // eGFR is always normalized per 1.73 m² body-surface-area, so "mL/min" is just
  // shorthand for "mL/min/1.73m²" — drop the suffix to collapse the spellings.
  s = s.replace(/\/1\.73m2$/, "");
  // "Per minute" synonyms all mean the same thing: bpm == beats/min == /min (heart
  // rate), and breaths/min == /min (respiratory rate). Analyte identity is carried
  // by the canonical name, not the unit, so folding both rate families onto "/min"
  // is safe — it only lets a value corroborate against its own analyte's range.
  if (
    s === "bpm" ||
    s === "beats/min" ||
    s === "beats/minute" ||
    s === "breaths/min" ||
    s === "breaths/minute" ||
    s === "breath/min"
  )
    return "/min";
  return s;
}

// Count-concentration units (cells per volume) carry a power-of-ten multiplier
// instead of a physical dimension, written many ways: "10^3/uL", "10³/uL",
// "x10(3)/uL", "Thousand/uL", "K/uL". Decode the multiplier to an exponent and
// pair it with the volume scale so every spelling shares one key.
const COUNT_WORDS: Record<string, number> = {
  hundred: 2,
  thousand: 3,
  k: 3,
  million: 6,
  billion: 9,
};

// A BARE count-per-volume numerator carries no power-of-ten multiplier — it is a
// plain cell count: "cells/uL", "cell/uL", "#/uL", or just "/uL". Treating these
// as exponent 0 folds them into the same count-concentration identity as the
// scaled spellings, so a bare "cells/uL" canonical converts against ANY scaled
// reading ("10^3/uL", the UCUM "10*3/uL", "10*9/L", "Thousand/uL", …) through the
// generic ratio path — no per-analyte `conversions` list, and spelling-agnostic
// (caret vs UCUM asterisk). The empty-string case covers a leading "/uL".
const BARE_COUNT_NUMERATORS = new Set(["", "#", "cell", "cells"]);

function countExp(numerator: string): number | null {
  const t = numerator.replace(/^x/, "");
  if (t in COUNT_WORDS) return COUNT_WORDS[t];
  if (BARE_COUNT_NUMERATORS.has(t)) return 0;
  const m = /^10(?:\^|\*|e|\()?(\d+)\)?$/.exec(t);
  return m ? Number(m[1]) : null;
}

// Whether a unit is a BARE count-per-volume (exponent 0), e.g. "cells/uL", "/uL".
// A reading with no unit can't be assumed to be in such a canonical unit — the
// value could just as well be at a 10^3 scale (an ANC "7.5" is 10^3/uL, not 7.5
// cells/uL) — so convertToCanonical declines to judge those rather than guess.
export function isBareCountPerVolume(unit: string | null | undefined): boolean {
  if (!unit) return false;
  const s = aliasUnitTokens(
    unit
      .replace(/µ|μ/g, "u")
      .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (d) => `^${SUPERSCRIPTS.indexOf(d)}`)
      .replace(/\s+/g, "")
      .toLowerCase()
  );
  const parts = s.split("/");
  if (parts.length !== 2) return false;
  if (!BARE_COUNT_NUMERATORS.has(parts[0].replace(/^x/, ""))) return false;
  const den = parseToken(parts[1]);
  return !!den && den.dim === "vol";
}

// Scale of a count-concentration unit expressed as counts per liter, so that
// numerically identical units share one identity — e.g. 10^9/L and 10^3/uL both
// resolve to 1e9 counts/L. Folding the power-of-ten exponent AND the volume scale
// into a single number (10^exp / volumeScale) means those spellings compare equal
// and convert by their scale ratio. Returns null for non-count units.
function parseCountConc(unit: string): number | null {
  const s = aliasUnitTokens(
    unit
      .replace(/µ|μ/g, "u")
      .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (d) => `^${SUPERSCRIPTS.indexOf(d)}`)
      .replace(/\s+/g, "")
      .toLowerCase()
  );
  const parts = s.split("/");
  if (parts.length !== 2) return null;
  const exp = countExp(parts[0]);
  if (exp == null) return null;
  const den = parseToken(parts[1]);
  if (!den || den.dim !== "vol") return null;
  return Math.pow(10, exp) / den.scale;
}

// Real-world lab spellings the dimensional parser doesn't recognize on its own,
// folded to a form it does (issue #759). Applied INSIDE each parse path AFTER the
// whitespace/micro normalization but BEFORE the "/"-split, so the alias reaches
// both the concentration and count-concentration parsers. Each alias is scoped so
// it can't misfire on a legitimate unit:
//   - grams spelled out — "gm"/"gms" → "g" (common on LabCorp/Quest). WHOLE-TOKEN
//     (word-boundary), so the SI-prefixed grams "mg"/"mcg"/"ng"/"ug"/"kg" (which
//     merely CONTAIN a g, not the token "gm") are untouched.
//   - cubic millimeter → microliter — "cumm"/"cmm"/"cu mm" (== µL; pervasive on
//     Indian and older CBC reports) as a volume denominator. Whole-token, so plain
//     "mm"/"cm" don't match (both require the "mm" pair with a leading c).
//   - archaic mass-percent — a trailing "%" on a MASS numerator ("mg%", "g%") means
//     "per dL". Rewritten to "/dL" ONLY when the numerator parses as a mass token,
//     so a legitimate "%" reading (hematocrit, O₂ saturation, a bare "42%") is left
//     as "%" and never misclassified as a concentration.
function aliasUnitTokens(s: string): string {
  // UCUM spelling noise (#1018): `{annotation}` braces are UCUM's unity comment
  // ("{beats}/min" == "/min") and square brackets mark UCUM's non-metric atoms
  // ("mm[Hg]", "[degF]", "[iU]"). Strip the braces (with their content) and the
  // brackets (preserving the inner atom) so a document-shipped UCUM spelling
  // compares equal to the app's canonical text form: mm[Hg] ≡ mmHg, [degF] ≡ degF,
  // {beats}/min ≡ /min. Bracket REMOVAL, not token aliasing, keeps genuinely
  // distinct units apart — "[iU]" becomes IU (activity), never enzyme U.
  s = s.replace(/\{[^}]*\}/g, "");
  s = s.replace(/[[\]]/g, "");
  // UCUM's suffixed non-metric atoms: the international inch and avoirdupois
  // pound/ounce ("[in_i]" → "in_i" after bracket removal). Whole-token, so a
  // legitimate "in"/"lb"/"oz" is untouched and nothing else contains these atoms.
  s = s.replace(/\bin_i\b/gi, "in");
  s = s.replace(/\blb_av\b/gi, "lb");
  s = s.replace(/\boz_av\b/gi, "oz");
  s = s.replace(/\bgms?\b/gi, "g");
  s = s.replace(/\bcu?mm\b/gi, "uL");
  // Volume-percent (a hematocrit spelling) is just percent.
  s = s.replace(/^vol%$/i, "%");
  // Microscopy "per high-power field": a bare-count numerator ("cell"/"cells")
  // carries no more information than a plain "/HPF", so fold them together — they
  // otherwise compare unequal and a urine-sediment count silently fails to
  // corroborate (#918).
  s = s.replace(/^cells?\/hpf$/i, "/hpf");
  // micro-U per mL/L is the hormone spelling of micro-IU (TSH, insulin): "U" and
  // "IU" are used interchangeably at this scale. Scoped to the MICRO-prefixed form
  // (the leading "uu") so it can never touch the bare enzyme "U/L" ≠ "IU/L" split
  // (#759), which requires an un-prefixed U (#918).
  s = s.replace(/^uu\/(ml|l)$/i, "uiu/$1");
  s = s.replace(/^([^/%]+)%$/, (m, num) => {
    const t = parseToken(num);
    return t && t.dim === "mass" ? `${num}/dL` : m;
  });
  return s;
}

// Parse one factor token (e.g. "mg", "dL", "uIU", "mmol", "U") into its base
// dimension and scale (prefix factor). Base matching is case-insensitive. The
// enzyme-activity "U" is matched case-insensitively too, but only as the trailing
// base after the mass/volume/amount bases have been tried — so a micro prefix "u"
// followed by a real base (ug, umol, uL) still parses as micro, while a bare "u"
// (nothing after it, so it can't be a prefix) is enzyme U. Enzyme U resolves to its
// OWN "enzyme" dimension, distinct from IU's "activity" (issue #759) — a "uIU"
// still matches the IU branch first and stays activity, only a bare "u"/"U" is
// enzyme, so IU/mL and U/mL never compare equal or cross-convert.
function parseToken(tok: string): { dim: Dim | "vol"; scale: number } | null {
  let base: Dim | "vol" | null = null;
  let prefix = "";
  if (/mol$/i.test(tok)) {
    base = "amount";
    prefix = tok.slice(0, -3);
  } else if (/IU$/i.test(tok)) {
    base = "activity";
    prefix = tok.slice(0, -2);
  } else if (/Eq$/i.test(tok)) {
    base = "eq";
    prefix = tok.slice(0, -2);
  } else if (/g$/.test(tok)) {
    base = "mass";
    prefix = tok.slice(0, -1);
  } else if (/[Ll]$/.test(tok)) {
    base = "vol";
    prefix = tok.slice(0, -1);
  } else if (/u$/i.test(tok)) {
    base = "enzyme";
    prefix = tok.slice(0, -1);
  }
  if (base == null) return null;
  const f = PREFIX[prefix];
  return f == null ? null : { dim: base, scale: f };
}

// Parse a concentration unit ("<amount>/<volume>") into its dimension and the
// scale that converts a value to the base unit (g/L, IU/L, mol/L, Eq/L). Returns
// null for non-concentration units (%, ratio, mmHg, counts like 10^3/uL, …).
function parseConc(unit: string): { dim: Dim; scale: number } | null {
  // Strip whitespace + normalize the micro sign, but preserve case so the
  // enzyme base "U" stays distinct from the micro prefix "u" (and m vs M).
  const s = aliasUnitTokens(
    unit.trim().replace(/µ|μ/g, "u").replace(/\s+/g, "")
  );
  const parts = s.split("/");
  if (parts.length !== 2) return null;
  const num = parseToken(parts[0]);
  const den = parseToken(parts[1]);
  if (!num || !den || num.dim === "vol" || den.dim !== "vol") return null;
  return { dim: num.dim, scale: num.scale / den.scale };
}

// A stable key for unit equivalence: functionally identical units share it
// (same dimension + same scale), so e.g. uIU/mL and mIU/L collapse together.
// Non-concentration units fall back to their spelling-normalized text.
function unitKey(unit: string): string {
  const c = parseCountConc(unit);
  if (c != null) return `count@${c.toExponential(6)}`;
  const p = parseConc(unit);
  if (p) return `${p.dim}@${p.scale.toExponential(6)}`;
  return normalizeUnitText(unit);
}

// Curated cross-dimension factors, keyed by canonical name then alternate unit
// (lowercased). value_in_alt * factor = value in the canonical unit.
const CONVERSIONS = new Map<string, Record<string, number>>();
for (const b of CANONICAL_BIOMARKERS) {
  if (b?.name && b?.conversions && typeof b.conversions === "object") {
    const m: Record<string, number> = {};
    for (const [unit, factor] of Object.entries(b.conversions)) {
      if (typeof factor === "number" && Number.isFinite(factor)) {
        m[unit.trim().toLowerCase()] = factor;
      }
    }
    if (Object.keys(m).length) CONVERSIONS.set(b.name.toLowerCase(), m);
  }
}

// Two units "match" when functionally identical (incl. SI/spelling variants), or
// when either is missing (a mismatch can't be proven).
export function sameUnit(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return true;
  return unitKey(a) === unitKey(b);
}

// Convert a reading's value into the canonical biomarker's unit. Order: identity
// / same-dimension scale (analyte-independent) → curated cross-dimension factor
// (matching the reading's dimension to a factor's alternate unit, so e.g. an
// LDL in µmol/L works off a mmol/L factor) → null when genuinely unconvertible.
export function convertToCanonical(
  value: number | null | undefined,
  unit: string | null | undefined,
  cb: { name?: string | null; unit?: string | null } | null | undefined
): number | null {
  if (value == null) return null;
  const canonUnit = cb?.unit ?? null;
  if (!canonUnit) return value;
  if (!unit) {
    // A unitless reading is normally assumed already in the canonical unit — but
    // NOT for a bare count-per-volume canonical (cells/uL), where the value is
    // ambiguous between cells/uL and a 10^n/uL scale. Guessing wrong here reads a
    // normal ANC of 7.5 (×10^3/uL) as 7.5 cells/uL → a false "agranulocytosis"
    // low. Decline instead so the flag is simply not derived.
    return isBareCountPerVolume(canonUnit) ? null : value;
  }
  if (sameUnit(unit, canonUnit)) return value;

  // Count concentrations (cells per volume): convert by the counts-per-liter
  // scale ratio, so e.g. 10^3/uL ↔ 10^6/uL rescales even when not identical.
  const cu = parseCountConc(unit);
  const cc = parseCountConc(canonUnit);
  if (cu != null && cc != null) return value * (cu / cc);

  const pu = parseConc(unit);
  const pc = parseConc(canonUnit);
  if (pu && pc && pu.dim === pc.dim) return value * (pu.scale / pc.scale);

  const factors = CONVERSIONS.get((cb?.name ?? "").toLowerCase());
  if (factors) {
    // Cross-dimension: convert the reading into the factor's alternate unit
    // (same dimension) first, then apply the analyte-specific factor.
    if (pu) {
      for (const [alt, factor] of Object.entries(factors)) {
        const pa = parseConc(alt);
        if (pa && pa.dim === pu.dim)
          return value * (pu.scale / pa.scale) * factor;
      }
    }
    // Fallback for non-parseable alternate units: exact (lowercased) match.
    const direct = factors[unit.trim().toLowerCase()];
    if (typeof direct === "number") return value * direct;
  }
  return null;
}

// Whether a reading's unit can be expressed in the canonical unit.
export function isConvertible(
  unit: string | null | undefined,
  cb: { name?: string | null; unit?: string | null } | null | undefined
): boolean {
  return convertToCanonical(1, unit, cb) != null;
}

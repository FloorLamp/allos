/**
 * Pure PHI scanner (a structural guard).
 *
 * Detects *likely-real* PHI in source/fixtures using high-signal STRUCTURAL
 * checks only — no name/org lists live here (that would itself commit PHI).
 * The design goal is a very low false-positive rate: a false positive blocks
 * the commit/CI, which is worse than no guard, so every check is tuned to pass
 * obviously-synthetic test data (the reserved `555-01xx` phone range, all-same
 * or sequential NPIs, invalid SSN area numbers) and flag only values that carry
 * a real-world checksum/shape.
 *
 * This module is PURE: no fs/DB/network. It operates on strings the runner
 * (`scripts/phi-scan.ts`) hands it. That keeps it unit-testable and lets the
 * runner decide which files to feed it (and which to skip).
 */

export type PhiKind = "npi" | "phone" | "ssn" | "denylist";

export interface Finding {
  kind: PhiKind;
  /** 1-based line number within the scanned text. */
  line: number;
  /** The line with the matched value masked — NEVER the raw value. */
  snippetRedacted: string;
}

export interface ScanOptions {
  filename?: string;
  /**
   * Optional literal strings (e.g. real names/orgs) to flag. Passed in by the
   * runner from an OPTIONAL, gitignored `.phi-denylist` file — never hardcoded
   * here or committed with real values. Matching is case-insensitive.
   */
  denylist?: string[];
}

/**
 * A line carrying this marker (in a comment, typically) suppresses ALL findings
 * on that line — the escape hatch for data that is provably synthetic but
 * happens to match a structural pattern.
 */
export const ALLOW_MARKER = "phi-scan-ok";

// ---------------------------------------------------------------------------
// NPI (National Provider Identifier)
// ---------------------------------------------------------------------------

/**
 * NPIs are 10 digits validated by the Luhn algorithm over the constant prefix
 * "80840" + the first 9 digits (per the CMS NPI check-digit spec). A random
 * 10-digit test number passes this only ~1 in 10 times, so a Luhn-valid NPI is
 * high-signal for a real identifier.
 */
export function isLuhnValidNpi(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false;
  const base = "80840" + digits.slice(0, 9);
  let sum = 0;
  let double = true; // rightmost digit of `base` is doubled
  for (let i = base.length - 1; i >= 0; i--) {
    let d = base.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits.charCodeAt(9) - 48;
}

/**
 * Even Luhn-valid, some numbers are transparently synthetic: all-identical
 * digits (9999999995) or a strict run (1234567893). Real NPIs are effectively
 * never shaped like this, so we treat them as safe fakes to avoid flagging
 * long-standing test fixtures.
 */
export function isSyntheticNpi(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false;
  const first9 = digits.slice(0, 9);
  if (/^(\d)\1{8}$/.test(first9)) return true; // all identical
  let asc = true;
  let desc = true;
  for (let i = 1; i < first9.length; i++) {
    const prev = first9.charCodeAt(i - 1) - 48;
    const cur = first9.charCodeAt(i) - 48;
    if (cur !== prev + 1) asc = false;
    if (cur !== prev - 1) desc = false;
  }
  return asc || desc;
}

// A 10-digit run not glued to other digits. Underscores/word chars around it
// (e.g. hex-ish ids) don't count as digit boundaries but adjacent digits do.
const NPI_RE = /(?<![0-9])\d{10}(?![0-9])/g;

// ---------------------------------------------------------------------------
// US phone (NANP)
// ---------------------------------------------------------------------------

// Phone-SHAPED strings: optional +1, area (parenthesised or bare) then a
// separator, exchange, separator, line. Requiring separators keeps this from
// matching bare 10-digit runs (those are the NPI path).
const PHONE_RE =
  /(?<![0-9])(?:\+?1[-. ]?)?(?:\((\d{3})\)|(\d{3}))[-. ](\d{3})[-. ](\d{4})(?![0-9])/g;

/**
 * True when a phone-shaped string looks like a REAL, dialable NANP number.
 * Everything the repo uses for fakes is excluded:
 *  - area/exchange must start 2-9 (a real NPA/NXX never starts 0 or 1)
 *  - area code 555 is not assignable (fictional)
 *  - exchange 555 covers the reserved fictional range 555-0100..555-0199 AND
 *    the movie-style 555-XXXX numbers (e.g. 555-1234)
 */
export function isLikelyRealPhone(
  npa: string,
  nxx: string,
  line: string
): boolean {
  if (!/^\d{3}$/.test(npa) || !/^\d{3}$/.test(nxx) || !/^\d{4}$/.test(line))
    return false;
  if (npa[0] < "2" || nxx[0] < "2") return false; // 0/1 lead => invalid
  if (npa === "555") return false; // not an assignable area code
  if (nxx === "555") return false; // fictional / reserved exchange
  return true;
}

// ---------------------------------------------------------------------------
// SSN
// ---------------------------------------------------------------------------

const SSN_RE = /(?<![0-9])(\d{3})-(\d{2})-(\d{4})(?![0-9])/g;

/**
 * True when a NNN-NN-NNNN string is a POSSIBLY-REAL SSN. The SSA never issues
 * these area/group/serial combos, so they're safe fakes and NOT flagged:
 *  - area 000, 666, or 900-999
 *  - group 00
 *  - serial 0000
 */
export function isLikelyRealSsn(
  area: string,
  group: string,
  serial: string
): boolean {
  if (area === "000" || area === "666" || area[0] === "9") return false;
  if (group === "00") return false;
  if (serial === "0000") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

function mask(value: string, label: PhiKind): string {
  // Reveal nothing but the shape. For numeric kinds keep separators so a
  // reviewer can tell what kind of value it was; for denylist terms (which may
  // be a real name/org) mask every character so nothing leaks into logs.
  if (label === "denylist") return "•".repeat(Math.min(value.length, 8));
  return value.replace(/\d/g, "•");
}

function redactLine(line: string, matched: string, label: PhiKind): string {
  const idx = line.indexOf(matched);
  const replaced =
    idx === -1
      ? line
      : line.slice(0, idx) +
        `[${label.toUpperCase()}:${mask(matched, label)}]` +
        line.slice(idx + matched.length);
  const trimmed = replaced.trim();
  return trimmed.length > 160 ? trimmed.slice(0, 157) + "…" : trimmed;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** Scan a single line (1-based `lineNo`). */
export function scanLine(
  text: string,
  lineNo: number,
  denylist: string[] = []
): Finding[] {
  if (text.includes(ALLOW_MARKER)) return [];
  const findings: Finding[] = [];

  for (const m of text.matchAll(NPI_RE)) {
    const val = m[0];
    if (isLuhnValidNpi(val) && !isSyntheticNpi(val)) {
      findings.push({
        kind: "npi",
        line: lineNo,
        snippetRedacted: redactLine(text, val, "npi"),
      });
    }
  }

  for (const m of text.matchAll(PHONE_RE)) {
    const npa = m[1] ?? m[2];
    const nxx = m[3];
    const lineDigits = m[4];
    if (isLikelyRealPhone(npa, nxx, lineDigits)) {
      findings.push({
        kind: "phone",
        line: lineNo,
        snippetRedacted: redactLine(text, m[0], "phone"),
      });
    }
  }

  for (const m of text.matchAll(SSN_RE)) {
    if (isLikelyRealSsn(m[1], m[2], m[3])) {
      findings.push({
        kind: "ssn",
        line: lineNo,
        snippetRedacted: redactLine(text, m[0], "ssn"),
      });
    }
  }

  const lower = text.toLowerCase();
  for (const term of denylist) {
    if (!term) continue;
    const re = denylistRegex(term);
    if (re) {
      // Regex term (`/pattern/flags`): precise matching so a name that is also a
      // common word (e.g. `\bMercer\b` bounded, or `Reed(?=['.]| [A-Z])`) doesn't flag
      // every incidental occurrence. Zero-width matches are skipped.
      for (const m of text.matchAll(re)) {
        if (!m[0]) continue;
        findings.push({
          kind: "denylist",
          line: lineNo,
          snippetRedacted: redactLine(text, m[0], "denylist"),
        });
      }
    } else {
      // Literal term: case-insensitive substring (back-compat).
      const idx = lower.indexOf(term.toLowerCase());
      if (idx !== -1) {
        // Redact the actual-cased substring so no real value survives.
        const actual = text.slice(idx, idx + term.length);
        findings.push({
          kind: "denylist",
          line: lineNo,
          snippetRedacted: redactLine(text, actual, "denylist"),
        });
      }
    }
  }

  return findings;
}

// A `.phi-denylist` entry written as `/pattern/flags` is a REGEX (precise, to avoid
// the false positives a bare common-word name causes as a substring); anything else is
// a literal. Compiled once per distinct term (the scanner calls scanLine per line).
// `g` is forced on so matchAll enumerates every hit; an invalid pattern compiles to
// null and falls back to literal handling (the runner surfaces it). NOTE: a
// user-authored regex runs against file/message content — a pathological pattern is a
// self-inflicted ReDoS on your own machine, so keep denylist patterns simple.
const DENYLIST_RE_CACHE = new Map<string, RegExp | null>();
export function denylistRegex(term: string): RegExp | null {
  const cached = DENYLIST_RE_CACHE.get(term);
  if (cached !== undefined) return cached;
  let re: RegExp | null = null;
  const m = /^\/(.+)\/([a-z]*)$/s.exec(term);
  if (m) {
    try {
      const flags = new Set([...m[2], "g"]);
      re = new RegExp(m[1], [...flags].join(""));
    } catch {
      re = null;
    }
  }
  DENYLIST_RE_CACHE.set(term, re);
  return re;
}

/** Scan a full text blob, returning findings across all lines. */
export function scanText(text: string, opts: ScanOptions = {}): Finding[] {
  const denylist = opts.denylist ?? [];
  const lines = text.split(/\r?\n/);
  const out: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(...scanLine(lines[i], i + 1, denylist));
  }
  return out;
}

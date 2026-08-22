// THE MACHINE-DATE CENSUS RULE (#3492).
//
// One question — "did a storage-format date reach something a person reads?" —
// written once, so the probe that asks it of rendered pages
// (e2e/machine-date-census.spec.ts) and the forged-source proof that the rule can
// SEE (lib/__tests__/machine-date-census.test.ts) are the same rule rather than two
// that can drift.
//
// WHY THIS IS NOT A SOURCE SCAN, AND THAT IS THE WHOLE DESIGN.
//
// Every one of the sites #3492 found is COMPUTED: the source says `{r.date}`,
// `value={doc.document_date}`, `input.dateLabel ?? input.date`. A grep of app/ and
// components/ for `\d{4}-\d{2}-\d{2}` finds NONE of them. What it does find is
// prose: dates in comments, in seed data, in test fixtures, in a `<time
// dateTime="2026-07-24">` attribute that is the boundary working correctly. So a
// source census here would be wrong in both directions at once — blind to every
// real offender, loud about things that are not copy — which is worse than no
// guard, because it converts "nobody has done this" into "nobody can do this" and
// only the first is true.
//
// The probe therefore reads RENDERED TEXT NODES. A text node is, by construction,
// the thing a person reads: attributes are not text nodes, `value=` is not a text
// node, a `<time datetime>` is not a text node, and a comment is not in the DOM at
// all. Most of what an ordinary allowlist would have to enumerate simply never
// reaches the collector, and the exemptions that remain are the ones below — each
// pinned to the premise that licenses it.

/**
 * A machine date in rendered copy: an ISO `YYYY-MM-DD` calendar day.
 *
 * WHAT THE MATCHER BUYS AND WHAT IT HIDES, stated rather than assumed:
 *
 *   • The month and day ranges are REAL ranges (01–12, 01–31) and the year is
 *     19xx/20xx. That is what keeps it quiet on the 4-2-2 digit runs that are not
 *     dates — an identifier, a lot number, a `1234-56-78` — so the guard does not
 *     cry wolf and get deleted.
 *   • It deliberately does NOT require a word boundary AFTER the day, because
 *     `\b` does not exist between `4` and `T`: `\b\d{4}-\d{2}-\d{2}\b` cannot see
 *     `2026-05-24T09:00:00Z`, and a raw ISO INSTANT in copy is the same defect
 *     wearing a longer suffix. The lookahead rejects only a continuing digit/dash
 *     run, so the date half of an instant is caught and `2026-05-24-3` is not.
 *   • It does not see `2026/05/24`, `20260524`, or `24.05.2026`. Those are other
 *     machine shapes and no surface in this repo emits them; if one ever does,
 *     widen this — do not add a second matcher.
 */
export const MACHINE_DATE_RE =
  /(?<![\d-])(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d-])/g;

/** Every machine date in one string. Empty when the text is clean. */
export function machineDateHits(text: string): string[] {
  return [...text.matchAll(MACHINE_DATE_RE)].map((m) => m[0]);
}

export interface CensusExemption {
  /** The subtree the probe does not read. */
  selector: string;
  /** Why a machine date is CORRECT here. */
  why: string;
  /**
   * The fact that licenses the exemption, asserted by the probe alongside it. An
   * exemption whose premise has gone false must go RED rather than quietly outlive
   * its reason — the #3260 failure mode, where an opt-out survived the death of the
   * sentence that justified it because nothing checked.
   */
  premise: string;
}

/**
 * The only rendered subtrees allowed to contain a machine date.
 *
 * Short, and it is short for a structural reason rather than a diligent one: the
 * usual candidates for an allowlist — `<time datetime>`, `input[type=date]` values,
 * export filenames in a `download` attribute, an API payload in a `data-` attribute
 * — are all ATTRIBUTES, and a text-node collector never sees them. They are the
 * boundary working correctly and they need no entry here. What is left is the one
 * place the app deliberately prints machine data AS TEXT for a person who asked for
 * machine data.
 */
export const CENSUS_EXEMPT_SUBTREES: CensusExemption[] = [
  {
    selector: '[data-testid="debug-disclosure"]',
    why:
      "The import detail page's Debug card shows the extraction error and the raw " +
      "extracted payload verbatim. Its subject IS the machine representation — " +
      "reformatting the dates inside a stored JSON payload would make it stop " +
      "being the payload.",
    premise:
      "It is a <details> that is CLOSED by default, so the machine data is " +
      "something a reader opts into rather than prose they are handed. Promote it " +
      "to always-visible and this exemption's reason is gone.",
  },
];

export interface KnownOffender {
  /** The censused route where this hit is met. */
  route: string;
  /** The nearest `data-testid` ancestor of the offending text node. */
  testId: string;
  /** The module that builds the sentence. */
  source: string;
  /** Why it is NOT fixed by the change that added this census. */
  why: string;
}

/**
 * MACHINE DATES THE CENSUS SEES AND IS NOT FIXING YET.
 *
 * This is NOT the exemption list above and must never be read as one: an entry here
 * is a real defect that a person can see, recorded rather than hidden. It exists
 * because a census that has to be green on the day it lands otherwise gets its
 * ROUTES trimmed until it is — which is the worst outcome available, since the
 * routes are the coverage.
 *
 * SHRINK-ONLY, the same discipline as the migration-hash manifest and the
 * e2e-hygiene allowlist: the probe asserts each entry is STILL offending, so the
 * day one is fixed the census fails and asks for the entry to be deleted. An entry
 * cannot quietly outlive the defect it names.
 */
export const CENSUS_KNOWN_OFFENDERS: KnownOffender[] = [
  {
    route: "/",
    testId: "attention-item-detail",
    source: "lib/biomarker-retest-copy.ts — biomarkerRetestDetail()",
    why:
      '"Last tested 2025-05-29 (15mo ago) · retest every 6mo". The sentence is ' +
      "composed inside the Upcoming generator (lib/queries/upcoming/generators.ts), " +
      "a profile-scoped query with NO login in context that also feeds the " +
      "notification and digest builders — so threading DisplayFormatPrefs through it " +
      "is a change to the Upcoming item contract, not a formatting call, and it is " +
      "materially larger than the surfaces #3492 enumerated. Found BY this census on " +
      "the run that first went green, which is the census doing its job.",
  },
];

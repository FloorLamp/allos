// Pure parsing of an extracted `prescription`-category record into the fields a
// structured `kind='medication'` intake_items row needs. No DB
// access, so it's unit-tested in lib/__tests__/prescription-parse.test.ts.
//
// The extraction pipeline (lib/medical-extract) emits a prescription as a loose
// record: `name` (the drug), and free text spread across `value`/`unit`/`notes`
// (a strength like "10 mg" and/or a sig/directions like "1 tab PO daily"). We
// turn that into: a clean drug name, a per-dose strength, a schedule (how many
// times a day + which time buckets), whether it's PRN (as-needed), and any
// prescriber/pharmacy/Rx that a labelled note happens to carry.
//
// The guiding rule is CONSERVATIVE: only schedule a med when the sig clearly
// states a frequency. An unparseable/absent sig yields an as-needed med (which
// the schedule machinery never marks due — no reminders/escalation) rather than
// a fabricated daily reminder the document never actually prescribed.

import {
  WRITTEN_NUMBER_SCAN,
  MID_NUMBER_PREFIX,
  NAME_SPLIT_BINDER_CHARS,
  readDoseQuantity,
} from "./dri";
import { parseDosage, spreadDoseTimes } from "./intake-schedule";

// "as needed", "as required", "when needed", "if needed", "prn" — a PRN med is
// taken on demand, so it carries no schedule. `if needed` is Epic's phrasing on a
// real pediatric nebulizer sig and was the gap that let a whole sig sentence past
// the #417 guard and into the strength field (#2939).
const PRN_RE =
  /\b(as[\s-]+needed|as[\s-]+required|when[\s-]+needed|if[\s-]+needed|p\.?r\.?n\.?)\b/i;

// "every 8 hours" / "q8h" style interval dosing → doses per day = round(24 / n).
// Epic writes the spelled-out number in parentheses between the digit and the unit
// ("every 6 (six) hours"), so a single parenthetical word is tolerated there (#2939)
// — without it the interval, and with it the whole frequency signal, went unseen.
const EVERY_HOURS_RE =
  /\b(?:every|q)\s*(\d+)\s*(?:\(\s*[a-z]+\s*\)\s*)?(?:hours?|hrs?|h)\b/i;

// Route-of-administration abbreviations stripped from a parsed dose amount so a
// strength reads "1 tab", not "1 tab PO".
const ROUTE_RE =
  /\b(po|iv|im|sq|sc|sl|pr|top|inh|ophth|otic|nasal|by[\s-]+mouth|per[\s-]+os|orally|subcutaneous(?:ly)?|intramuscular(?:ly)?)\b/gi;

// A leading imperative verb ("take", "give", "apply", "inject", "use") that
// precedes the actual dose in a sig.
const LEAD_VERB_RE = /^\s*(take|takes|taking|give|apply|inject|use|instill)\b/i;

const NAME_FORM_TAIL_RE =
  /\s+(tablets?|tabs?|capsules?|caps?|pills?|softgels?|lozenges?|patches?|sprays?|drops?|solution|suspension|injection|cream|ointment|gel|elixir|syrup)\b.*$/i;

// ONE dose grammar, shared by every reader below (the paren-strength strip, the
// name-strength recovery, and the dose-shape guard) so the three can't drift.
//
//   NUM        a decimal number
//   COUNT      the number(s) in front of a unit or a form. Real prescriptions write
//              more than a bare decimal here, and each notation MEANS something the
//              parser must not drop (all four were regressions caught in review):
//                * a fraction — "1/2 tablet" is everyday warfarin/levothyroxine/
//                  metoprolol dosing;
//                * a combination — "5/325 mg" is US e-prescribing for hydrocodone/
//                  APAP, and truncating it to "325 mg" renders a plausible
//                  acetaminophen strength that HIDES the opioid component;
//                * a range — "1-2 tablets", "1 to 2 tablets", "1 or 2 tablets".
//   DOSE_UNIT  a mass/volume/activity unit; the `\b` guards only the LETTER units
//              (so "g" can't eat a "g..." word prefix), while `%` sits outside it
//              — `%` is a non-word char, so `%\b` would only match when a letter
//              follows immediately ("2.5%cream"), never in "Hydrocortisone 2.5%".
//   RATIO_TAIL a concentration or per-body-weight denominator ("/5ML", "/3 mL",
//              "/mL", "/kg" — "1 mg/kg" is weight-based enoxaparin, and reading it
//              as a flat "1 mg" turns a scaled dose into a fixed one). The
//              denominator must END in a unit, so a stray slash in prose
//              ("10 mg / do not crush") can never extend the match.
//   QUANTITY   a count with a unit, denominator included.
//   DOSE_FORM  a countable dosage form — "1 tab" is a dose with no mass unit.
//
// NUM IS NOT SPELLED HERE. It is imported, and that import is the whole fix for #3444.
//
// This file used to write its own `\d+(?:\.\d+)?` — the exact pattern #3153/#3319
// retired from the dose and ingredient readers, for the exact reason it is retired
// here. A number pattern that cannot span a comma does not FAIL on "Bisoprolol 2,5 mg":
// it matches the "2", finds a comma where it needed a unit, and the scan RESTARTS one
// character later, where "5 mg" matches perfectly. `strengthFromName` returned "5 mg",
// `persistDocumentImport` stored it as the dose of a 2,5 mg tablet, and every reader
// downstream agreed — because "5 mg" IS readable. It is simply a different
// prescription. "Digoxin 0,125 mg" became "125 mg", a thousandfold overdose displayed
// beside its own honest name, on a drug with one of the narrowest therapeutic windows
// in the formulary.
//
// So the fix is not a wider pattern here; a second wider pattern is how the tree got
// two answers to "what does 2,5 mean" in the first place. `WRITTEN_NUMBER_SCAN` is the ONE
// spelling of "where does a written number start and end", exported from lib/dri.ts
// beside `readGroupedNumber`, the ONE rule for what it MEANS. Taking the number whole
// is what makes refusal possible at all: only a reader that has the entire "2,5" in its
// hand can decline to guess which locale printed it.
//
// A comma-decimal strength therefore survives INTO the dose amount verbatim ("2,5 mg"),
// where `readDoseQuantity` refuses it as unreadable and every total treats it as
// nothing to add. The person sees the strength their document stated; the safety maths
// declines to invent a number from it. That is the conservative reading, and it is the
// only one that cannot contradict the name it came from.
//
// IT IS THE *SCAN* SPELLING, because this file scans free text. The same restart that
// turned "2,5 mg" into "5 mg" turns the ISMP naked decimal "Digoxin .125 mg" into
// "125 mg" — measured on this path, not inferred — and the guard inside
// WRITTEN_NUMBER_SCAN is what stops it. See its comment in lib/dri.ts for why the
// obvious weaker lookbehind would not have.
const NUM = WRITTEN_NUMBER_SCAN;
const COUNT = String.raw`${NUM}(?:\s*/\s*${NUM})*(?:\s*(?:-|–|to|or)\s*${NUM}(?:\s*/\s*${NUM})*)?`;
const DOSE_UNIT = String.raw`(?:(?:mg|mcg|µg|ug|g|ml|iu|units?|meq)\b|%)`;
const DENOM_UNIT = String.raw`(?:(?:mg|mcg|µg|ug|g|ml|l|kg|lb|m2|iu|units?|meq)\b|%|m²)`;
const RATIO_TAIL = String.raw`(?:\s*/\s*(?:${NUM}\s*)?${DENOM_UNIT})*`;
const QUANTITY = String.raw`${COUNT}\s*${DOSE_UNIT}${RATIO_TAIL}`;
const DOSE_FORM = String.raw`(?:tab(?:let)?s?|caps?(?:ule)?s?|pills?|softgels?|lozenges?|puffs?|drops?|patch(?:es)?|sprays?|units?|sachets?|ampoules?|vials?|suppositor(?:y|ies)|applications?)`;
const STRENGTH_CONTENT = QUANTITY;

// A trailing strength/form segment on a drug NAME, e.g. the "10 mg" in
// "Lisinopril 10 mg" or "Metformin 500mg tablet". Used to derive a clean
// grouping name (so an extracted "Lisinopril 10 mg" dedups against a manual
// "Lisinopril") and to recover a strength when no separate value was extracted.
// The `\b` guards only the LETTER units (so "g" can't eat a "g..." word
// prefix); `%` sits outside it — `%` is a non-word char, so `%\b` would only
// match when a letter follows immediately ("2.5%cream"), never in a real
// percent strength like "Hydrocortisone 2.5%".
//
// BUILT FROM THE GRAMMAR ABOVE, not beside it. This was the file's FOURTH spelling of
// a number+unit — declared above the block whose header claims "ONE dose grammar,
// shared by every reader below", and therefore outside it. The drift was not
// hypothetical: it is why `cleanMedicationName("Bisoprolol 2,5 mg")` returned the name
// with its strength still attached, so the grouping name never matched a later plain
// "Bisoprolol" and the #1204 renewal path saw two different drugs (#3444). It keeps
// NUM rather than COUNT deliberately — a name-trailing strength is one number, and
// widening it to fractions/ranges/combinations would strip text off names this has
// never touched.
const NAME_STRENGTH_RE = new RegExp(
  String.raw`\s+${NUM}\s*${DOSE_UNIT}.*$`,
  "i"
);

// WHEN A NAME/STRENGTH SPLIT LANDED IN THE MIDDLE OF A NUMBER, and how this file can tell.
//
// The defect #3451 was filed for: "Metformin 1 000 mg" split into the name "Metformin 1"
// and the strength "000 mg", which reads as a confident ZERO — a niacin dose 28x the
// upper limit contributing nothing to it.
//
// The obvious repair is to let this grammar span the space, so "1 000" is taken whole.
// That repair is WRONG, and measuring the consumers is how we found out: a drug name may
// legitimately END IN A NUMBER, and spanning moves the split left on every one of them.
// "Vitamin B 12 1000 mcg" becomes the name "Vitamin B" — as do "Vitamin B 6" and
// "Vitamin B 1" — so `medicationFamilies` merges three distinct vitamins into one family
// and a B6 dose arms the B12 redose clock. "Humulin 70 30", "Humalog Mix 75 25",
// "Sinemet 25 100" and "Carbidopa Levodopa 25 100" lose their strengths the same way, and
// "Omega 3 1000 mg" stops folding onto the catalog's "Omega-3". Those failures are SILENT:
// nothing renders a grouping key, so nobody can correct one.
//
// THE DISCRIMINATOR IS NOT STRUCTURAL — "12 1000" and "1 000" are the same shape, and no
// lookbehind separates them. It is that A DOSE OF ZERO IS NOT A DOSE. A split that leaves
// a strength reading exactly 0 did not find a strength; it found the tail of a number.
// A split that leaves a readable non-zero strength found a strength, and the digits before
// it belong to the name.
//
// So the narrow split runs first and keeps its answer everywhere main kept it, and the
// wide one is reached only when the narrow answer is that zero. Measured across the real
// product names above: every one keeps main's split, and the three that produced a
// confident zero — "Metformin 1 000 mg", "Vitamin C 1 000 mg", "Niacin 1 000 mg" — are the
// only ones that move.
//
// WHAT THIS DOES NOT REACH, named rather than implied: a NON-zero tail. "Metformin
// 1 500 mg" still splits to the name "Metformin 1" and the strength "500 mg", exactly as
// on main. That is the count-then-strength ambiguity — "one 500 mg tablet" is as good a
// reading as fifteen hundred milligrams — and 500 is the conservative one of the two.
const MID_NUMBER_PREFIX_RE = new RegExp(MID_NUMBER_PREFIX);

function readsZero(strength: string | null): boolean {
  if (strength == null) return false;
  const reading = readDoseQuantity(strength);
  return reading.kind === "quantity" && reading.value === 0;
}

// Given the whole string and where a candidate strength starts in it, how far LEFT that
// strength really starts — the same index when the split is sound, and one digit-run
// earlier when it landed in the middle of a number.
function strengthStart(raw: string, narrowStart: number): number {
  const prefix = raw.slice(0, narrowStart);
  const m = prefix.match(MID_NUMBER_PREFIX_RE);
  return m ? narrowStart - m[0].length : narrowStart;
}

// A PARENTHESIZED strength/concentration segment in a drug name — the common
// MyChart/e-prescribing rendering: "albuterol (2.5 MG/3ML)", "amoxicillin
// (400 mg/5 mL) suspension" (issue #1026). NAME_STRENGTH_RE requires a bare
// digit after whitespace, so it never saw these. A parenthetical is stripped
// ONLY when its content is strength-shaped — a number + dose unit, optionally
// "/denominator" segments for a concentration or combination strength — so an
// ingredient/brand parenthetical ("Tylenol (acetaminophen)") carries no
// digit+unit pair and always survives (pinned by test). Position-independent:
// the segment may sit mid-name before a form word.
//
// The cleaning form truncates from the strength parenthetical TO THE END —
// mirroring NAME_STRENGTH_RE's `.*$` — so the form/packaging words that follow
// ("nebulizer solution", "suspension") go with it.
const PAREN_STRENGTH_TAIL_RE = new RegExp(
  String.raw`\(\s*${STRENGTH_CONTENT}\s*\).*$`,
  "i"
);
// Capturing twin for strengthFromName (recovers the bare content, parens off).
const PAREN_STRENGTH_CAPTURE_RE = new RegExp(
  String.raw`\(\s*(${STRENGTH_CONTENT})\s*\)`,
  "i"
);

// Does a string carry any scheduling signal — a frequency token, an "every N
// hours" interval, or a PRN marker? A dose-shaped `value` that ALSO carries one
// of these (e.g. a CCD/FHIR sig "Take 1 tablet by mouth daily") is DIRECTIONS,
// not a bare strength, so it must be routed to the sig (where the schedule is
// inferred) rather than swallowed whole as the strength (#417).
// Deliberately tests the WHOLE text, unlike the scheduling decision below: this only
// asks "is this directions rather than a strength?", and answering yes routes the text
// to the sig field. A PRN marker anywhere is evidence of prose either way, and routing
// prose to the sig is the harmless direction.
export function looksLikeSig(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    PRN_RE.test(text) || EVERY_HOURS_RE.test(text) || hasFrequencyToken(text)
  );
}

// WHICH PRN MARKER GOVERNS THE MEDICATION?
//
// A PRN marker turns a med as-needed, which SUPPRESSES its reminders and its
// missed-dose escalation. That makes it a safety-signal suppression path, and such a
// path may only fire where it is meant to. "as needed" / "if needed" also appear in
// trailing ADVISORY clauses that say nothing about the dosing schedule:
//
//   "Take 1 tablet by mouth twice daily. Call your provider if needed."
//   "Take 1 tablet daily. May repeat if needed."
//   "Take 2 tablets twice daily. Adjust dose if needed."
//
// Reading those as PRN turned a twice-daily beta blocker into an unscheduled med with
// no reminders at all. So the marker governs only when it sits in the PRIMARY DOSING
// SENTENCE — the first one, which is where a sig states its dose and frequency. A
// marker that appears ONLY in a later sentence is advice about something else.
//
// The split is on SENTENCE boundaries only (a period/!/? followed by space), never on
// the ";" that parsePrescription uses to join notes to a value — otherwise a med whose
// frequency and PRN marker arrived in different source fields ("1 tab daily; as needed
// for pain") would lose its PRN reading, which is the unsafe direction.
//
// This can only make a med SCHEDULED when the first sentence itself states a definite
// frequency; with no frequency there, parseSig still returns unscheduled/as-needed by
// its existing conservative default. So nothing that was genuinely PRN becomes a
// reminder. (Main had the same defect for "as needed"; scoping fixes both.)
function primaryDosingClause(text: string): string {
  return text.split(/(?<=[.!?])\s+/)[0] ?? text;
}

function statesAsNeeded(text: string): boolean {
  return PRN_RE.test(primaryDosingClause(text));
}

// A frequency/timing token that makes a sig schedulable. Its ABSENCE (together
// with no interval and no PRN marker) is what flags a sig as unparseable, so we
// don't invent a daily schedule.
function hasFrequencyToken(text: string): boolean {
  return (
    /\b\d+\s*(?:x|times)\b/i.test(text) ||
    /\b(once|twice|thrice|three\s+times|four\s+times)\b/i.test(text) ||
    /\b(qd|bid|tid|qid|qhs|qam|qpm|od|hs|q\.?d\.?|b\.?i\.?d\.?|t\.?i\.?d\.?|q\.?i\.?d\.?)\b/i.test(
      text
    ) ||
    /\b(daily|nightly|every\s+day|per\s+day|a\s+day|each\s+day)\b/i.test(
      text
    ) ||
    /\b(morning|midday|noon|evening|night|bedtime|breakfast|lunch|dinner)\b/i.test(
      text
    )
  );
}

// One dose expression: a quantity or a counted form ("1/2 tablet"), optionally as a
// range whose two halves each carry a unit ("12.5 mg-25 mg" — a titration range, which
// COUNT's own range cannot express because the unit repeats), optionally followed by a
// parenthesized equivalent ("1.5 mL (1.25 mg)" — Epic states the volume, then the mass
// it delivers) and optionally by a form word ("1 tablet").
const DOSE_ATOM = String.raw`(?:${QUANTITY}|${COUNT}\s*${DOSE_FORM})`;
const DOSE_RANGE = String.raw`${DOSE_ATOM}(?:\s*(?:-|–|to|or)\s*${DOSE_ATOM})?`;
const DOSE_EXPR = String.raw`${DOSE_RANGE}(?:\s*\(\s*${DOSE_RANGE}\s*\))?(?:\s+${DOSE_FORM})?`;
const DOSE_WHOLE_RE = new RegExp(String.raw`^\s*${DOSE_EXPR}\s*$`, "i");
const DOSE_LEAD_RE = new RegExp(String.raw`^\s*(${DOSE_EXPR})`, "i");

// Is this string a dose AS A WHOLE ("10 mg", "1 tab", "1.5 mL (1.25 mg)")?
//
// The predicate used to ask only whether a digit and a unit token appeared ANYWHERE,
// which passed whole sentences: a 90-character sig containing "1.5 mL" and a product
// string containing "400 MG/5ML" both qualified, and the #417 guard then stored the
// entire text as the medication's strength (#2939). A strength field holds a dose, so
// the test is whether the value READS as one end to end — a sentence that merely
// mentions a dose is directions or a product name, and belongs in the sig.
export function looksLikeDose(s: string | null | undefined): boolean {
  if (!s) return false;
  return DOSE_WHOLE_RE.test(s);
}

// The dose a string BEGINS with, if any ("1.5 mL (1.25 mg) by nebulization every 6
// hours" → "1.5 mL (1.25 mg)"). Sigs state the dose first and the instructions after,
// so the leading span is the amount; a string that doesn't start with a dose (a
// product name, "as needed for pain") has none to give.
function leadingDose(s: string): string | null {
  const m = s.match(DOSE_LEAD_RE);
  return m ? m[1].replace(/\s{2,}/g, " ").trim() : null;
}

// Clean a parsed dose amount: strip route abbreviations and a leading verb, then keep
// the dose it starts with. Taking the LEADING dose rather than the whole remainder is
// what stops a sig tail ("… by nebulization every 6 (six) hours if needed for
// wheezing.") from riding along into the strength field (#2939).
function cleanAmount(amount: string | null): string | null {
  if (!amount) return null;
  const cleaned = amount
    .replace(LEAD_VERB_RE, "")
    .replace(ROUTE_RE, " ")
    .replace(/[,;]+\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return leadingDose(cleaned);
}

// True when a string has as many "(" as ")" — a cheap balance proxy good enough
// for drug names (which never legitimately nest). Used to reject a paren strip
// that would cut into a NESTED parenthetical and strand a dangling bracket.
function parensBalanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

// Strip a trailing strength/form off a drug name to get a stable grouping name.
// Used for both the stored med name and for de-duping an extracted med against a
// manually-entered one (so "Lisinopril 10 mg" and "Lisinopril" are one med).
export function cleanMedicationName(raw: string): string {
  const name = (raw ?? "").trim();
  // Parenthesized strengths first (position-independent): the parenthetical and
  // everything after it go — "amoxicillin (400 mg/5 mL) suspension" → "amoxicillin".
  // PAREN_STRENGTH_TAIL_RE's `.*$` eats the closing bracket that trails the
  // strength, so on a NESTED shape ("Drug (foo (2.5 mg))") it would leave an
  // unbalanced "Drug (foo". Only accept the paren strip when the result's brackets
  // stay balanced; otherwise skip that pass and leave the (rare, contrived) nested
  // name intact rather than mangle it — the strength is still recovered separately.
  const parenStripped = name.replace(PAREN_STRENGTH_TAIL_RE, " ");
  const base = parensBalanced(parenStripped) ? parenStripped : name;
  // The narrow split first, and the wide one ONLY when the narrow one landed in the
  // middle of a number — i.e. left behind a strength reading zero (see splitsMidNumber).
  // Everything else keeps the split it has always had, names ending in a number included.
  const narrow = base.match(NAME_STRENGTH_RE);
  // Cut the strength off where it REALLY starts. Identical to the narrow match unless
  // that match was the tail of a number, which `readsZero` is how we can tell.
  const cutAt =
    narrow && readsZero(narrow[0])
      ? strengthStart(
          base,
          narrow.index! + narrow[0].length - narrow[0].trimStart().length
        )
      : -1;
  const stripped = (cutAt >= 0 ? base.slice(0, cutAt) : base)
    .replace(NAME_STRENGTH_RE, "")
    .replace(NAME_FORM_TAIL_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Never strip the name down to nothing — fall back to the original.
  return stripped || name;
}

// Pull the strength out of a drug name ("Lisinopril 10 mg" → "10 mg"), when the
// extractor packed it into the name instead of a separate value/unit. Same
// unit alternation as NAME_STRENGTH_RE: `%` lives outside the `\b`-terminated
// letter-unit group (see the comment there). Exported for the #1027 / #1204
// different-strength comparison in the import + renewal paths.
export function strengthFromName(raw: string): string | null {
  // A parenthesized strength/concentration wins and is recovered WHOLE
  // ("albuterol (2.5 MG/3ML)" → "2.5 MG/3ML"), denominator included — the same
  // shape cleanMedicationName strips (#1026). The bare match below would
  // otherwise stop at the numerator ("2.5 MG").
  const paren = raw.match(PAREN_STRENGTH_CAPTURE_RE);
  if (paren) return paren[1].replace(/\s{2,}/g, " ").trim();
  // Same QUANTITY grammar as the parenthesized twin, denominator included, so the
  // SAME product written with or without brackets yields the same strength:
  // "Amoxicillin 400 MG/5ML Suspension" → "400 MG/5ML", not the bare "400 MG" the
  // numerator-only pattern used to stop at (#2939).
  //
  // THE PREFIX IS A LOOKBEHIND, NOT `\b`, AND THE TWO ARE THE SAME ASSERTION HERE FOR
  // EVERY DIGIT-LED STRENGTH. `\b` before a word character means "the character before
  // is not a word character", which is exactly `(?<![A-Za-z0-9_])`. It stops a strength
  // being read out of the middle of a token ("B12 500 mcg" must yield 500 mcg, never
  // "12"), and that job is unchanged.
  //
  // They differ on ONE input, and it is the reason for the swap: a strength that begins
  // with a SEPARATOR. `\b` before the "." of "Digoxin .125 mg" demands the PRECEDING
  // character be a word character — it is a space — so the match failed there and the
  // scan moved on to the "125", returning "125 mg" for a 0.125 mg dose. The lookbehind
  // asks the question that was actually meant, so the naked decimal is matched WHOLE and
  // refused downstream instead of being re-read as a thousandfold larger dose (#3444).
  const m = raw.match(
    new RegExp(String.raw`(?<![${NAME_SPLIT_BINDER_CHARS}0-9])${QUANTITY}`, "i")
  );
  if (!m) return null;
  const narrow = m[0].replace(/\s{2,}/g, " ").trim();
  // Same fallback as cleanMedicationName, and it HAS to be the same one or the two halves
  // disagree about where the name ends: a strength reading ZERO is the tail of a number,
  // so the strength really began one digit-run earlier (#3451).
  if (!readsZero(narrow)) return narrow;
  const start = strengthStart(raw, m.index!);
  return start === m.index!
    ? narrow
    : raw
        .slice(start, m.index! + m[0].length)
        .replace(/\s{2,}/g, " ")
        .trim();
}

export interface ParsedSig {
  asNeeded: boolean;
  // Doses per day when the sig states a clear frequency; null when the frequency
  // couldn't be parsed (the med is then treated as as-needed / unscheduled).
  timesPerDay: number | null;
  amount: string | null; // per-dose amount embedded in the sig, if any
  timeBuckets: (string | null)[]; // one bucket per scheduled dose
}

// Parse a sig / directions string ("1 tab PO daily", "take 2 tablets twice
// daily", "as needed for pain", "every 8 hours") into a schedule. Reuses the
// dosage parser for the amount + per-day count, adds interval ("every N hours")
// and PRN handling, and — crucially — returns `timesPerDay: null` (unscheduled)
// when no frequency signal is present rather than defaulting to daily.
export function parseSig(sig: string | null | undefined): ParsedSig {
  const text = (sig ?? "").trim();
  if (!text) {
    return { asNeeded: true, timesPerDay: null, amount: null, timeBuckets: [] };
  }

  if (statesAsNeeded(text)) {
    return {
      asNeeded: true,
      timesPerDay: null,
      amount: cleanAmount(parseDosage(text).amount),
      timeBuckets: [],
    };
  }

  const d = parseDosage(text);
  const amount = cleanAmount(d.amount);

  let perDay: number | null = null;
  const everyH = text.match(EVERY_HOURS_RE);
  if (everyH) {
    const hrs = Number(everyH[1]);
    perDay = hrs > 0 ? Math.max(1, Math.round(24 / hrs)) : null;
  } else if (hasFrequencyToken(text)) {
    perDay = d.perDay; // parseDosage's per-day (defaults to 1 for "daily")
  }

  if (perDay == null) {
    // No parseable frequency — don't fabricate a schedule. Unscheduled/as-needed.
    return { asNeeded: true, timesPerDay: null, amount, timeBuckets: [] };
  }

  return {
    asNeeded: false,
    timesPerDay: perDay,
    amount,
    timeBuckets: spreadDoseTimes(perDay, d.timeOfDay),
  };
}

// Labelled provenance pulled from a note when clearly present. All optional and
// conservative — an unlabelled note yields nulls rather than a guess.
function matchLabelled(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:#]?\\s*([^;,\\n]+)`, "i");
    const m = text.match(re);
    if (m) {
      const v = m[1].trim().replace(/\s{2,}/g, " ");
      if (v) return v;
    }
  }
  return null;
}

function rxNumberFrom(text: string): string | null {
  const m = text.match(
    /\b(?:rx|prescription)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9-]{4,})\b/i
  );
  return m ? m[1].trim() : null;
}

function prescriberFrom(text: string): string | null {
  const labelled = matchLabelled(text, [
    "prescriber",
    "prescribed by",
    "ordered by",
    "provider",
    "physician",
    "doctor",
  ]);
  if (labelled) return labelled;
  const dr = text.match(
    /\bDr\.?\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/
  );
  return dr ? `Dr. ${dr[1].trim()}` : null;
}

function pharmacyFrom(text: string): string | null {
  return matchLabelled(text, ["pharmacy", "filled at", "dispensed by"]);
}

export interface PrescriptionRecordInput {
  name: string;
  value?: string | null;
  unit?: string | null;
  notes?: string | null;
  // Structured attribution the CCD/FHIR mappers resolve directly from the source
  // (FHIR requester / dispenseRequest.performer / identifier; CCD med author +
  // <supply>). When present these WIN over the free-text scraping below, so an
  // imported medication carries the pharmacy's own attribution rather than always
  // NULL (#417). Absent on the AI path, which has no structured slots.
  prescriber?: string | null;
  pharmacy?: string | null;
  rxNumber?: string | null;
}

export interface ParsedPrescription {
  name: string; // cleaned drug/grouping name (never empty)
  strength: string | null; // per-dose strength for the dose row's `amount`
  asNeeded: boolean;
  timesPerDay: number | null;
  timeBuckets: (string | null)[];
  prescriber: string | null;
  pharmacy: string | null;
  rxNumber: string | null;
  sig: string | null; // the directions text we parsed (kept for the row's notes)
}

// Reduce an extracted prescription record to structured medication fields. The
// extractor doesn't have dedicated strength/sig/prescriber slots, so we treat the
// fields heuristically: a dose-shaped `value` is the strength; anything else in
// `value`/`notes` is the sig (and the source of prescriber/pharmacy/Rx labels).
export function parsePrescription(
  rec: PrescriptionRecordInput
): ParsedPrescription {
  const rawName = (rec.name ?? "").trim();
  const value = (rec.value ?? "").trim() || null;
  const unit = (rec.unit ?? "").trim() || null;
  const notes = (rec.notes ?? "").trim() || null;

  // Strength: an explicit dose-shaped value (+unit) wins; else recover it from
  // the drug name ("Lisinopril 10 mg").
  // Append the unit only when `value` doesn't already carry it. `unit` is
  // untrusted extracted text, so use a plain suffix check rather than building a
  // RegExp from it — a stray metacharacter (e.g. an unmatched ")") would throw
  // and abort the whole import transaction.
  const valueEndsWithUnit =
    !!unit &&
    value != null &&
    value.trimEnd().toLowerCase().endsWith(unit.toLowerCase());
  const valueWithUnit = value
    ? unit && !valueEndsWithUnit
      ? `${value} ${unit}`
      : value
    : null;
  // A `value` that carries a scheduling signal (a CCD/FHIR sig like "Take 1
  // tablet by mouth daily") is DIRECTIONS, not a bare strength — route it to the
  // sig so its frequency is inferred, and never swallow the whole sentence as the
  // strength (#417). A value that is neither a sig nor a dose END TO END is a
  // product string ("Amoxicillin 400 MG/5ML Suspension Reconstituted"), which no
  // sig detector can catch because it isn't a sig — the whole-shape test in
  // looksLikeDose is what stops it (#2939).
  const valueIsSig = looksLikeSig(value);
  const explicitStrength =
    valueWithUnit && !valueIsSig && looksLikeDose(valueWithUnit)
      ? valueWithUnit
      : null;

  // Sig: free-text directions. A dose-shaped value with no schedule signal is a
  // strength, not a sig, so it's excluded; notes, a non-dose value, and a
  // schedule-bearing value are joined into the sig text.
  const sigParts: string[] = [];
  if (notes) sigParts.push(notes);
  if (value && (valueIsSig || !looksLikeDose(value))) sigParts.push(value);
  const sig = sigParts.join("; ") || null;

  const parsed = parseSig(sig);
  // A product string carries its strength the way a NAME does, so when nothing else
  // yielded one, read it with the same extractor rather than losing the "400 MG/5ML"
  // the row was the only record of (#2939). Last in the chain: it's the most
  // speculative reading, and only a value that is neither a sig nor a whole dose —
  // i.e. name-shaped text — ever reaches it.
  const productStrength = value && !valueIsSig ? strengthFromName(value) : null;
  const strength =
    explicitStrength ??
    strengthFromName(rawName) ??
    parsed.amount ??
    productStrength;

  const provText = [notes, value].filter(Boolean).join("; ");

  // Structured attribution from the mapper wins; the free-text scrape is only the
  // fallback for a source that carried the fields inside a note (#417).
  const structuredPrescriber = rec.prescriber?.trim() || null;
  const structuredPharmacy = rec.pharmacy?.trim() || null;
  const structuredRxNumber = rec.rxNumber?.trim() || null;

  return {
    name: cleanMedicationName(rawName),
    strength,
    asNeeded: parsed.asNeeded,
    timesPerDay: parsed.timesPerDay,
    timeBuckets: parsed.timeBuckets,
    prescriber:
      structuredPrescriber ?? (provText ? prescriberFrom(provText) : null),
    pharmacy: structuredPharmacy ?? (provText ? pharmacyFrom(provText) : null),
    rxNumber: structuredRxNumber ?? (provText ? rxNumberFrom(provText) : null),
    sig,
  };
}

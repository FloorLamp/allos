// The IMPORTED-NAME BOUNDARY (issue #3480) — how a portal document's own label for
// a medication stops being the name a person reads on /medications.
//
// WHAT WAS WRONG. A portal-imported medication carries its document string as the
// item's display name, and every surface renders it as stored: "Calcium
// Carb-Cholecalciferol (CALCIUM 500 + D OR)" is the brand-coloured heading on the
// /medications row (app/(app)/medications/MedicationRow.tsx), the option text in the
// dose ledger's item filter, and the title in the import listing. The parenthetical
// is the portal's ALL-CAPS sig-style label with a dose-form code ("OR" = oral) —
// shouting, jargon-bearing, and not what a person calls their medicine.
//
// WHY NOT A DISPLAY PASS, and this is the whole point of the module. The cheap fix
// is a caps-softening/title-case transform where the name renders. It is rejected,
// and lib/allergen-vocabulary.ts already records why for the sibling problem: a
// title-case pass mangles clinical names ("penicillin v potassium"). Portal strings
// make it worse — they embed dose-form codes, and NO casing heuristic can tell
// whether "OR" is the route abbreviation or the English word inside a product name.
// A display pass also rewrites text the person may have typed deliberately, every
// time it renders, with nobody ever having agreed to it.
//
// SO THE CLEANING HAPPENS ONCE, AT THE IMPORT BOUNDARY, WITH THE PERSON CONFIRMING.
// This module is the predicate half of that: given a name an import wrote, does it
// read as the DOCUMENT's label rather than as a name? A true answer buys an OFFER on
// the import review page (components/import/ImportedNameOffer.tsx) — the RxNorm
// preferred name for the same string, which the person accepts or ignores. Nothing
// here rewrites anything, and nothing here runs on a name a person typed: the caller
// consults it only for rows the import created (`source = 'extracted'`), so a
// deliberate spelling can never be second-guessed by it.
//
// Pure — no DB, no network, no React. The scope gate ("only imported rows") is the
// CALLER's, deliberately: a predicate that also had to know a row's provenance would
// be two rules, and the SQL that selects extracted rows is already the honest place
// for the second one (lib/queries/imports.ts `getDocumentMedications`).

// Word boundaries for the shout scan. Whitespace splits words; hyphens and slashes
// split them too, so "CALCIUM-D" contributes its "CALCIUM" rather than hiding it
// inside a longer token — and, symmetrically, "Carb-Cholecalciferol" is read as two
// ordinary capitalized words instead of one mixed-case blob.
const WORD_SPLIT_RE = /[\s\-/]+/;

// Trim the punctuation a portal string wraps its words in — parentheses, commas,
// plus signs, periods — so "(CALCIUM" is scanned as "CALCIUM".
//
// UNICODE LETTER CLASSES, not `[A-Za-z0-9]`, and the difference is not decorative:
// an ASCII class treats every accented letter as punctuation, so "üBERALL" had its
// leading "ü" TRIMMED OFF as though it were a bracket and the remaining "BERALL"
// read as a six-letter shout. The token is scanned whole now, and a name that
// starts with a lower-case letter of any alphabet is a name starting with a
// lower-case letter.
const EDGE_PUNCT_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

// A word must carry at least this many letters before its casing means anything. A
// one-letter token is a vitamin letter ("Vitamin D"), a strength suffix, or an
// initial — never a shout, and treating it as one would flag half the supplement
// shelf.
const MIN_SHOUT_LETTERS = 2;

// SHOUTING IS NOT ONE SIGNAL, AND THE FIRST VERSION OF THIS MODULE TREATED IT AS ONE.
// It asked "how much of this name is upper-case", which cannot tell the drug's name
// being SHOUTED ("PREDNISONE 10 mg") from a name that simply IS an abbreviation
// ("NAC", "DHEA", "MCT oil"). Measured over 19 ordinary supplement names, that rule
// fired on 17 of them — an offer on every one of which is noise, and noise is the
// one thing this offer cannot afford: a prompt that fires on ordinary names gets
// dismissed by habit, taking the real one with it. The three rules below replace it,
// and each names a DIFFERENT shape rather than a different amount of the same one.

// RULE 1 — A SHOUTED WORD. Six or more upper-case letters in one token is a word
// being shouted, not an abbreviation being used: the longest abbreviation anybody
// writes as a medicine's own name is five letters ("TUDCA"), while the shapes portals
// export are full words — PREDNISONE, LISINOPRIL, METFORMIN, CALCIUM, EPIPEN,
// TABLET. One is enough on its own.
const SHOUTED_WORD_LETTERS = 6;

// RULE 2 — A DISPENSING LABEL. Two or more shouted tokens, at least one of them four
// letters or longer ("HCTZ 25 MG TAB"), or three or more of any length CARRYING A
// STRENGTH ("ASA 81 MG TAB", "VIT D 1000 IU CAP"). A name plus a strength unit plus a
// dose form is a pharmacy label; two SHORT abbreviations on their own are where the
// supplement shelf lives ("EPA/DHA", "Omega-3 EPA DHA"), so two is not enough unless
// one of them is long enough to be a word rather than an initialism.
//
// AND THE THREE-TOKEN FLOOR WAS ONE TOKEN FROM THE SHELF IT PROTECTS. "EPA/DHA" is
// quiet because it has TWO shouted tokens, not because of the slash — so "EPA DHA
// CLA", "MSM MCT ALA" and "EPA/DHA/DPA" all fired, and those are front-of-bottle
// listings of actives, the exact register this rule exists to leave alone. What
// separates them from "ASA 81 MG TAB" is not the count and not the separator: it is
// that a dispensing label STATES A STRENGTH and a list of actives does not. Every
// positive this branch was written for carries a number — 81, 1000, 25 — and none of
// the shelf shapes does, so the number is the evidence and the count alone is not.
//
// It is a structural test, not a vocabulary: no unit list, no dose-form list, nothing
// to keep in step with a catalog. The under-match it accepts is a bare-abbreviation
// label with no strength at all ("ASA EC TAB"), which stays quiet — the same
// direction of error rule 1's six-letter floor already chooses, and the same reason:
// a missed offer costs a person nothing, a fired one costs them every future offer.
const SHOUTED_ABBREVIATION_LETTERS = 4;
const MIN_SHOUTING_WORDS = 2;
const MIN_SHOUTING_ABBREVIATIONS = 3;

// A digit run anywhere in the name — the strength a dispensing label always states.
const STRENGTH_DIGITS_RE = /\p{Nd}/u;

// RULE 3 — TALL MAN LETTERING, and this is the one the first version was INVERTED
// against. "amLODIPine", "predniSONE", "traMADol", "glipiZIDE", "hydrOXYzine": an
// upper-case run inside an otherwise lower-case word, the ISMP convention for
// look-alike drug names and standard Epic/Cerner medication-list output. It is the
// single commonest register this feature exists for, and every one of those names was
// QUIET under the old share rule because most of their letters are lower case.
//
// IT COMES IN BOTH ORDERS, and the first version of this line only saw one of them.
// ISMP renders the DISTINGUISHING part of the name in capitals, and that part is as
// often the STEM as the tail: "DOPamine", "DOBUTamine", "OXYcodone", "CISplatin",
// "PARoxetine", "NIFEdipine" are the canonical published renderings — arguably the
// most important ones — and every single one of them was FALSE under a pattern that
// required lower-case letters BEFORE the run. So the rule is two alternatives:
//
//   * an upper-case run of two or more letters PRECEDED by two or more lower-case
//     letters in the same token — "amLODIPine", "predniSONE", "traMADol";
//   * a token that OPENS with an upper-case run of three or more and then turns
//     lower-case for two or more — "DOPamine", "OXYcodone".
//
// Every floor is load-bearing, and each one names a shape it exists to exclude:
//   * one upper-case letter is ordinary product spelling — "CoQ10", "EpiPen";
//   * one PRECEDING lower-case letter is the "mRNA"/"GoLYTELY" shape, a spelling
//     rather than a warning;
//   * the leading run needs THREE, because two is "NaCl" and every other two-letter
//     element or unit symbol, and the shortest name on the ISMP list is three
//     ("CISplatin", "DOPamine", "OXYcodone");
//   * the trailing lower-case run needs TWO, because one is "NSAIDs", "MCTs", "IUs" —
//     an abbreviation wearing a plural, not a name wearing a warning. It is also what
//     keeps "Metformin HCl ER" quiet.
//
// The classes are Unicode (`\p{Lu}`/`\p{Ll}`) for the same reason EDGE_PUNCT_RE is:
// a cased alphabet is not only ASCII, and an ASCII class silently reads a non-ASCII
// lower-case letter as no letter at all.
//
// KNOWN CLOSE CALL: trademark styling of the same shape fires — "MiraLAX", "HumaLOG".
// That is the direction to be wrong in. A true answer buys an OFFER the person can
// ignore, never a rewrite, and RxNorm's answer for those really is the plainer name.
const TALL_MAN_RE = /\p{Ll}{2}\p{Lu}{2,}|^\p{Lu}{3,}\p{Ll}{2,}/u;

// How many letters does this token shout? 0 when it does not shout at all. Digits and
// punctuation inside the token are ignored, so "10MG" shouts on its "MG" and "B12"
// shouts not at all (one letter).
function shoutedLetters(word: string): number {
  const letters = word.match(/\p{L}/gu) ?? [];
  if (letters.length < MIN_SHOUT_LETTERS) return 0;
  // `c === c.toUpperCase()` alone answers TRUE for a letter with no case at all, so
  // a token in a caseless script would read as shouting every time. The second half
  // asks that the letter be CASED, which is the thing shouting is a property of.
  return letters.every((c) => c === c.toUpperCase() && c !== c.toLowerCase())
    ? letters.length
    : 0;
}

function tokens(name: string): string[] {
  return (name ?? "")
    .split(WORD_SPLIT_RE)
    .map((w) => w.replace(EDGE_PUNCT_RE, ""))
    .filter((w) => w.length > 0);
}

// Every shouted word in a name, in source order. Exported for the guard, which
// asserts on WHICH words a name shouts rather than only on the verdict — a predicate
// that reached the right answer off the wrong words would otherwise pass.
export function shoutingWords(name: string): string[] {
  return tokens(name).filter((w) => shoutedLetters(w) > 0);
}

// Every Tall Man token in a name, in source order — "amLODIPine" out of
// "amLODIPine Besylate 5 MG tablet". Exported for the same reason as shoutingWords:
// the guard pins which token carried the verdict, not only the verdict.
export function tallManWords(name: string): string[] {
  return tokens(name).filter((w) => TALL_MAN_RE.test(w));
}

// Does this stored name read as the SOURCE DOCUMENT's label rather than as a name?
//
// True on the three shapes portals actually export — a shouted word, a dispensing
// label, or Tall Man lettering (see the rules above).
//
// False on every shape a person writes, INCLUDING the ones that are an abbreviation
// all the way through: "NAC", "DHEA", "TUDCA", "5-HTP", "EPA/DHA", "EPA DHA CLA",
// "MCT oil", "Vitamin D3 5000 IU", "Metformin HCl ER", "CoQ10".
//
// TRUE on an ALL-CAPS SUPPLEMENT — "FISH OIL", "MELATONIN", "CREATINE" — and that is
// the intended answer, not a leak. This predicate is only ever consulted for rows an
// IMPORT wrote (the scope gate in lib/queries/imports.ts), and in a portal document
// an all-caps rendering IS the document's register. Nobody's own typed supplement
// shelf reaches this function.
//
// THE DELIBERATE UNDER-MATCH: a short brand shouted on its own — "ASA 81 mg",
// "HCTZ 25 mg", "LASIX 40 mg" — stays quiet, because it is the same SHAPE as "DHEA
// 50 mg" and "TUDCA 500 mg" and no rule can separate them without a vocabulary of
// drug names. Missing an offer costs a person nothing; firing on their supplement
// shelf costs them every future offer. The same strings with a dose form on the end
// ("HCTZ 25 MG TAB") are caught by rule 2, which is how portals usually write them.
//
// A true answer is licence to OFFER a cleaner name, never to apply one.
export function isImportedDocumentName(name: string): boolean {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return false;
  if (tallManWords(trimmed).length > 0) return true;
  const shouted = tokens(trimmed)
    .map(shoutedLetters)
    .filter((n) => n > 0);
  if (shouted.some((n) => n >= SHOUTED_WORD_LETTERS)) return true;
  if (
    shouted.length >= MIN_SHOUTING_WORDS &&
    shouted.some((n) => n >= SHOUTED_ABBREVIATION_LETTERS)
  )
    return true;
  return (
    shouted.length >= MIN_SHOUTING_ABBREVIATIONS &&
    STRENGTH_DIGITS_RE.test(trimmed)
  );
}

// Is `candidate` a usable replacement for `current`? The offer exists to REPLACE a
// document string with a name, so a candidate that is empty, identical (bar casing
// and surrounding space), or itself a document string is not an improvement and is
// never offered. The last clause is what keeps the boundary honest: RxNorm returns
// product-level concepts, and some of them shout too.
export function isCleanerName(current: string, candidate: string): boolean {
  const next = (candidate ?? "").trim();
  if (!next) return false;
  if (next.toLowerCase() === (current ?? "").trim().toLowerCase()) return false;
  return !isImportedDocumentName(next);
}

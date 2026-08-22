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
const EDGE_PUNCT_RE = /^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g;

// A word must carry at least this many letters before its casing means anything. A
// one-letter token is a vitamin letter ("Vitamin D"), a strength suffix, or an
// initial — never a shout, and treating it as one would flag half the supplement
// shelf.
const MIN_SHOUT_LETTERS = 2;

// Two shouting words is the floor for "this is a document string". ONE is ordinary
// in a name somebody would write down: "Vitamin D3 5000 IU", "Metformin HCl ER",
// "EpiPen". Two or more is the portal's register, not a person's — and the floor is
// the reason the predicate does not need an allow-list of acronyms, which would be a
// second vocabulary to maintain beside the RxNorm one.
const MIN_SHOUTING_WORDS = 2;

// The one-word exception, and it is a share rather than a count: a single shouting
// word that is MOST of the name's letters means the drug's own name is shouted
// ("PREDNISONE 10 mg", "HCTZ 25 mg"), which is the other shape portals export. The
// share is measured in LETTERS, so the digits and units around it neither dilute nor
// inflate it.
const DOMINANT_SHOUT_SHARE = 0.5;

function letterCount(word: string): number {
  return (word.match(/[A-Za-z]/g) ?? []).length;
}

// Is this a shouted word? At least MIN_SHOUT_LETTERS letters, every one of them
// uppercase. Digits and punctuation inside the word are ignored, so "10MG" shouts on
// its "MG" and "B12" does not shout at all (one letter).
function shouts(word: string): boolean {
  const letters = word.match(/[A-Za-z]/g) ?? [];
  return (
    letters.length >= MIN_SHOUT_LETTERS &&
    letters.every((c) => c === c.toUpperCase())
  );
}

// Every shouted word in a name, in source order. Exported for the guard, which
// asserts on WHICH words a name shouts rather than only on the verdict — a predicate
// that reached the right answer off the wrong words would otherwise pass.
export function shoutingWords(name: string): string[] {
  return (name ?? "")
    .split(WORD_SPLIT_RE)
    .map((w) => w.replace(EDGE_PUNCT_RE, ""))
    .filter((w) => w.length > 0 && shouts(w));
}

// Does this stored name read as the SOURCE DOCUMENT's label rather than as a name?
//
// True on either shape portals actually export:
//   • two or more shouted words ("Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR)",
//     "LISINOPRIL 10MG TAB");
//   • one shouted word carrying most of the name's letters ("PREDNISONE 10 mg").
//
// False on every shape a person writes, including the ones that legitimately carry an
// acronym: "Vitamin D3 5000 IU", "Metformin HCl ER", "Tylenol (acetaminophen)",
// "penicillin v potassium", "CoQ10".
//
// A true answer is licence to OFFER a cleaner name, never to apply one.
export function isImportedDocumentName(name: string): boolean {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return false;
  const shouted = shoutingWords(trimmed);
  if (shouted.length >= MIN_SHOUTING_WORDS) return true;
  if (shouted.length === 0) return false;
  const total = letterCount(trimmed);
  if (total === 0) return false;
  return letterCount(shouted[0]) / total >= DOMINANT_SHOUT_SHARE;
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

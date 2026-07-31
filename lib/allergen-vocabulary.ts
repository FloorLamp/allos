// The ALLERGEN entry vocabulary (issue #1676) — the option source behind the
// allergy form's substance picker, and the write-time canonicalizer that keeps a
// recognized alias from being stored as a spelling the safety cross-checks can't
// see.
//
// WHY THIS EXISTS. Two curated datasets already describe allergens, and both are
// keyed on the SUBSTANCE STRING the user types:
//   • lib/datasets/drug-allergy.ts — five drug classes with full synonym lists. The
//     drug-allergy × medication cross-check (lib/drug-allergy.ts, #1029) resolves a
//     recorded allergen to a class by token-containment against those synonyms.
//   • lib/datasets/allergen-cross-reactivity.ts — eleven cross-reactivity families
//     with member names and aliases, behind lib/allergen-cross-reactivity.ts (#153).
// The substance field was a bare <input>, so a drifted spelling ("PCN", "soy")
// silently produced an allergy row that neither check could match. Offering the
// vocabulary at entry is the fix; canonicalizing a recognized alias on write is the
// belt.
//
// NO WIDENING (the #482 exclusion discipline). A drug SYNONYM canonicalizes to
// ITSELF, never to its class: someone who reacted to Amoxil is not thereby allergic
// to every penicillin, and rewriting "amoxil" as "penicillin-class antibiotics"
// would invent a broader claim than the user made. The class-level labels are
// offered as their OWN options for the (common) case where the record really is
// class-level — "penicillin allergy" — and each one token-contains its class's own
// synonym, so picking it resolves through the same matcher.
//
// Pure — no DB, no network. Safe to import from a client component (both datasets
// already are, via lib/icd10's precedent).

import { DRUG_ALLERGY_CLASSES } from "./datasets/drug-allergy";
import { CROSS_REACTIVITY_FAMILIES } from "./datasets/allergen-cross-reactivity";
import { allergenComparableForms } from "./allergen-cross-reactivity";

// Display form for a dataset term: the datasets store lowercase, an entry field
// shows a capitalized name. First character only — "cow's milk" → "Cow's milk",
// never a title-case pass that would mangle "penicillin v potassium".
function display(term: string): string {
  const t = term.trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

// The class labels are the one place the datasets spell an acronym properly
// ("NSAIDs (non-steroidal anti-inflammatory drugs)"), so a class SYNONYM that is
// that same acronym borrows the label's casing rather than being capitalize-first'd
// into "Nsaid". Derived from the dataset, never a second hand-written casing table:
// a label token only wins when it actually carries an uppercase letter.
const CASED_BY_FORM = new Map<string, string>();
for (const cls of DRUG_ALLERGY_CLASSES) {
  for (const token of cls.label.split(/\s+/)) {
    const word = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!word || !/[A-Z]/.test(word)) continue;
    for (const f of allergenComparableForms(word))
      if (!CASED_BY_FORM.has(f)) CASED_BY_FORM.set(f, word);
  }
}

function displayTerm(term: string): string {
  for (const f of allergenComparableForms(term)) {
    const cased = CASED_BY_FORM.get(f);
    if (cased) return cased;
  }
  return display(term);
}

interface VocabularyEntry {
  // The canonical display name — what a pick stores.
  name: string;
  // Hidden spellings that resolve to this entry (dataset aliases). The visible name
  // is always searchable on its own; these are extra.
  terms: string[];
}

// Build the ordered, form-deduplicated vocabulary. Order matters: an empty query
// keeps the source array's order and the picker shows eight rows, so the five
// class-level drug labels lead (the most commonly RECORDED allergy statements),
// then the cross-reactivity family members (foods, latex, pollens), then the
// individual drug names from the class synonym lists.
function buildVocabulary(): VocabularyEntry[] {
  const entries: VocabularyEntry[] = [];
  // Every comparable form already claimed, so "nsaid" and "nsaids" don't both
  // become options and "celery" isn't offered once per family it belongs to.
  const claimed = new Set<string>();

  const add = (name: string, terms: string[] = []): void => {
    const forms = allergenComparableForms(name);
    if (forms.size === 0) return;
    for (const f of forms) if (claimed.has(f)) return;
    for (const f of forms) claimed.add(f);
    entries.push({ name, terms });
  };

  for (const cls of DRUG_ALLERGY_CLASSES) add(display(cls.label));
  for (const family of CROSS_REACTIVITY_FAMILIES) {
    for (const member of family.members)
      add(display(member), [...(family.aliases?.[member] ?? [])]);
  }
  for (const cls of DRUG_ALLERGY_CLASSES) {
    for (const syn of cls.synonyms) add(displayTerm(syn));
  }
  return entries;
}

const VOCABULARY: VocabularyEntry[] = buildVocabulary();

// The picker's option list — canonical allergen names in vocabulary order.
export const ALLERGEN_OPTIONS: string[] = VOCABULARY.map((e) => e.name);

// Hidden search terms for an option, so a dataset alias finds its canonical member
// ("soy" → "Soybean") without the alias itself becoming a storable option.
const TERMS_BY_NAME = new Map<string, readonly string[]>(
  VOCABULARY.map((e) => [e.name, e.terms])
);

export function allergenSearchTerms(option: string): readonly string[] {
  return TERMS_BY_NAME.get(option) ?? [];
}

// Comparable form → canonical name. Built from every entry's own forms plus its
// alias forms; the first claimant wins, matching the option list's own dedup.
const CANONICAL_BY_FORM = new Map<string, string>();
for (const entry of VOCABULARY) {
  const all = new Set(allergenComparableForms(entry.name));
  for (const term of entry.terms)
    for (const f of allergenComparableForms(term)) all.add(f);
  for (const f of all)
    if (!CANONICAL_BY_FORM.has(f)) CANONICAL_BY_FORM.set(f, entry.name);
}

// The canonical spelling for a typed allergen, or null when the vocabulary doesn't
// recognize it. Case, punctuation, and a naive plural all fold (the SAME folding
// the cross-reactivity matcher uses), so "PEANUTS", "peanut", and "Peanut" all
// resolve to "Peanut" and the dataset alias "soy" resolves to "Soybean".
//
// null is not a rejection: the substance field keeps its free-text escape hatch, and
// an unrecognized allergen is stored exactly as the user wrote it.
export function canonicalAllergen(input: string): string | null {
  for (const form of allergenComparableForms(input)) {
    const hit = CANONICAL_BY_FORM.get(form);
    if (hit) return hit;
  }
  return null;
}

// The write-path helper: the canonical spelling when the vocabulary recognizes the
// input, else the user's own trimmed text. Used by the allergy Server Actions so a
// recognized alias is stored in the form the safety cross-checks match on.
export function normalizeAllergenSubstance(input: string): string {
  const raw = input.trim();
  return canonicalAllergen(raw) ?? raw;
}

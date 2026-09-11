// THE SHAPE OF A CLINICAL RECORD FORM'S SUMMARY ROW, shared by the thirteen (#5302).
//
// ── The design question #5302 left open, answered here ───────────────────────
//
// Each record form gets its OWN facts module — `condition-facts.ts`,
// `allergy-facts.ts`, and eleven more — rather than the thirteen sharing one keyed
// union. This file is what makes that affordable, and the split between the two is the
// whole answer: the VOCABULARY is per form, the SHAPE is shared.
//
// WHY NOT ONE UNION. `FORM_GRAMMAR`'s `facts` arm is `Record<K, FactRole>`, which
// demands a role for EVERY key of K. Over a shared union of roughly sixty keys, each of
// the thirteen entries would have to classify the fifty-odd facts it does not have —
// and, worse, a fact ADDED to one form would already be a known key there, so the one
// thing that arm exists to catch (a declaration going stale in the quiet direction)
// would stop working on the day the union got big. The `appointment` entry in
// `lib/form-grammar.ts` shows the cost at its smallest, carrying one borrowed key it
// never renders and saying so in a comment. Sharing also merges names that are not the
// same question: a condition's `severity` grades the problem, an allergy's grades one
// manifestation of it, and an immunization has none. One name, two meanings, is the
// parallel-concept failure wearing a tidier coat.
//
// The visit pair (`lib/visit-facts.ts`, one module behind an appointment and an
// encounter) stays the shape a shared module IS for: two forms stating the SAME facts
// about the same thing. That is a real equivalence; "these are all records" is not.
//
// WHAT THIRTEEN MODULES WOULD HAVE COST, and what this file removes instead. The
// duplication a per-form module threatened was never the key union — it was the
// boilerplate around it: a chip interface, a summary interface, a "state it or push it
// behind the more-line" loop, and a formatter for the trailing affordance's label, all
// four identical in every one of the eight modules that shipped before this one. Those
// live here now, once. A record form's own module is then only what is genuinely its
// own: its keys, its nouns, and how each fact reads.
//
// Pure: no React, no DB, no clock.

/** What the row does with a fact it cannot state. */
export type RecordFactState = "stated" | "missing";

/** One fact, as the row draws it. `K` is the form's own fact-key union. */
export interface RecordFactChip<K extends string> {
  key: K;
  /** The sentence this chip states. */
  label: string;
  state: RecordFactState;
  /**
   * The value was supplied FOR the person — seeded from a coded pick, say — rather
   * than stated by them (#846). An editable suggestion, and the chip has to say so.
   *
   * Absent when this surface does not track suggestion for that fact at all, which is
   * different from tracking it and finding it false (see FactChipRow's
   * `suggestedAttrs`).
   */
  suggested?: boolean;
}

export interface RecordFactSummary<K extends string> {
  /** The facts with something to state, plus any MISSING essential, in reading order. */
  chips: RecordFactChip<K>[];
  /**
   * The OPTIONAL facts with nothing to state, in reading order. They render no chip at
   * all and are reached through the one trailing affordance, which names them.
   */
  more: K[];
}

/**
 * What the trailing affordance says. Names the facts it holds, in row order — so
 * "more" never means "somewhere in here".
 *
 * Returns "" when nothing is absent; the affordance does not render at all then.
 */
export function moreRecordFactsLabel<K extends string>(
  more: readonly K[],
  nouns: Record<K, string>
): string {
  if (more.length === 0) return "";
  return `${more.map((k) => nouns[k]).join(", ")}…`;
}

/**
 * The accumulator every record form's summary is built with.
 *
 * `state` is the one decision the essential/optional split turns on and it is written
 * once here: a fact with a value states it, and an empty OPTIONAL goes behind the
 * trailing affordance instead of onto the row. An ESSENTIAL says `missing` explicitly,
 * because "what this row should prompt for" is the form's own judgement and not
 * something a helper should infer from emptiness.
 */
export function recordFactRow<K extends string>() {
  const chips: RecordFactChip<K>[] = [];
  const more: K[] = [];
  return {
    /** An optional fact: stated when it has a value, behind the more-line when not. */
    state(key: K, value: string, label: string): void {
      if (value.trim()) chips.push({ key, label, state: "stated" });
      else more.push(key);
    },
    /** A fact the row always states — see each form's argument for why. */
    stated(key: K, label: string, suggested?: boolean): void {
      chips.push({ key, label, state: "stated", suggested });
    },
    /** An essential with nothing to state: dashed, on the row, saying what to add. */
    missing(key: K, label: string): void {
      chips.push({ key, label, state: "missing" });
    },
    summary(): RecordFactSummary<K> {
      return { chips, more };
    },
  };
}

// Label composition of an intake item (issue #2856) — the pure half.
//
// A blend is one intake_items row, and until this table existed every engine that
// asked "what is IN this?" could only read the item's NAME. The workaround was to
// overload fields — the top ingredients in the name so the token matchers hit, the
// real product identity in `product`, the label's amounts in `notes` as free text no
// engine can read. `intake_item_ingredients` makes the composition a first-class
// child row, and this module owns the two pure jobs around it:
//
//   * the WRITE BOUNDARY — reading the label text a user typed into a canonical
//     (amount, unit) pair, with the text itself preserved verbatim; and
//   * DISPLAY — the "What's in this" line on the item card.
//
// The engines themselves are not here. They consume ingredient rows through their
// OWN existing vocabularies (lib/dri.ts NAME_MATCHERS for stack totals,
// lib/supplement-safety.ts tokenContains for the allergen/interaction belts,
// lib/drug-interactions.ts concepts, lib/intake-schedule.ts FAT_SOLUBLE for food
// timing) — one matcher each, given a wider input. A second vocabulary here would be
// the fork this issue exists to avoid.
//
// CONFIRM-NEVER-SILENT (#798). Nothing in this module writes. Catalog prefill and
// the parse below produce FORM STATE; the user's save is the write.

import type { IngredientUnit } from "./dri";

// One label ingredient of an intake item, as stored. `amount`/`unit` are the
// canonical reading PER SINGLE DOSE UNIT (one capsule/tablet/scoop) and are both
// null together when the label states no parseable quantity ("Proprietary blend").
// `amount_text` is what the bottle says, kept so the arithmetic stays checkable.
export interface IntakeItemIngredient {
  id: number;
  item_id: number;
  name: string;
  amount_text: string | null;
  amount: number | null;
  unit: IngredientUnit | null;
  sort: number;
}

// An ingredient as the form posts it and the catalog seeds it: a name plus the
// label's amount text. The canonical pair is DERIVED (parseIngredientAmount), never
// entered — so the person types what the bottle says and nothing else.
export interface IngredientDraft {
  name: string;
  amount_text: string;
}

// What a label's amount text says, read at the write boundary.
//
//   quantity   - a single, unambiguous number and unit.
//   none       - no digits at all ("Proprietary blend", "Organic mushroom complex"),
//                an ordinary label shape. The row still names a substance for the
//                interaction and allergen matchers; it just feeds no total.
//   unreadable - digits are there but they do not form one clean quantity. REFUSED at
//                the write boundary rather than guessed at.
export type IngredientAmountReading =
  | { kind: "quantity"; amount: number; unit: IngredientUnit }
  | { kind: "none" }
  | { kind: "unreadable" };

// THE PARSE IS WHOLE-STRING AND STRICT, AND THAT IS THE POINT (review of #2856).
//
// The first cut of this delegated to dri.parseQuantity, which scans for the first
// number+unit ANYWHERE in a string. Over a DOSE amount that is right and
// long-standing. Over a LABEL amount it was a fabrication engine, because a US
// Supplement Facts panel writes its thousands with a comma and the repeater tells the
// person to type the amount exactly as the label writes it:
//
//     "1,000 mg"  ->  the scan skipped "1," and matched "000 mg"  ->  0 mg
//     "5,000 IU"  ->  0 IU
//     "1,500 mg"  ->  500 mg
//     "2,5 g"     ->  5000 mg   (a European decimal comma, read ten times high)
//
// A niacin row reading "1,000 mg" - twenty-eight times the adult upper limit - was
// stored as a fully-formed, schema-valid ZERO and contributed to nothing. Both CHECK
// constraints passed: the reading was present, it was simply wrong. And a zero meaning
// "we could not read this" is indistinguishable from a zero meaning "none of this is
// in here", which is exactly the trust the UL layer cannot afford to lose.
//
// So the whole string must be one quantity, or it is not a number at all:
//   * grouped thousands separators are ACCEPTED, because real labels use them and the
//     grouping is what makes them unambiguous (digits in threes after the first group);
//   * a separator that is NOT unambiguously a thousands group is REFUSED rather than
//     guessed - reading "2,5 g" as 2.5 or as 25 is a coin flip on a safety number;
//   * anything else carrying digits but not forming exactly one quantity is refused
//     too: a range ("1-2 mg"), two quantities, a stray character.
//
// THE PERIOD IS THE SAME COIN FLIP AS THE COMMA, and the first fix only caught one of
// them (second review of #2856). Refusing "2,5 g" concedes that labels using European
// numeric conventions reach this field - and on such a label the roles are swapped, so
// the period is the thousands separator:
//
//     "10.000 IU"  ->  ten thousand IU on a European vitamin D label, read as 10 IU:
//                      a THOUSANDFOLD low, and every warning it should raise is gone
//     "1.000 mg"   ->  1 mg
//     "2.500 mg"   ->  2.5 mg
//
// Resolving one convention's ambiguity by refusal while silently resolving the other's
// to the US reading is the inconsistency, so the same rule now applies to both: a
// period preceded by one to three digits and followed by EXACTLY three is ambiguous
// and refused. That leaves every unambiguous decimal alone - "0.5 g", "2.5 g",
// "1.25 mg", "1.0 mg" all still read - because a genuine decimal fraction that happens
// to be exactly three places on a one-to-three digit number is the only case that
// collides, and on that case nobody can tell which was meant.
//
// A comma group already present settles it: in "1,000.500 mg" the comma has named the
// thousands separator, so the period is a decimal and the value reads.
//
// Refusal surfaces as an error on the form naming the offending string (see
// normalizeIngredientDrafts), so the person corrects their own label text. Nothing is
// stored, nothing is silently dropped, and no number is invented.
const AMOUNT_RE =
  /^(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(mcg|\u00b5g|ug|mg|g|iu)$/i;

// A bare number whose period sits exactly where a thousands separator would: one to
// three digits, a period, exactly three digits, and nothing else. Deliberately NOT
// applied to a value that already carries a comma group, which has settled the
// question in the other direction.
const AMBIGUOUS_PERIOD_GROUPING = /^\d{1,3}\.\d{3}$/;

// Mass converts to milligrams or micrograms: grams fold to mg at the boundary
// (canonical-units-at-the-write-boundary), mcg stays mcg so a 100 mcg label does not
// become 0.1 mg on the way in.
//
// INTERNATIONAL UNITS DO NOT CONVERT HERE, on purpose. An IU is defined per
// SUBSTANCE - 1 IU of vitamin D is 0.025 mcg and 1 IU of vitamin E is something else
// entirely - so turning it into mass requires knowing which nutrient this is, which is
// the matchers' question, not the write boundary's. The value is kept as stated with
// unit 'iu' and converted per-nutrient downstream by the SAME dri.toNutrientUnit the
// dose-amount path already uses.
export function readIngredientAmount(
  text: string | null
): IngredientAmountReading {
  const raw = (text ?? "").trim();
  if (!raw) return { kind: "none" };
  const m = raw.match(AMOUNT_RE);
  if (!m) {
    // No digits at all is a label stating no quantity - legitimate, and a different
    // thing from a quantity we could not read.
    return /\d/.test(raw) ? { kind: "unreadable" } : { kind: "none" };
  }
  if (AMBIGUOUS_PERIOD_GROUPING.test(m[1])) return { kind: "unreadable" };
  const value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return { kind: "unreadable" };
  const u = m[2].toLowerCase();
  if (u === "g") return { kind: "quantity", amount: value * 1000, unit: "mg" };
  const unit = u === "\u00b5g" || u === "ug" ? "mcg" : u;
  return { kind: "quantity", amount: value, unit: unit as IngredientUnit };
}

// One stored ingredient row, before it has an id.
export interface IngredientWrite {
  name: string;
  amount_text: string | null;
  amount: number | null;
  unit: IngredientUnit | null;
}

// The write path's answer for a posted repeater: the rows to store, or the ONE row
// whose amount could not be read.
export type IngredientDraftResult =
  | { ok: true; rows: IngredientWrite[] }
  | { ok: false; name: string; amountText: string };

// Normalize the posted repeater rows into what the write path stores: trimmed names,
// blank rows dropped (an empty repeater row is a person mid-thought, not a claim), the
// amount text preserved as typed, and the canonical pair derived.
//
// A row with a name and no amount is KEPT: "this blend contains St. John's Wort" is
// the whole point of the interaction belt even when the label hides the milligrams
// inside a proprietary blend. A row with an amount and no name is dropped - an amount
// of nothing names no substance and no engine could read it.
//
// An amount carrying digits that is not one clean quantity STOPS THE SAVE (see
// readIngredientAmount): the person is told which string could not be read and fixes
// it. The alternative - storing null and moving on - would read as "this ingredient
// has no stated amount" and would drop a real upper-limit contribution as quietly as
// the zero it replaced.
export function normalizeIngredientDrafts(
  rows: readonly IngredientDraft[]
): IngredientDraftResult {
  const out: IngredientWrite[] = [];
  for (const row of rows) {
    const name = (row.name ?? "").trim();
    if (!name) continue;
    const text = (row.amount_text ?? "").trim();
    const reading = readIngredientAmount(text || null);
    if (reading.kind === "unreadable") {
      return { ok: false, name, amountText: text };
    }
    out.push({
      name,
      amount_text: text || null,
      amount: reading.kind === "quantity" ? reading.amount : null,
      unit: reading.kind === "quantity" ? reading.unit : null,
    });
  }
  return { ok: true, rows: out };
}

// The message the form shows when a label amount could not be read. Names the exact
// string so the person can see which row to fix, and shows the shapes that work.
export function unreadableAmountMessage(
  name: string,
  amountText: string
): string {
  return (
    `Couldn't read \u201c${amountText}\u201d as the amount of ${name}. ` +
    `Use one number and a unit \u2014 like 250 mg, 1,000 mg, 400 mcg or 5000 IU \u2014 ` +
    `or leave the amount blank if the label doesn't give one.`
  );
}

// Read the `ingredients_json` an intake item carries (lib/queries/intake/schedule.ts)
// into rows. NULL — the case for nearly every item, which has no composition — parses
// to nothing without touching JSON.parse at all, which is what keeps the fold onto the
// hottest read in the app free.
//
// Defensive only against a malformed blob, never against a shape: the JSON is produced
// by our own json_object() projection of our own columns, so a parse failure would mean
// the database handed back something impossible. Degrading to "this item has no stated
// composition" is the same reading a proprietary blend gets, and the alternative —
// throwing inside the item read — would take down every intake surface for one bad row.
export function parseItemIngredients(
  json: string | null | undefined
): IntakeItemIngredient[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as IntakeItemIngredient[]) : [];
  } catch {
    return [];
  }
}

// The ingredient NAMES of an item, for the token matchers. Deliberately just the
// names: the belts ask "does this item carry substance X", which is a question about
// identity, never about how much.
export function ingredientNames(rows: readonly { name: string }[]): string[] {
  return rows.map((r) => r.name.trim()).filter((n) => n.length > 0);
}

// One ingredient's display line: the label's own words where we have them, so the
// card shows what the bottle shows. Falls back to the canonical pair when a row
// somehow has one without the text (an older row, or a seed), and to the bare name
// when the label states no amount.
export function ingredientLine(row: {
  name: string;
  amount_text: string | null;
  amount: number | null;
  unit: IngredientUnit | null;
}): string {
  if (row.amount_text) return `${row.name} ${row.amount_text}`;
  if (row.amount != null && row.unit) {
    return `${row.name} ${row.amount} ${row.unit === "iu" ? "IU" : row.unit}`;
  }
  return row.name;
}

// The "What's in this" summary line for the item card.
export function ingredientSummary(
  rows: readonly {
    name: string;
    amount_text: string | null;
    amount: number | null;
    unit: IngredientUnit | null;
  }[]
): string {
  return rows.map(ingredientLine).join(" · ");
}

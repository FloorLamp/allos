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

import { parseQuantity, type IngredientUnit } from "./dri";

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

// The canonical reading of a label amount, per single dose unit.
//
// Mass converts to milligrams or micrograms: grams fold to mg at the boundary
// (canonical-units-at-the-write-boundary), mcg stays mcg so a 100 mcg label does not
// become 0.1 mg on the way in.
//
// INTERNATIONAL UNITS DO NOT CONVERT HERE, on purpose. An IU is defined per
// SUBSTANCE — 1 IU of vitamin D is 0.025 mcg and 1 IU of vitamin E is something else
// entirely — so turning it into mass requires knowing which nutrient this is, which
// is the matchers' question, not the write boundary's. The value is kept as stated
// with unit 'iu' and converted per-nutrient downstream by the SAME dri.toNutrientUnit
// the dose-amount path already uses.
//
// Returns null when the text carries no quantity at all, which is an ordinary label
// shape ("Proprietary blend", "Organic mushroom complex") and must stay null rather
// than becoming a fabricated zero.
export function parseIngredientAmount(
  text: string | null
): { amount: number; unit: IngredientUnit } | null {
  const q = parseQuantity(text);
  if (!q) return null;
  if (q.unit === "g") return { amount: q.value * 1000, unit: "mg" };
  return { amount: q.value, unit: q.unit };
}

// Normalize the posted repeater rows into what the write path stores: trimmed names,
// blank rows dropped (an empty repeater row is a person mid-thought, not a claim),
// the amount text preserved as typed, and the canonical pair derived.
//
// A row with a name and no amount is KEPT: "this blend contains St. John's Wort" is
// the whole point of the interaction belt even when the label hides the milligrams
// inside a proprietary blend. A row with an amount and no name is dropped — an amount
// of nothing names no substance and no engine could read it.
export function normalizeIngredientDrafts(
  rows: readonly IngredientDraft[]
): {
  name: string;
  amount_text: string | null;
  amount: number | null;
  unit: IngredientUnit | null;
}[] {
  const out: {
    name: string;
    amount_text: string | null;
    amount: number | null;
    unit: IngredientUnit | null;
  }[] = [];
  for (const row of rows) {
    const name = (row.name ?? "").trim();
    if (!name) continue;
    const text = (row.amount_text ?? "").trim();
    const parsed = parseIngredientAmount(text || null);
    out.push({
      name,
      amount_text: text || null,
      amount: parsed?.amount ?? null,
      unit: parsed?.unit ?? null,
    });
  }
  return out;
}

// The ingredient NAMES of an item, for the token matchers. Deliberately just the
// names: the belts ask "does this item carry substance X", which is a question about
// identity, never about how much.
export function ingredientNames(
  rows: readonly { name: string }[]
): string[] {
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

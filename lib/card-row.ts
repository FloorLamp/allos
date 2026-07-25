// Pure placement/label logic for the responsive card presentation of a table row
// (issue #1426).
//
// Below `sm` the app's wide tables stop being tables: `components/ResponsiveTable`
// re-lays the SAME row DOM as a stacked card (see the `.table-cards` block in
// app/globals.css). There is no second row model and no second content tree — a
// cell declares ONCE, where it is authored, which part of the card it becomes, and
// CSS does the rest. This module is the pure half of that contract: which slot a
// cell claims, and which attributes survive onto a card's compact meta line.
//
// Kept DB-free and React-free so it unit-tests in the pure tier.

// Where a cell lands in the card presentation. A cell with NO slot is dropped from
// the card entirely — the deliberate "this column is desktop-only detail" choice.
//   title   — the row's identity (biomarker name, session date). One per row.
//   value   — the headline number/state, rendered prominently under the title.
//   meta    — a secondary attribute; all of them flow into one wrapped meta line.
//   actions — the row's kebab/controls, pinned to the card's top-right corner.
//   full    — a full-width cell that replaces the card body (an inline edit form).
export type CardSlot = "title" | "value" | "meta" | "actions" | "full";

// The attributes a `<td>` carries so the card CSS can place it. Rendered by
// `Td` in components/ResponsiveTable.tsx; kept here so the "empty cells vanish
// from the card" rule is pinned by a pure test rather than by eyeballing CSS.
//
// `empty` is the caller's own emptiness verdict for the cell (no panel, no notes,
// a bare "—" placeholder). An empty cell keeps rendering in the TABLE — the column
// grid needs its placeholder — but claims no slot, so the card simply doesn't show
// it. That is the whole "show the attributes that DIFFER" discipline (#531–#534)
// at cell granularity: a card never carries a row of em-dashes that distinguish
// nothing.
export function cardCellAttrs(opts: { slot?: CardSlot; empty?: boolean }): {
  "data-card"?: CardSlot;
} {
  if (!opts.slot) return {};
  // A title/actions/full cell is structural — it holds its slot even when the
  // caller believes it's empty (a group-continuation row's blank name cell still
  // anchors the card's grid). Only the optional slots drop out.
  if (opts.empty && (opts.slot === "meta" || opts.slot === "value")) return {};
  return { "data-card": opts.slot };
}

// One labeled attribute destined for a card's meta line. `index` is its position in
// the caller's column list, so a caller rendering cells positionally (the analyze
// table maps over `session.cells`) can ask "did column i survive?" without matching
// on the label — two columns are allowed to share a label, indices never collide.
export interface CardMetaEntry {
  index: number;
  label: string;
  value: string;
}

// Values that carry no information: an empty/whitespace string, or one of the
// placeholder dashes the tables render to keep a column grid aligned.
const PLACEHOLDERS = new Set(["", "-", "–", "—", "--"]);

function informative(value: string | null | undefined): boolean {
  return !PLACEHOLDERS.has((value ?? "").trim());
}

// Which attributes make a card's compact meta line, given the row's already
// formatted cells. This is the #531–#534 discipline applied to a card: label by
// what DIFFERS, and never spend a phone's scarce line budget on an attribute that
// distinguishes nothing.
//
// Rules, in order:
//   1. drop placeholder/empty values (nothing to say);
//   2. drop a value that merely repeats the card's title — the title already says
//      it, so as a meta attribute it distinguishes nothing (compared trimmed and
//      case-insensitively);
//   3. drop a later duplicate of a value already on the line, keeping the FIRST
//      label — two columns agreeing is not two facts.
// Order is otherwise preserved, so the caller's column order is the meta order.
//
// `labels` and `values` are zipped positionally (the analyze table's
// `view.columns` × `session.cells` shape); extra values with no label are ignored.
export function cardMetaEntries(
  labels: readonly string[],
  values: readonly (string | null | undefined)[],
  opts: { title?: string | null } = {}
): CardMetaEntry[] {
  const title = (opts.title ?? "").trim().toLowerCase();
  const seen = new Set<string>();
  const out: CardMetaEntry[] = [];
  for (let i = 0; i < labels.length; i++) {
    const raw = values[i];
    if (!informative(raw)) continue;
    const value = String(raw).trim();
    const key = value.toLowerCase();
    if (title && key === title) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ index: i, label: labels[i], value });
  }
  return out;
}

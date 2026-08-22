// Pure placement/label logic for the responsive card presentation of a table row
// (issue #1426).
//
// Below `sm` — the boundary is CARD_MODE_BREAKPOINT_PX below, and #3457 is why it
// is stated here rather than restated per consumer — the app's wide tables stop
// being tables: `components/ResponsiveTable`
// re-lays the SAME row DOM as a stacked card (see the `.table-cards` block in
// app/globals.css). There is no second row model and no second content tree — a
// cell declares ONCE, where it is authored, which part of the card it becomes, and
// CSS does the rest. This module is the pure half of that contract: which slot a
// cell claims, and which attributes survive onto a card's compact meta line.
//
// Kept DB-free and React-free so it unit-tests in the pure tier.

// ── THE CARD-MODE BOUNDARY, DECLARED ONCE (issue #3457) ─────────────────────
//
// Card mode starts BELOW `sm` (640px), not below `md`. Every requirement, AC,
// component and spec that needs the number reads it from here instead of
// restating a breakpoint of its own — that restating is what #3457 was filed
// about: `table-cards` did its work in `max-sm:` while the mobile-native
// campaign wrote its requirements in `md`, so between 640px and 768px a surface
// a requirement called cards rendered as a sort-header table and nothing looked
// wrong at the widths anyone tested (390px and 430px, where the two agree).
//
// IT IS `sm`, AND THAT WAS THE DECISION RATHER THAN THE DEFAULT. The 640–768px
// band is not an accident to be tidied away — it is a designed middle tier. The
// record lists ladder their columns in THREE steps, not two: a base set at every
// width, a second set from `sm` (`hidden sm:table-cell`), a third from `md`
// (`hidden md:table-cell`). The `sm` tier exists ONLY to give 640–768px a
// narrower table than the desktop one, and moving card mode to `max-md:` would
// make every one of those declarations inert — `.table-cards td[data-card]`
// (0,2,1) outranks the `.hidden` utility (0,1,0), so the cell would render as a
// card pair in that band and the column tier would never be read again.
// Re-derived 2026-08-22: 27 `sm:table-cell` declarations across 12 files.
//
// It also agrees with every other phone primitive in the tree, which are all
// `sm`-keyed: the #3466 density conventions (`max-sm:` throughout), the phone
// reading order in lib/phone-fold.ts ("EVERY slot resets at `sm`"), this
// module's own card-cell labels, and the card-mode sort select.
//
// The CSS half of the boundary is the `@utility table-cards` block in
// app/globals.css; `lib/__tests__/card-mode-boundary.test.ts` holds the two
// halves to the same number, and `e2e/card-mode-boundary.spec.ts` measures what
// actually renders either side of it.

// The narrowest viewport that renders a `.table-cards` table AS A TABLE. Card
// mode is `width < CARD_MODE_BREAKPOINT_PX`; this is Tailwind's `sm` (40rem),
// which `max-sm:` compiles to as `@media (width < 40rem)`.
export const CARD_MODE_BREAKPOINT_PX = 640;

// The class that says "this markup exists only in card mode" — a `<th>`'s label
// reprinted inside its own cell, the sort select that stands in for the hidden
// header strip. Written once here so a consumer inherits the boundary rather
// than spelling `sm:` again (#3457).
export const CARD_MODE_ONLY = "sm:hidden";

// A ROW THAT STACKS IN CARD MODE (issue #3491).
//
// The other half of the same boundary, for a surface that is not a table: a flex
// line carrying lead text beside a `shrink-0` action pair. Above the boundary it is
// one line and the text truncates into whatever the actions leave; below it the
// text claims the whole line, the actions wrap beneath, and the text stops
// truncating because it no longer has to fit beside anything.
//
// #3491 is what this is for. Data → Trash rendered exactly that shape, and at
// 390px the two buttons ("Restore", "Delete permanently") left the headline about
// 120px — so `truncate` ate the only fact that distinguishes one untitled capture
// from another, and an activity read "activity · 2026-0…". The layout was
// discarding a working identity model.
//
// SPELLED HERE, NOT AT THE CONSUMER, for the reason CARD_MODE_ONLY is (#3457):
// Tailwind's scanner reads source as text, so the variant has to appear as a
// literal somewhere — and the right somewhere is the module that DECLARES the
// boundary. `lib/__tests__/card-mode-boundary.test.ts` derives both spellings from
// CARD_MODE_BREAKPOINT_PX, so moving the boundary moves these with it.
export const CARD_MODE_ROW_STACK = {
  /**
   * On the TEXT BLOCK of such a row: claim the whole flex line below the
   * boundary, which is what pushes the next flex child onto its own row. The
   * parent needs `flex-wrap` for the wrap to happen at all.
   */
  text: "max-sm:basis-full",
  /**
   * On a `truncate`d LEAD LINE inside that block: stop clipping once the line is
   * full-width. `truncate` is `overflow-hidden text-ellipsis whitespace-nowrap`,
   * and normal whitespace is the half that matters — with wrapping restored the
   * block's height grows to fit, so nothing is clipped and the ellipsis rule has
   * nothing to do.
   */
  lead: "max-sm:whitespace-normal",
} as const;

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

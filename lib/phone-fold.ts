// The phone-fold CAPS (issue #1578). Pure — no DB, no React.
//
// Results › Biomarkers is an index, and the confirmed #1499 design put its first
// panel header inside the first viewport-height on a phone. The grouping got the
// list there; the two cards above it did not, because both render one full-width
// element per item at 390px with no ceiling — the starred lens grows with every star
// the reader adds, and the bio-age hero always lists nine inputs. So the caps live
// here, next to each other and named, rather than as loose numbers in two components:
// they answer ONE question ("how much of this card does a phone show before the
// fold?") and they are the numbers a mobile spec asserts against.
//
// Only the PHONE rendering is capped. From `sm` up both cards render every item, as
// they always have — see components/PhoneFold.

// Starred tiles shown before the fold. Three fills the first row of the `lg` grid
// exactly, so the number is not an arbitrary phone-only invention, and it keeps the
// card's phone height near a quarter of the viewport whatever a reader has starred.
export const PHONE_STARRED_TILE_CAP = 3;

// ---------------------------------------------------------------------------
// The phone READING ORDER of Results › Biomarkers (issue #1647).
//
// #1646 capped the two tallest cards and measured the result: the first panel header
// moved from 2651px to 1912px at 390×844 — a real lift, and still 2.3 viewports down.
// The arithmetic says caps alone cannot close it. Even after the caps the starred card
// is 579px and the bio-age hero 435px, so those two ALONE are 1014px on an 844px
// screen; zeroing everything else still leaves the index below the fold. Reaching the
// stated goal means the index has to come FIRST on a phone, not merely be preceded by
// smaller cards.
//
// So below `sm` the slots are re-ordered, and only below `sm`:
//
//   1 warning  — Trajectory watch. A card that says an analyte is heading somewhere
//                BEFORE a reading crosses a line keeps its place above the index; a
//                warning that has to be scrolled for is a weaker warning. Its rows
//                fold (PhoneFold) so what stays is the headline that carries the
//                signal — how many analytes, and which.
//   2 index    — the filter bar and the panel-group table. The reason the tab exists
//                (#1499/#1581): a panel index whose first entry a phone reader cannot
//                see is not an index.
//   3 glance   — the starred lens and the bio-age hero. Both are surfaces the reader
//                goes TO, not ones that must find the reader, and both are still fully
//                rendered — a scroll away, not behind a tap.
//   4 entry    — "+ Add result", last as it already is.
//
// ONE CONTENT TREE (AGENTS.md responsive-surface rule). This is CSS `order` on a flex
// column, the same mechanism DateRangeControl and StrengthSets already use for
// responsive re-ordering: every card is authored once, rendered once, at every width.
// There is no phone copy of any card and nothing is hidden — a phone reader reaches
// the same content by scrolling.
//
// EVERY slot resets at `sm`. From 640px up all four are `order: 0`, so the flex
// container falls back to DOM order — which is the unchanged #1499 section D order
// (starred, trajectory, bio-age, then the index). Desktop renders exactly as before,
// and phone-stack.test.ts holds that reset as an invariant so a fifth slot cannot be
// added without it.
//
// `min-w-0` on every slot: a flex item defaults to `min-width: auto`, which would let
// the wide biomarkers table push the column past the viewport instead of scrolling
// inside its own `overflow-auto` frame.
//
// NO `gap-*` on the container, deliberately. Each card carries its own `mb-6`, and
// three of these slots render NOTHING for some profiles (no stars, no firing
// trajectory, a child profile's hidden hero). A flex gap would draw the space anyway
// and leave a phantom band where an empty card used to be; a margin on a zero-height
// wrapper draws nothing.
export const PHONE_STACK = {
  container: "flex min-w-0 flex-col",
  warning: "order-1 min-w-0 sm:order-none",
  index: "order-2 min-w-0 sm:order-none",
  glance: "order-3 min-w-0 sm:order-none",
  entry: "order-4 min-w-0 sm:order-none",
} as const;

// Split a list at a cap into the part shown before a phone fold and the part behind
// it. `folded` is empty when the list already fits, which is the signal a caller uses
// to skip the toggle entirely (a control that reveals nothing is noise).
export function splitAtPhoneCap<T>(
  items: readonly T[],
  cap: number
): { shown: T[]; folded: T[] } {
  if (items.length <= cap) return { shown: [...items], folded: [] };
  return { shown: items.slice(0, cap), folded: items.slice(cap) };
}

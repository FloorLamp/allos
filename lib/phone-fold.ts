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

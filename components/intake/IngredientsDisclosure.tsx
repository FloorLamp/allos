import {
  ingredientLine,
  type IntakeItemIngredient,
} from "@/lib/intake-ingredients";
import Disclosure from "@/components/Disclosure";

// "What's in this" (#2856): an item's label composition, closed by default.
//
// ONE renderer for BOTH kinds (#3161). `intake_item_ingredients` is a child of
// `intake_items`, and the engines that read it — the interaction detector above all —
// are deliberately kind-blind, but the display was on the supplement row only. A
// combination OTC product tracked as a medication (an antihistamine plus a
// decongestant, a cold-and-flu sachet) is exactly the shape #2856 is about, and its
// composition was invisible on the surface that shows that item.
//
// Closed by default on both: most items have none, and a blend's label is a lot of
// words for a row. Renders nothing at all when there is no composition, so a caller
// can mount it unconditionally.
export default function IngredientsDisclosure({
  rows,
  testId,
  className = "mt-0.5",
}: {
  rows: readonly IntakeItemIngredient[];
  testId: string;
  className?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <Disclosure className={className} data-testid={testId}>
      <summary className="fold-control text-xs text-slate-500 dark:text-slate-400">
        What&apos;s in this ({rows.length})
      </summary>
      <ul className="mt-1 space-y-0.5 border-l-2 border-black/10 pl-3 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
        {rows.map((g) => (
          <li key={g.id}>{ingredientLine(g)}</li>
        ))}
      </ul>
    </Disclosure>
  );
}

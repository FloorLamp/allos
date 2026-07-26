import type { ReactNode } from "react";

// The "Today's nutrients" container (issue #980 item 2): ONE card holding a compact gauge
// ROW per nutrient — Protein and Fiber — instead of a card each. Growth is a row, never
// another card: a third nutrient slots in as another child with no layout change. Purely
// presentational; each row (ProteinAdequacyCard / FiberAdequacyCard, now row-shaped) brings
// its own gauge, caption, and status accent, and the card just stacks them.

export default function NutrientsCard({
  children,
  embedded = false,
  details,
  title = "Today",
  headingLevel = 2,
}: {
  children: ReactNode;
  embedded?: boolean;
  details?: ReactNode;
  title?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <div data-testid="nutrients-card" className={embedded ? undefined : "card"}>
      <Heading className="mb-4 section-label">{title}</Heading>
      <div className="space-y-5">{children}</div>
      <details className="group mt-5 border-t border-black/5 pt-3 text-xs text-slate-500 dark:border-white/5 dark:text-slate-400">
        <summary className="cursor-pointer font-medium text-slate-600 dark:text-slate-300">
          How estimates work
        </summary>
        <p className="mt-2 leading-relaxed">
          Estimates combine logged food-group servings, directly logged protein,
          and confirmed supplements. Incomplete tracking produces a minimum, not
          a complete intake total.
        </p>
        {details && <div className="mt-3 space-y-3">{details}</div>}
      </details>
    </div>
  );
}

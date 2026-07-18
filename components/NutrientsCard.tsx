import type { ReactNode } from "react";

// The "Today's nutrients" container (issue #980 item 2): ONE card holding a compact gauge
// ROW per nutrient — Protein and Fiber — instead of a card each. Growth is a row, never
// another card: a third nutrient slots in as another child with no layout change. Purely
// presentational; each row (ProteinAdequacyCard / FiberAdequacyCard, now row-shaped) brings
// its own gauge, caption, and status accent, and the card just stacks them.

export default function NutrientsCard({ children }: { children: ReactNode }) {
  return (
    <div data-testid="nutrients-card" className="card">
      <h2 className="mb-4 font-semibold text-slate-800 dark:text-slate-100">
        Today&rsquo;s nutrients
      </h2>
      <div className="space-y-5">{children}</div>
    </div>
  );
}

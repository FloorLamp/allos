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
      <details className="group mt-5 border-t border-black/5 pt-3 text-xs text-slate-500 dark:border-white/5 dark:text-slate-400">
        <summary className="cursor-pointer font-medium text-slate-600 dark:text-slate-300">
          How estimates work
        </summary>
        <p className="mt-2 leading-relaxed">
          Estimates combine logged food-group servings, directly logged protein,
          and confirmed supplements. When not everything is tracked, the result
          is a minimum rather than a complete intake total. Informational, not
          medical or dietary advice.
        </p>
      </details>
    </div>
  );
}

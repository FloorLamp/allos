"use client";

import { useEffect, useState } from "react";

// Sticky chart-jump chips for the Trends → Body tab (#1067 Phase 1) — the #1042
// jump-link pattern (ProfileAnchorNav) applied to the Body tab's chart stack.
//
// One horizontal row of chips under the tab strip; tapping one scrolls to that
// chart via a plain `#id` in-page anchor (works without JS). The row is its OWN
// `overflow-x-auto` container so a long chip list never clips or page-widens
// (#1063), and it sticks below the mobile header (top-14) / at the top on desktop
// while you scroll. An IntersectionObserver highlights the chart currently in
// view. The caller passes ONLY present charts (the same visible list that renders
// the cards), so a chip can never point at an absent chart.

export interface ChartChip {
  id: string;
  label: string;
}

export default function ChartJumpChips({ chips }: { chips: ChartChip[] }) {
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const els = chips
      .map((c) => document.getElementById(c.id))
      .filter((e): e is HTMLElement => e != null);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-15% 0px -75% 0px" }
    );
    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  }, [chips]);

  if (chips.length === 0) return null;

  return (
    <nav
      aria-label="Jump to chart"
      data-testid="chart-jump-chips"
      className="sticky top-14 z-20 -mx-1 flex gap-2 overflow-x-auto bg-white/90 px-1 py-2 backdrop-blur md:top-0 dark:bg-ink-950/90"
    >
      {chips.map((c) => (
        <a
          key={c.id}
          href={`#${c.id}`}
          data-testid={`chart-jump-${c.id}`}
          className={`shrink-0 rounded-full border px-3 py-1 text-sm font-medium transition ${
            active === c.id
              ? "border-brand-500 bg-brand-600 text-white"
              : "border-black/10 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          }`}
        >
          {c.label}
        </a>
      ))}
    </nav>
  );
}

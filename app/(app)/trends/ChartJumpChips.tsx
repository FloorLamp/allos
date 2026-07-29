"use client";

import { useEffect, useState } from "react";

// Sticky jump chips — the #1042 anchor-nav pattern (ProfileAnchorNav), introduced
// for the Body tab's chart stack (#1067 Phase 1) and PROMOTED by #1644 to be the
// merged Trends page's primary navigation, in the slot the tab strip used to hold.
//
// One horizontal row of chips; tapping one scrolls to that target via a plain `#id`
// in-page anchor (works without JS, and works before the target has streamed in).
// The row is its OWN `overflow-x-auto` container so a long chip list never clips or
// page-widens (#1063), and it sticks below the mobile header (top-14) / at the top
// on desktop while you scroll — which is what keeps one long scrollable page
// navigable on a phone. An IntersectionObserver highlights the target currently in
// view. The caller passes ONLY present targets (the same visible list that renders
// the content), so a chip can never point at something absent.
//
// STREAMING (#1644). The page's census sections arrive through Suspense AFTER
// hydration, so the elements a chip points at may not exist when this mounts. The
// observer therefore attaches what it finds and keeps a MutationObserver open until
// every target has appeared — otherwise the chips for the streamed sections would
// never light up.

export interface ChartChip {
  id: string;
  label: string;
}

export default function ChartJumpChips({
  chips,
  ariaLabel = "Jump to chart",
  testId = "chart-jump-chips",
}: {
  chips: ChartChip[];
  ariaLabel?: string;
  testId?: string;
}) {
  const [active, setActive] = useState<string>("");
  // The chip list is a fresh array on every render of the server payload; key the
  // effect on its CONTENT so a re-render doesn't tear down a working observer.
  const chipKey = chips.map((c) => c.id).join(",");

  useEffect(() => {
    const ids = chipKey ? chipKey.split(",") : [];
    if (ids.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-15% 0px -75% 0px" }
    );
    const attached = new Set<string>();
    const attach = (): boolean => {
      for (const id of ids) {
        if (attached.has(id)) continue;
        const el = document.getElementById(id);
        if (el) {
          attached.add(id);
          observer.observe(el);
        }
      }
      return attached.size === ids.length;
    };
    if (attach()) return () => observer.disconnect();
    // Some targets are still streaming: watch for them, then stop watching.
    const mutations = new MutationObserver(() => {
      if (attach()) mutations.disconnect();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    return () => {
      mutations.disconnect();
      observer.disconnect();
    };
  }, [chipKey]);

  if (chips.length === 0) return null;

  return (
    <nav
      aria-label={ariaLabel}
      data-testid={testId}
      className="sticky top-14 z-20 -mx-1 flex gap-2 overflow-x-auto bg-white/90 px-1 py-2 backdrop-blur md:top-0 dark:bg-ink-950/90"
    >
      {chips.map((c) => (
        <a
          key={c.id}
          href={`#${c.id}`}
          data-testid={`chart-jump-${c.id}`}
          data-active={active === c.id ? "true" : "false"}
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

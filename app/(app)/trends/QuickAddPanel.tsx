"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

// Collapsible quick-add panel for the Trends → Body tab (#1067 Phase 1).
//
// The Body tab is a READING surface, but on mobile you had to scroll past three
// full entry forms (Body / Vitals / Growth) before the first chart. This wraps
// those forms so that on MOBILE they collapse to a one-row "+ Log …" chip strip
// (tap a chip to expand its form inline), while DESKTOP keeps the inline forms
// exactly as before.
//
// Responsive-surfaces rule (CLAUDE.md): each form is authored ONCE (the shared
// content) and rendered a single time here — never hand-mirrored into a
// `hidden md:*` / `md:hidden` pair that could drift. Only the wrapper's
// visibility class differs by viewport: collapsed on mobile until its chip
// expands it, always shown on desktop (`md:block`). The chip strip is a
// mobile-only affordance (`md:hidden`) and its OWN `overflow-x-auto` container so
// it can never page-widen (#1063).
//
// Deep-link preservation (#1083 / #29): a form can carry a mount effect that
// scrolls itself into view and focuses a field (VitalsQuickAdd on
// `focus=blood-pressure`, BodyQuickAdd on `new=weight|vitals`). Those effects are
// no-ops against a `display:none` element, so the matching form starts EXPANDED
// when its deep-link param is present — the focus lands on mobile too.

export interface QuickAddItem {
  // Matches the deep-link key so the right form auto-expands (see below).
  id: "body" | "vitals" | "growth";
  label: string;
  node: ReactNode;
}

export default function QuickAddPanel({ items }: { items: QuickAddItem[] }) {
  const params = useSearchParams();
  const focus = params.get("focus");
  const created = params.get("new");
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    // Auto-expand the deep-linked form so its own scroll/focus effect runs against
    // a VISIBLE element on mobile (initialized synchronously, so the first paint
    // already shows it — no race with the child's mount effect).
    if (focus === "blood-pressure") s.add("vitals");
    if (created === "weight" || created === "vitals") s.add("body");
    return s;
  });

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      {/* Mobile-only chip strip — its own horizontal scroll container (#1063). */}
      <div
        className="flex gap-2 overflow-x-auto md:hidden"
        data-testid="quick-add-chips"
      >
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => toggle(it.id)}
            aria-expanded={expanded.has(it.id)}
            data-testid={`quick-add-chip-${it.id}`}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
              expanded.has(it.id)
                ? "border-brand-500 bg-brand-600 text-white"
                : "border-black/10 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
            }`}
          >
            + Log {it.label}
          </button>
        ))}
      </div>

      {/* One instance of each form. Collapsed on mobile until its chip expands it;
          always shown on desktop. */}
      {items.map((it) => (
        <div
          key={it.id}
          data-testid={`quick-add-form-${it.id}`}
          className={expanded.has(it.id) ? "block" : "hidden md:block"}
        >
          {it.node}
        </div>
      ))}
    </div>
  );
}

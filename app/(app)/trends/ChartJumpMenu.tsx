"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import type { ChartChip } from "./ChartJumpChips";

// Compact chart navigator for Trends → Body's full-chart layout. The former
// sticky chip row looked like a third tab level and spent horizontal/vertical
// space on every chart name. This keeps the same present-only anchor vocabulary
// behind one inline dropdown beside the layout toggle.
export default function ChartJumpMenu({ items }: { items: ChartChip[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === active)
  );
  const activeLabel =
    items.find((item) => item.id === active)?.label ??
    items[0]?.label ??
    "Charts";

  useEffect(() => {
    const elements = items
      .map((item) => document.getElementById(item.id))
      .filter((element): element is HTMLElement => element != null);
    if (elements.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (left, right) =>
              left.boundingClientRect.top - right.boundingClientRect.top
          );
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-15% 0px -75% 0px" }
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [items]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, open]);

  if (items.length === 0) return null;

  const moveFocus = (direction: 1 | -1) => {
    const focusedIndex = optionRefs.current.findIndex(
      (option) => option === document.activeElement
    );
    const start = focusedIndex >= 0 ? focusedIndex : activeIndex;
    const next = (start + direction + items.length) % items.length;
    optionRefs.current[next]?.focus();
  };

  return (
    <nav
      aria-label="Jump to chart"
      data-testid="chart-jump-menu"
      className="relative z-50 flex items-center"
    >
      <div className="relative inline-flex items-center">
        <button
          ref={triggerRef}
          type="button"
          data-testid="chart-jump-menu-trigger"
          aria-label={`Jump to chart: ${activeLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            moveFocus(event.key === "ArrowDown" ? 1 : -1);
          }}
          className="inline-flex h-9 min-w-24 items-center justify-between gap-2 rounded-md px-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-200 dark:hover:bg-ink-800"
        >
          <span>{activeLabel}</span>
          <IconChevronDown
            aria-hidden="true"
            className={`h-4 w-4 text-slate-400 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>

        {open && (
          <>
            <div
              aria-hidden="true"
              className="fixed inset-0 z-40"
              onClick={() => setOpen(false)}
            />
            <div
              id={menuId}
              role="menu"
              data-testid="chart-jump-menu-options"
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveFocus(event.key === "ArrowDown" ? 1 : -1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  optionRefs.current[0]?.focus();
                } else if (event.key === "End") {
                  event.preventDefault();
                  optionRefs.current[items.length - 1]?.focus();
                }
              }}
              className="absolute top-full left-0 z-50 mt-1 min-w-44 overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-ink-900"
            >
              {items.map((item, index) => {
                const selected = item.id === active;
                return (
                  <a
                    key={item.id}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    href={`#${item.id}`}
                    role="menuitemradio"
                    aria-checked={selected}
                    data-testid={`chart-jump-${item.id}`}
                    onClick={() => {
                      setActive(item.id);
                      setOpen(false);
                    }}
                    className={`flex min-h-11 w-full items-center justify-between gap-4 px-3 text-left text-sm transition ${
                      selected
                        ? "bg-brand-50 font-semibold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300"
                        : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-800"
                    }`}
                  >
                    <span>{item.label}</span>
                    {selected && (
                      <IconCheck aria-hidden="true" className="h-4 w-4" />
                    )}
                  </a>
                );
              })}
            </div>
          </>
        )}
      </div>
    </nav>
  );
}

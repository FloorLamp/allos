"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";

export interface CompactDateMenuDay {
  date: string;
  label: string;
}

// Borderless phone-only date control for compact context headings. The options
// use the app's own menu surface instead of delegating appearance to the
// platform select, whose typography and popup vary considerably by browser.
export default function CompactDateMenu({
  days,
  value,
  onChange,
  label,
  testIdPrefix,
}: {
  days: readonly CompactDateMenuDay[];
  value: string;
  onChange: (date: string) => void;
  label: string;
  testIdPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = days.find((day) => day.date === value) ?? days[0];
  const activeIndex = Math.max(
    0,
    days.findIndex((day) => day.date === active?.date)
  );

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, open]);

  const moveFocus = (direction: 1 | -1) => {
    const focusedIndex = optionRefs.current.findIndex(
      (option) => option === document.activeElement
    );
    const start = focusedIndex >= 0 ? focusedIndex : activeIndex;
    const next = (start + direction + days.length) % days.length;
    optionRefs.current[next]?.focus();
  };

  return (
    <span className="relative -my-2 inline-flex sm:hidden">
      <button
        ref={triggerRef}
        type="button"
        data-testid={`${testIdPrefix}-day-menu-trigger`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          moveFocus(event.key === "ArrowDown" ? 1 : -1);
        }}
        className="-ml-1 inline-flex h-10 items-center gap-1 rounded-md px-1 font-semibold text-slate-800 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-100 dark:hover:bg-ink-800"
      >
        <span>{active?.label}</span>
        <IconChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <>
          <span
            aria-hidden="true"
            className="fixed inset-0 z-20"
            onClick={() => setOpen(false)}
          />
          <span
            id={menuId}
            role="menu"
            data-testid={`${testIdPrefix}-day-menu`}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                moveFocus(event.key === "ArrowDown" ? 1 : -1);
              } else if (event.key === "Home") {
                event.preventDefault();
                optionRefs.current[0]?.focus();
              } else if (event.key === "End") {
                event.preventDefault();
                optionRefs.current[days.length - 1]?.focus();
              }
            }}
            className="absolute top-full left-0 z-30 mt-1 min-w-44 overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-ink-900"
          >
            {days.map((day, index) => {
              const selected = day.date === value;
              return (
                <button
                  key={day.date}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onChange(day.date);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={`flex min-h-11 w-full items-center justify-between gap-4 px-3 text-left text-sm transition ${
                    selected
                      ? "bg-brand-50 font-semibold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300"
                      : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-800"
                  }`}
                >
                  <span>{day.label}</span>
                  {selected && (
                    <IconCheck aria-hidden="true" className="h-4 w-4" />
                  )}
                </button>
              );
            })}
          </span>
        </>
      )}
    </span>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { fuzzyFilter } from "@/lib/fuzzy";

// Shared autocomplete. Two modes via `allowFreeText`:
//  - false (default): the value must be picked from `options`; an empty match
//    shows `emptyLabel`. (Used by ActivityCombobox.)
//  - true: the typed value is kept even when it isn't in `options`, and an
//    "Use '<query>'" row is offered. (Used by SupplementCombobox.)
// `onPick` fires only when the user actually chooses an entry (vs. typing), so
// callers can auto-fill sibling fields.
export default function Combobox({
  value,
  onChange,
  options,
  placeholder,
  name,
  autoFocus,
  invalid,
  ariaLabel,
  badge,
  badgeFor,
  allowFreeText = false,
  emptyLabel = "No matches",
  freeTextLabel,
  onPick,
  id,
  disabled,
  onInputBlur,
  selectOnFocus = false,
  closeStopsPropagation = false,
  inputClassName = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  name?: string;
  autoFocus?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  badge?: React.ReactNode;
  badgeFor?: (option: string) => React.ReactNode;
  allowFreeText?: boolean;
  emptyLabel?: string;
  // Renders the free-text row for the current query; default: Use "<query>".
  freeTextLabel?: (query: string) => React.ReactNode;
  // `query` is what the user had typed before choosing the option (#851 item 14): a
  // caller can prefill a sibling field from the query (e.g. a brand token → brand).
  onPick?: (v: string, query?: string) => void;
  id?: string;
  disabled?: boolean;
  onInputBlur?: () => void;
  selectOnFocus?: boolean;
  closeStopsPropagation?: boolean;
  inputClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Keyboard-highlight treatment, shared by the option rows and the
  // free-text row so arrowing through the list looks consistent.
  const highlightCls =
    "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300";
  const ref = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const q = value.trim().toLowerCase();
  // Fuzzy subsequence match + ranking (see lib/fuzzy): "bpr" finds "Bench
  // Press". An empty query keeps the first 8 options in their original order.
  const filtered = fuzzyFilter(options, value, 8);
  const showUse =
    allowFreeText &&
    value.trim() !== "" &&
    !options.some((o) => o.toLowerCase() === q);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(v: string) {
    // Capture what the user typed BEFORE onChange overwrites the input with the chosen
    // option — so onPick can prefill a sibling field from the query (#851 item 14).
    const query = value;
    onChange(v);
    onPick?.(v, query);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <input
        id={id}
        value={value}
        name={name}
        disabled={disabled}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={(event) => {
          setOpen(true);
          if (selectOnFocus) event.currentTarget.select();
        }}
        onBlur={onInputBlur}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            // The free-text row sits one past the options, at filtered.length.
            const maxIdx = filtered.length - (showUse ? 0 : 1);
            setHighlight((h) => Math.min(h + 1, Math.max(maxIdx, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            // The dropdown is open (guarded above), so Enter is a selection
            // gesture — never a form submit. Always swallow it: pick the
            // highlighted option, else the free-text "Use '<query>'" row
            // (highlight === filtered.length via ArrowDown, or the only row
            // left when nothing matches — either way filtered[highlight] is
            // undefined). Without the unconditional preventDefault, pressing
            // Enter with no highlighted match (e.g. a novel free-text name)
            // submitted the whole form.
            e.preventDefault();
            if (filtered[highlight]) pick(filtered[highlight]);
            else if (showUse) pick(value.trim());
            else setOpen(false);
          } else if (e.key === "Escape") {
            if (closeStopsPropagation) e.stopPropagation(); // close dropdown, not a modal
            setOpen(false);
          }
        }}
        className={`input ${inputClassName} ${badge ? "pr-28" : ""} ${
          invalid
            ? "border-rose-300 focus:border-rose-400 focus:ring-rose-400 dark:border-rose-800 dark:focus:border-rose-700 dark:focus:ring-rose-700"
            : ""
        }`}
      />
      {badge && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
          {badge}
        </span>
      )}
      {open && (filtered.length > 0 || showUse || !allowFreeText) && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-ink-900"
        >
          {filtered.length === 0 && !allowFreeText ? (
            <li className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
              {emptyLabel}
            </li>
          ) : (
            filtered.map((o, i) => (
              <li key={o}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                    i === highlight
                      ? highlightCls
                      : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-800"
                  }`}
                >
                  <span className="truncate">{o}</span>
                  {badgeFor?.(o)}
                </button>
              </li>
            ))
          )}
          {showUse && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(value.trim());
                }}
                onMouseEnter={() => setHighlight(filtered.length)}
                className={`w-full px-3 py-2 text-left text-sm ${
                  highlight === filtered.length
                    ? highlightCls
                    : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-ink-800"
                }`}
              >
                {freeTextLabel ? (
                  freeTextLabel(value.trim())
                ) : (
                  <>Use “{value.trim()}”</>
                )}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

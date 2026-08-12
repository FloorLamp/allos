"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { IconChevronDown, IconSearch, IconX } from "@tabler/icons-react";
import { fuzzyFilter, fuzzyFilterWithTerms } from "@/lib/fuzzy";

// Shared autocomplete. Two modes via `allowFreeText`:
//  - false (default): the value must be picked from `options`; an empty match
//    shows `emptyLabel`. (Used by ActivityCombobox.)
//  - true: the typed value is kept even when it isn't in `options`, and an
//    "Use '<query>'" row is offered. (Used by IntakeItemCombobox.)
// `onPick` fires only when the user actually chooses an entry (vs. typing), so
// callers can auto-fill sibling fields.
// `groupFor` (#1675) adds optional headers to the EMPTY-QUERY list, which is what
// turns a long ranked option list into a readable relevance view; typing is
// unchanged for every caller, grouped or not.
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
  iconFor,
  labelFor,
  searchTermsFor,
  usedOptions,
  groupFor,
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
  inputElementRef,
  appearance = "field",
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
  // Leading-icon slot (#1176): rendered BEFORE the label, in a left flex cluster so
  // the icon sits flush-left and the label still ellipsizes. `badgeFor` stays the
  // TRAILING (right-hand) slot. The provider picker uses this for the
  // individual/organization icon; additive, so existing callers are unaffected.
  iconFor?: (option: string) => React.ReactNode;
  // Render a label different from the option's selected value. Keyed pickers can
  // pass stable ids as `options` while keeping human labels in the list.
  labelFor?: (option: string) => React.ReactNode;
  // Hidden aliases for matching while keeping the option's visible label stable.
  // Used by the protocol outcome picker so "A1c" finds "Hemoglobin A1c".
  searchTermsFor?: (option: string) => readonly string[];
  // Lowercased option names this profile has ACTUALLY used (#2384). Without it the
  // caller's careful ranking — recency-decayed frequency, today's routine slots,
  // owned equipment, draft companions — survives only as an exact-score tiebreak
  // and is therefore discarded on the first keystroke. The caller answers "does
  // this profile use this?"; lib/fuzzy owns what that is worth (USAGE_BONUS), so
  // no surface invents a sort. Declared evidence only: a picker that merely HAS an
  // order must not pass one.
  usedOptions?: ReadonlySet<string>;
  // Group headers for the EMPTY-QUERY list only (#1675). An empty query is the
  // relevance view — the caller hands options in ranked order and names each row's
  // bucket here, so "Due or flagged" leads and the header says why. Typing is
  // unchanged: a fuzzy search runs over everything and shows a flat result list,
  // because a header over one match is noise. Return null to leave a row unheaded.
  groupFor?: (option: string) => string | null;
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
  inputElementRef?: React.RefObject<HTMLInputElement | null>;
  // A selected value can also be a page/section identity. The title treatment
  // keeps the same searchable listbox behavior but removes field chrome, sizes
  // to its text, swaps search/clear affordances for a compact dropdown chevron,
  // and gives the open menu a useful width for longer options.
  appearance?: "field" | "title";
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [showAllOnOpen, setShowAllOnOpen] = useState(false);
  // Keyboard-highlight treatment, shared by the option rows and the
  // free-text row so arrowing through the list looks consistent.
  const highlightCls =
    "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300";
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const titleAppearance = appearance === "title";

  const filterValue = titleAppearance && showAllOnOpen ? "" : value;
  const q = filterValue.trim().toLowerCase();
  // Fuzzy subsequence match + ranking (see lib/fuzzy): "bpr" finds "Bench
  // Press". An empty query keeps the first 8 options in their original order.
  const filtered = searchTermsFor
    ? fuzzyFilterWithTerms(options, filterValue, searchTermsFor, {
        limit: 8,
        used: usedOptions,
      })
    : fuzzyFilter(options, filterValue, { limit: 8, used: usedOptions });
  // Headers only in the relevance view (see `groupFor`).
  const showGroups = groupFor != null && q === "";
  const showUse =
    allowFreeText &&
    value.trim() !== "" &&
    !options.some((o) => o.toLowerCase() === q);

  useEffect(() => {
    // Dismiss on pointerdown OUTSIDE the combobox root. pointerdown fires before the
    // click completes, so a click aimed at a control next to the combobox finds the
    // (absolutely-positioned, overlapping) dropdown already closed — it can't intercept
    // the click. An option/clear press is INSIDE the root (and preventDefaults), so it
    // still picks. (#1176/#1177 — the native datalist popover auto-closed; this one
    // must too, or its overlay eats the next control's click.)
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    // Also dismiss when a control OUTSIDE the combobox commits a value — e.g. the
    // <select> next to a dose-amount field. A `change` on a sibling means the user
    // moved on; closing here keeps the overlay from lingering over the next control
    // even when the move didn't route through a pointerdown/blur the combobox sees
    // (a programmatic selectOption dispatches only `change`). The combobox's OWN input
    // change (on blur) is inside the root, so it's skipped.
    const onChange = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("change", onChange, true);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("change", onChange, true);
    };
  }, []);

  function pick(v: string) {
    // Capture what the user typed BEFORE onChange overwrites the input with the chosen
    // option — so onPick can prefill a sibling field from the query (#851 item 14).
    const query = value;
    onChange(v);
    onPick?.(v, query);
    setOpen(false);
    setShowAllOnOpen(false);
  }

  return (
    <div
      ref={ref}
      className={
        titleAppearance ? "group relative inline-block max-w-full" : "relative"
      }
      // Let a parent focus trap leave the first Escape to this open picker.
      // The input handler below then closes only the listbox; a second Escape
      // reaches the modal normally.
      data-escape-layer={open ? "true" : undefined}
    >
      {!titleAppearance && (
        <span className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-10 items-center justify-center text-slate-500 dark:text-slate-400">
          <IconSearch className="h-4 w-4" stroke={2} aria-hidden="true" />
        </span>
      )}
      {titleAppearance && (
        <span
          aria-hidden="true"
          data-testid="combobox-title-text"
          className="pointer-events-none absolute inset-y-0 left-0 z-20 flex items-center pr-7 text-2xl leading-tight font-semibold tracking-tight text-slate-900 transition group-hover:text-brand-700 md:text-3xl dark:text-slate-50 dark:group-hover:text-brand-300"
        >
          {value || placeholder}
        </span>
      )}
      <input
        ref={(node) => {
          inputRef.current = node;
          if (inputElementRef) inputElementRef.current = node;
        }}
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
        size={
          titleAppearance
            ? Math.min(
                Math.max(value.length || placeholder?.length || 1, 1),
                32
              )
            : undefined
        }
        onChange={(e) => {
          onChange(e.target.value);
          setShowAllOnOpen(false);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={(event) => {
          if (titleAppearance) {
            setShowAllOnOpen(true);
            event.currentTarget.select();
          }
          setOpen(true);
          if (selectOnFocus) event.currentTarget.select();
        }}
        onBlur={() => {
          // Close the dropdown when focus leaves the input — tabbing away, or
          // focusing a sibling control (e.g. a <select> next to the field, which a
          // programmatic selectOption focuses WITHOUT a pointerdown). Without this the
          // overlay would linger over the next control and swallow its click (#1177).
          // An option/clear press keeps focus (its mousedown preventDefaults), so this
          // never fires mid-selection.
          setOpen(false);
          setShowAllOnOpen(false);
          onInputBlur?.();
        }}
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
        className={
          titleAppearance
            ? `input relative z-10 w-auto! max-w-full rounded-none! border-0! bg-transparent! px-0! py-1! pr-7! text-2xl leading-tight font-semibold tracking-tight text-transparent! shadow-none! caret-brand-600 focus:border-transparent! focus:ring-0! md:text-3xl dark:text-transparent! dark:caret-brand-400 ${inputClassName}`
            : `input pl-9 ${inputClassName} ${
                badge ? (value && !disabled ? "pr-36" : "pr-28") : ""
              } ${value && !disabled && !badge ? "pr-10" : ""} ${
                invalid
                  ? "border-rose-300 focus:border-rose-400 focus:ring-rose-400 dark:border-rose-800 dark:focus:border-rose-700 dark:focus:ring-rose-700"
                  : ""
              }`
        }
      />
      {badge && (
        <span
          className={`pointer-events-none absolute inset-y-0 flex items-center ${
            value && !disabled ? "right-10" : "right-2"
          }`}
        >
          {badge}
        </span>
      )}
      {value && !disabled && !titleAppearance && (
        <button
          type="button"
          // Accessible name kept to a bare "Clear" (not "Clear <field>"): the field's
          // own label already names the control, and embedding the field name here made
          // the clear button a SECOND match for getByLabel(field) / screen-reader field
          // lookups now that the input carries an aria-label (#1177).
          aria-label="Clear"
          title="Clear"
          className="absolute inset-y-0 right-0 z-10 flex w-10 items-center justify-center rounded-r-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-300"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange("");
            setHighlight(0);
            setOpen(true);
            inputRef.current?.focus();
          }}
        >
          <IconX className="h-4 w-4" stroke={2} aria-hidden="true" />
        </button>
      )}
      {titleAppearance && (
        <span className="pointer-events-none absolute inset-y-0 right-0 z-30 flex items-center text-slate-500 dark:text-slate-400">
          <IconChevronDown className="h-5 w-5" stroke={2} aria-hidden="true" />
        </span>
      )}
      {open && (filtered.length > 0 || showUse || !allowFreeText) && (
        <ul
          id={listboxId}
          role="listbox"
          className={`absolute z-50 mt-1 max-h-56 overflow-auto rounded-lg border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-ink-900 ${
            titleAppearance ? "w-80 max-w-[calc(100vw-2rem)]" : "w-full"
          }`}
        >
          {filtered.length === 0 && !allowFreeText ? (
            <li className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
              {emptyLabel}
            </li>
          ) : (
            filtered.map((o, i) => {
              const group = showGroups ? groupFor(o) : null;
              const prev =
                showGroups && i > 0 ? groupFor(filtered[i - 1]) : null;
              return (
                <Fragment key={o}>
                  {group && group !== prev && (
                    <li
                      role="presentation"
                      data-testid="combobox-group"
                      className="section-label px-3 pb-1 pt-2"
                    >
                      {group}
                    </li>
                  )}
                  <li>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(o);
                      }}
                      onMouseEnter={() => setHighlight(i)}
                      data-testid="combobox-option"
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                        i === highlight
                          ? highlightCls
                          : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-800"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {iconFor?.(o)}
                        <span className="truncate">{labelFor?.(o) ?? o}</span>
                      </span>
                      {badgeFor?.(o)}
                    </button>
                  </li>
                </Fragment>
              );
            })
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

"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown, IconSearch, IconX } from "@tabler/icons-react";
import { fuzzyFilter, fuzzyFilterWithTerms } from "@/lib/fuzzy";
import {
  droppedGroupsWarning,
  groupedRelevanceView,
} from "@/lib/relevance-view";
import { useAnchoredPopover } from "@/components/overlay/useAnchoredPopover";

// How tall the list WANTS to be — what `max-h-56` used to say as a class. It is a
// preference now, not a cap: the shared placement shrinks it to the room actually
// available so the last row is never left off the bottom of the screen.
const LISTBOX_MAX_HEIGHT = 224; // matches max-h-56

// How many rows the PRE-TYPING list holds. Deliberately short — nobody wants a
// 400-row menu before they have typed a letter — and deliberately the same number
// whether the caller groups its options or not. Where those rows GO when the options
// carry several groups is lib/relevance-view.ts's question (#3410).
const RELEVANCE_ROWS = 8;

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
  //
  // IF YOU ARE MERGING TWO RANKED VOCABULARIES INTO ONE PICKER, PASS THIS (#3410).
  // The pre-typing list is capped at RELEVANCE_ROWS, and with `groupFor` those rows
  // are shared out per group, so every vocabulary is represented instead of the
  // higher-ranked one spending all of them and the other vanishing without a header
  // or a "more". WITHOUT `groupFor` the concatenated list has no seam in it, nothing
  // can detect the loss, and the picker looks complete because it looks short —
  // which is exactly how #3220 lost its analyte groups.
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
  // Headers only in the relevance view (see `groupFor`).
  const showGroups = groupFor != null && q === "";
  // The GROUPED pre-typing list shares its rows out per group instead of taking
  // them all off the front, so a picker fed two ranked vocabularies shows both
  // (#3410). Ungrouped, and every typed query, are untouched.
  const relevance = showGroups
    ? groupedRelevanceView(options, groupFor, RELEVANCE_ROWS)
    : null;
  // Fuzzy subsequence match + ranking (see lib/fuzzy): "bpr" finds "Bench
  // Press". An empty query keeps the first RELEVANCE_ROWS options in their
  // original order.
  const filtered =
    relevance?.rows ??
    (searchTermsFor
      ? fuzzyFilterWithTerms(options, filterValue, searchTermsFor, {
          limit: RELEVANCE_ROWS,
          used: usedOptions,
        })
      : fuzzyFilter(options, filterValue, {
          limit: RELEVANCE_ROWS,
          used: usedOptions,
        }));
  // THE KEYBOARD MODEL, MADE OBSERVABLE (#3316). Arrowing moves `highlight`; the
  // input publishes the row it names through `aria-activedescendant`, so a screen
  // reader announces the active row instead of a highlight nothing describes.
  const optionId = (index: number) => `${listboxId}-option-${index}`;
  const freeTextId = `${listboxId}-use`;
  const showUse =
    allowFreeText &&
    value.trim() !== "" &&
    !options.some((o) => o.toLowerCase() === q);

  // THE LISTBOX IS PORTALED (#3271). Left in flow it was an absolutely-positioned
  // child, and an absolutely-positioned element is clipped by ANY ancestor
  // carrying an `overflow` — `z-50` never helped, because z-index does not escape
  // a clip box. So the list was confined to whichever ancestor scroller it
  // happened to sit in: a phone sheet bounded at `max-h-[85dvh]`, a `max-h`
  // editor, a table's scroller. The owner's report was the Add supplement dialog
  // cut off mid-row with two scrollbars — the ancestor's, and the list's own
  // `max-h-56`. An `overflow` establishes that clip whether or not it is
  // currently scrolling, so the bug did not need the ancestor to be scrolled.
  //
  // Anchored to the ROOT rather than the input so a field dropdown keeps exactly
  // the width it had (the root is what `w-full` used to resolve against). The
  // title appearance sizes itself instead, so it does not match.
  //
  // Re-anchored as the list grows and shrinks: the ResizeObserver behind the hook
  // watches the document, not the panel, and a list that has flipped ABOVE the
  // field moves its own top edge every time a keystroke changes the row count.
  const listOpen = open && (filtered.length > 0 || showUse || !allowFreeText);
  // Only while the list is actually rendered: a stale id would point at nothing.
  const activeDescendantId = !listOpen
    ? undefined
    : filtered[highlight]
      ? optionId(highlight)
      : showUse && highlight === filtered.length
        ? freeTextId
        : undefined;
  const { pos, attachPanel, panelRef } = useAnchoredPopover({
    open: listOpen,
    anchorRef: ref,
    matchAnchorWidth: !titleAppearance,
    preferredMaxHeight: LISTBOX_MAX_HEIGHT,
    remeasureKey: `${filtered.length}:${showUse}`,
  });

  // #3410 item (3): the grouped view represents every group it can, and says so in
  // DEVELOPMENT when it cannot — a picker with more groups than the list has rows.
  // Deliberately silent for every group count a shipped picker has (see
  // lib/__tests__/relevance-view.test.ts, which runs it over both): a warning that
  // fires on ordinary pickers is deleted within a week, taking the real guard with it.
  // The message IS the effect's dependency, so it prints once per distinct loss
  // rather than once per render.
  const droppedWarning = relevance?.droppedGroups.length
    ? droppedGroupsWarning(relevance.droppedGroups, RELEVANCE_ROWS)
    : "";
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || droppedWarning === "") return;
    console.warn(droppedWarning);
  }, [droppedWarning]);

  useEffect(() => {
    // Dismiss on pointerdown OUTSIDE the combobox root. pointerdown fires before the
    // click completes, so a click aimed at a control next to the combobox finds the
    // (absolutely-positioned, overlapping) dropdown already closed — it can't intercept
    // the click. An option/clear press is INSIDE the root (and preventDefaults), so it
    // still picks. (#1176/#1177 — the native datalist popover auto-closed; this one
    // must too, or its overlay eats the next control's click.)
    // The list is portaled OUTSIDE `ref` (#3271), so a press on an option is not
    // "inside the root" any more — without counting it, this would close the
    // listbox before the option's own mousedown could pick it.
    const onDoc = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !panelRef.current?.contains(target)
      )
        setOpen(false);
    };
    // Also dismiss when a control OUTSIDE the combobox commits a value — e.g. the
    // <select> next to a dose-amount field. A `change` on a sibling means the user
    // moved on; closing here keeps the overlay from lingering over the next control
    // even when the move didn't route through a pointerdown/blur the combobox sees
    // (a programmatic selectOption dispatches only `change`). The combobox's OWN input
    // change (on blur) is inside the root, so it's skipped.
    const onChange = (e: Event) => {
      const target = e.target as Node;
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !panelRef.current?.contains(target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("change", onChange, true);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("change", onChange, true);
    };
  }, [panelRef]);

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
      {/* inset-0 bounds the overlay so a long name TRUNCATES on one line
          (#2895) — left/inset-y alone left it unbounded, wrapping over the
          single-line input beneath and colliding with whatever followed. */}
      {titleAppearance && (
        <span
          aria-hidden="true"
          data-testid="combobox-title-text"
          className="pointer-events-none absolute inset-0 z-20 flex items-center pr-7 text-2xl leading-tight font-semibold tracking-tight text-slate-900 transition group-hover:text-brand-700 md:text-3xl dark:text-slate-50 dark:group-hover:text-brand-300"
        >
          <span className="truncate">{value || placeholder}</span>
        </span>
      )}
      {/*
        THE VISIBLE FIELD IS BOTH CONTROLLED AND NAMED, which makes every Combobox
        inside a named `<form>` a subject of the dirty-form registry — and, until
        #3352, a permanently CLEAN one: React syncs `defaultValue` onto a controlled
        input to match `value`, so the registry's "current vs what the server
        rendered" compared a value with a copy of itself. This is a shared component,
        so that defect was live everywhere one sat in such a form. Fixed in
        components/DirtyFormRegistry.tsx, which no longer trusts a DOM default that
        moved onto exactly what the user typed. Nothing is needed here — but if this
        input ever gains a `defaultValue` or loses its `name`, that is the file to
        read first.

        The CONTRAST worth keeping in view: ProviderCombobox wraps this and submits
        through a `type="hidden"` input instead, which the registry excludes outright.
        That made it immune to #3352 and invisible to the discard guard entirely,
        which is #3356 — two comboboxes, differing in exactly the one property that
        decides both.
      */}
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
        aria-activedescendant={activeDescendantId}
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
      {listOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <ul
            ref={attachPanel}
            id={listboxId}
            role="listbox"
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              width: pos?.width,
              maxHeight: pos?.maxHeight,
              // Never paint at 0,0 for a frame: the panel entering the DOM is
              // what makes measurement possible, so the first render is hidden.
              visibility: pos ? "visible" : "hidden",
            }}
            // Above the sheet/dialog it opens over (`z-60`), the same layer the
            // portaled date calendar takes for the same reason.
            className={`z-70 overflow-auto rounded-lg border border-black/10 bg-surface py-1 shadow-lg dark:border-white/10 ${
              titleAppearance ? "w-80 max-w-[calc(100vw-2rem)]" : ""
            }`}
          >
            {filtered.length === 0 && !allowFreeText ? (
              // Not an option — a listbox with an `option` reading "No matches" is a
              // listbox the keyboard model says you can choose (#3316).
              <li
                role="presentation"
                className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400"
              >
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
                    {/* THE ROW IS THE OPTION (#3316). It used to be a plain
                        `<button>` inside the `li`, which left `role="listbox"` with
                        no `option` children at all: the a11y tree saw a list with no
                        items, and arrowing moved a highlight nothing announced.
                        Focus never leaves the input — this is the
                        aria-activedescendant pattern — so the row is not a tab stop
                        and does not need to be one. */}
                    <li
                      role="option"
                      id={optionId(i)}
                      aria-selected={i === highlight}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(o);
                      }}
                      onMouseEnter={() => setHighlight(i)}
                      data-testid="combobox-option"
                      className={`flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
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
                    </li>
                  </Fragment>
                );
              })
            )}
            {/* THE FREE-TEXT ROW IS A COMMAND, NOT AN OPTION (#3316), and stays a
                real `<button>`. "Use '<query>'" does not name something the picker
                offers — it names an action on what the user typed — so exposing it
                as an `option` would tell a screen-reader user the vocabulary
                contains their typo. `aria-activedescendant` still names it when it
                is the active row, which announces it as the button it is; its `li`
                is `presentation` so the listbox's own children stay options. */}
            {showUse && (
              <li role="presentation">
                <button
                  type="button"
                  id={freeTextId}
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
          </ul>,
          document.body
        )}
    </div>
  );
}

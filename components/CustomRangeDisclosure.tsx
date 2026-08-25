"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import Chip from "@/components/Chip";

// The mobile collapse for DateRangeControl's From/To card (#1455).
//
// On a phone the always-visible From/To/Apply/Clear card cost ~230px above the
// fold on every surface that mounts the shared control (Trends, the metric detail
// pages, the Timeline) — for a control most sessions never touch, because the
// quick-range pills answer the question. Below `sm` the pill row becomes the
// primary control and this disclosure hides the card behind a "Custom…" pill;
// `sm:`-and-up is unchanged (the panel is always visible, the toggle never
// renders).
//
// It is a THREE-part component — provider + toggle + panel — because the two
// halves live in different parents: the toggle rides the scrolling chip row, the
// panel sits outside it. A single wrapper can't render into both, and
// DateRangeControl must stay a Server Component (it takes a `buildHref` FUNCTION
// prop, which can't cross the server/client boundary), so the shared open state
// lives here in a tiny context instead.
//
// `defaultOpen` (the caller's `isCustomRange`) is the initial state only, so a
// shared ?from=/?to= URL lands with its dates visible. It is deliberately NOT a
// controlled value: once the user has opened or closed the panel, a quick-range
// pill navigation must not yank it back.

interface CustomRangeCtx {
  open: boolean;
  toggle: () => void;
  panelId: string;
}

const Ctx = createContext<CustomRangeCtx | null>(null);

export function CustomRangeDisclosure({
  defaultOpen,
  idPrefix,
  children,
}: {
  defaultOpen: boolean;
  idPrefix: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `${idPrefix}-custom-panel`;
  // The provider renders its children directly — no wrapper element — so it adds
  // no DOM node between DateRangeControl's flex root and its flex children.
  return (
    <Ctx.Provider value={{ open, toggle: () => setOpen((o) => !o), panelId }}>
      {children}
    </Ctx.Provider>
  );
}

// The "Custom…" pill. Mobile-only; Chip owns its registered presentation and
// selected semantics while this disclosure independently owns expanded state.
export function CustomRangeToggle({
  active,
}: {
  // Whether the window in effect IS a custom range — i.e. whether this pill is
  // the selected one among its quick-range siblings. `aria-pressed` answers
  // selection and `aria-expanded` separately answers whether the panel is open.
  active: boolean;
}) {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  return (
    <span className="sm:hidden">
      <Chip
        role="filter"
        testId="custom-range-toggle"
        pressed={active}
        expanded={ctx.open}
        controls={ctx.panelId}
        onClick={ctx.toggle}
      >
        Custom&hellip;
      </Chip>
    </span>
  );
}

// The From/To card's wrapper: hidden below `sm` until the toggle opens it, always
// shown from `sm` up. `hidden` (not unmounting) keeps the form — and its
// server-rendered default values — in the DOM either way, so nothing about the
// submit path changes with the panel's state.
export function CustomRangePanel({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  return (
    <div
      id={ctx.panelId}
      data-testid="custom-range-panel"
      className={`${ctx.open ? "" : "hidden sm:block"} ${className}`}
    >
      {children}
    </div>
  );
}

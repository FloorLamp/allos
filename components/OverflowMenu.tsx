"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { IconDots } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useConfirmOpen } from "@/components/ConfirmDialog";
import { useLatestRef } from "@/components/useLatestRef";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";

// Shared kebab (⋯) overflow menu used by the goals and supplement cards and the
// extracted-observations table. The caller owns the open state (so it can also lift
// its card's z-index while the menu is open) and passes it in controlled — this
// component renders the trigger and hands its items to the shared host.
//
// WHERE THE ITEMS OPEN IS NOT THIS FILE'S DECISION ANY MORE (#3374).
// components/overlay/AnchoredPanel.tsx makes it: below `md` these items are a
// bottom action sheet; from `md` up they are the portaled, trigger-anchored,
// `position: fixed` popover this file has always rendered — never clipped by an
// `overflow` ancestor, right-aligned under the kebab, flipping above when there
// is no room below, following scroll/resize while open.
//
// That placement is components/overlay/useAnchoredPopover.ts (#3271) — this file
// is where it was first written, and the third caller (the combobox listbox) is
// what turned two near-copies into one shared hook. The behaviour at `md`+ is
// unchanged, including the #2839 layout-shift tracking, which the hook carries
// because this file taught it.
//
// THE ROWS ANSWER THE TAP FLOOR THE TRIGGER ALREADY HONOURED. `py-1.5` is a 32px
// row: fine under a mouse, under the 40px minimum (#644) the trigger below spells
// out in the same file. The floor is met where a finger is actually doing the
// tapping — 44px below `md`, where the sheet is, and 40px on a coarse pointer at
// any width above it (a tablet gets the popover and a thumb). A fine pointer from
// `md` up keeps the compact desktop row. The two `md:` rules are keyed on
// MUTUALLY EXCLUSIVE pointer media, deliberately: a `md:py-1.5` sitting beside a
// `md:pointer-coarse:py-2.5` would leave which one wins to stylesheet order.
export const MENU_ITEM =
  "block w-full px-3 py-3 text-left text-sm text-slate-700 hover:bg-slate-50 md:pointer-fine:py-1.5 md:pointer-coarse:py-2.5 dark:text-slate-200 dark:hover:bg-ink-800";
export const MENU_ITEM_DANGER =
  "block w-full px-3 py-3 text-left text-sm text-rose-600 hover:bg-rose-50 md:pointer-fine:py-1.5 md:pointer-coarse:py-2.5 dark:text-rose-400 dark:hover:bg-rose-950";

const MENU_WIDTH = 160; // matches w-40

// What a menu action may resolve with. `void` keeps the render-time message (the
// additive case). A RESULT lets the toast come from the write's OUTCOME instead of the
// stale render (#2133): a refusal (`ok: false`) toasts its error in the error tone, and
// a success may carry the state-named `message` the write actually performed.
export type MenuActionResult =
  void | { ok: true; message?: string } | { ok: false; error: string };

export interface MenuHelpers {
  close: () => void;
  // Run a menu item's server action, then close the menu and toast. Awaiting the
  // action first is load-bearing: closing the menu (which unmounts the <form>)
  // before React dispatches the action would silently drop it.
  runAction: (
    action: (fd: FormData) => Promise<MenuActionResult>,
    fd: FormData,
    message: string
  ) => Promise<void>;
  // The trigger button — the one part of this menu still standing inside the row it
  // belongs to. The PANEL is portaled (or hosted in a sheet), so a menu item cannot
  // reach its own row with `closest()`, and cannot reach it through React either (the
  // row is a Server Component and the callback would have to cross that boundary). A
  // caller that genuinely needs the row walks up from here; #2654's dismissal slide is
  // the only one today. Handed over as the REF, not as a getter: `.current` is read
  // when a menu item acts, which is always an event and never a render. Read-only, and
  // never a substitute for props — it exists because the portal severed a DOM
  // ancestry that really is there.
  anchorRef: RefObject<HTMLElement | null>;
}

export default function OverflowMenu({
  label,
  open,
  onOpenChange,
  children,
  panelClassName = "w-40",
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: (helpers: MenuHelpers) => ReactNode;
  panelClassName?: string;
}) {
  const toast = useToast();
  const confirmOpen = useConfirmOpen();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    onOpenChange(false);
  };
  const runAction: MenuHelpers["runAction"] = async (action, fd, message) => {
    let result: MenuActionResult;
    try {
      result = await action(fd);
    } catch {
      // An uncaught menu-action throw used to escalate to the route error
      // boundary (issue #477) — close the menu and toast the failure instead.
      close();
      toast("Couldn't complete that action. Try again.", {
        tone: "error",
      });
      return;
    }
    close();
    // A typed refusal is rendered, never papered over with the success message —
    // the inline-action rule (#2133).
    if (result && result.ok === false) {
      toast(result.error, { tone: "error" });
      return;
    }
    toast((result && result.message) || message);
  };

  // A DECISION opened over this menu ends it (#2599).
  //
  // A menu item that awaits `useConfirm()` hands the interaction to a modal
  // layered above (`z-110`) — but the menu's own click-away backdrop below is
  // `fixed inset-0`, and it survives underneath. Every call site closes the menu
  // on the CONFIRM branch; most `return` early on CANCEL, so the backdrop
  // outlived the interaction and silently ate the user's next tap ANYWHERE on the
  // page: cancel a delete on the supply cabinet, then tap the profile-switch chip
  // beside it, and nothing happens, with no error (reproduced 3/3 — it is also
  // what made a Server Action form look like it fired no POST at all).
  //
  // The rule belongs here, not at fifteen call sites: this menu is a transient
  // surface, and it is stale the moment something the user must answer opens over
  // it. That holds for the sheet presentation too, which puts its own scrim over
  // the page. `close()` is called through a ref so the effect keys on the STATE,
  // not on a callback whose identity changes every render.
  const closeRef = useLatestRef(close);
  useEffect(() => {
    if (open && confirmOpen) closeRef.current();
  }, [open, confirmOpen, closeRef]);

  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          // A new open episode must measure before painting rather than reuse
          // the previous one's position while the portal ref is attaching. The
          // shared hook drops the position on close, so opening always starts
          // unmeasured — and hidden — without this having to say so.
          if (open) close();
          else onOpenChange(true);
        }}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        data-testid="overflow-menu-trigger"
        // ≥40px hit box (#644): a 16px glyph centered in a 40px box so the sole
        // per-row action affordance clears the touch-target minimum on mobile.
        className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-300"
      >
        <IconDots className="h-4 w-4" />
      </button>
      <AnchoredPanel
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        // The trigger's accessible name names the row these actions belong to
        // ("Medication actions", "Actions for …"), which is exactly the heading
        // the sheet owes a viewer who can no longer see the row it came from.
        title={label}
        role="menu"
        sheetTestId="overflow-menu-sheet"
        // Right-aligned under the kebab, which sits at the row's trailing edge.
        align="end"
        fallbackWidth={MENU_WIDTH}
        panelClassName={`py-1 ${panelClassName}`}
        // Some menu flows expand into a wider picker while staying open; re-anchor
        // after that width changes. Below `md` the same flow is simply more sheet
        // content and the width means nothing.
        remeasureKey={panelClassName}
      >
        {() => children({ close, runAction, anchorRef: triggerRef })}
      </AnchoredPanel>
    </div>
  );
}

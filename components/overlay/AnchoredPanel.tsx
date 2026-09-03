"use client";

import { useCallback, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import BottomSheet from "@/components/BottomSheet";
import { usePresence } from "@/components/usePresence";
import { focusablesIn } from "@/components/useFocusTrap";
import { useCompactViewport } from "@/components/useCompactViewport";
import { motionMs } from "@/lib/motion";
import { useAnchoredPopover } from "./useAnchoredPopover";
import type { AnchoredAlign } from "@/lib/anchored-position";

// THE ANCHORED PANEL — a popover anchored to its trigger from `md` up, a bottom
// ACTION SHEET below it (issues #3374, #3376).
//
// components/overlay/useAnchoredPopover.ts is the maths: where a panel goes
// relative to the control that opened it. This file is the HOST DECISION that
// sits above it, and it is the one place the app answers "is an anchored panel
// the right shape here at all". Below `md` it is not: a 160px panel of 32px rows
// hanging off a kebab is a desktop context menu, and a phone opening one is the
// idiom the 2026-08-20 census was written to retire.
//
// ONE FORK, THIRTY SURFACES. The ⋯ menu alone has ~23 importers and is the
// primary per-row action affordance on the most phone-used screens; the date
// picker is on every form. Neither of them — and no consumer of either — says
// anything about viewports. They pass their CONTENT and their anchor; this file
// decides what it opens in. A per-consumer `md:` branch would be thirty places
// to forget.
//
// CONTENT IS AUTHORED ONCE (#2305). `children` is a FUNCTION, and the node it
// returns is mounted in exactly one host — never rendered twice with one copy
// hidden. Two copies of a menu is two lists of actions to keep in step, and the
// hidden one is the one that rots.
//
// WHAT EACH HOST BRINGS:
//
//   * BELOW `md` — components/BottomSheet.tsx, the #1428 responsive host. Its
//     dismissal is DISCARD, which is precisely a menu's contract: closing a menu
//     loses nothing. So a menu sheet passes NO `onGestureDismiss` guard, and the
//     Escape seam #3425 added routes to the plain close, which is what we want.
//     The drag, the scrim, the scroll lock, the focus trap and the focus RESTORE
//     all come with it — no new gesture recognizer here, per #3374's invariant.
//   * FROM `md` UP — the portaled `position: fixed` popover exactly as it has
//     always rendered: measured before paint, hidden until measured, following
//     scroll/resize/layout-shift through the shared hook.
//
// FOCUS RETURNS TO THE TRIGGER IN BOTH (#3374's invariant), and since #3905 it
// goes INTO the panel in both as well — but only for a panel that declares a
// `role`. A role here means the trigger declared `aria-haspopup`: it promised a
// menu or a dialog, and a promised popup the keyboard cannot reach has not been
// opened. The sheet has done this since #1416 through useFocusTrap; the popover
// used to leave focus on the trigger, so its five-to-thirty controls sat behind
// the whole rest of the page in the tab order.
//
// NOT the whole of useFocusTrap, deliberately. Three of its four jobs are what a
// popover wants — initial focus, Escape, restore — and the fourth, the Tab
// CYCLE, is the one that makes a surface MODAL. A popover is not: tabbing out of
// it is how you leave it, and the page behind it is still in play. So no trap, no
// `aria-modal`, no scroll lock. What IS shared is `focusablesIn`, the single
// answer to "what is reachable in here", so the two hosts cannot come to disagree
// about where focus lands.
//
// THE POPOVER NEVER EXTENDS PAST THE VIEWPORT EDGE (#4776), and this file no
// longer says so itself — the hook's `panelStyle` is the one applier of that
// bound (#4887). What IS this file's is the SCROLLER under it, the contract's other
// half: content here needs no height management, and a caller adding a `max-h-*`
// to `panelClassName` declares a tighter cap for its own reasons rather than
// making the panel safe; the inline max-height wins regardless.
// `overscroll-contain` rides with the scroller: this popover draws a
// full-viewport click-away catcher, so a drag its own scroller declines would
// chain to the document and move the page BEHIND the open panel (#2774, and
// lib/__tests__/overlay-motion-chokepoint.test.ts, which caught exactly this).
//
// A ROLE-LESS PANEL IS LEFT ALONE, and that is the discriminating rule rather
// than a new prop. DateField's calendar opens when the FIELD takes focus and the
// typist has to keep it — manual ISO entry works at every width (#3376) — so its
// trigger promises no popup, its panel claims no role, and nothing here fires.
export default function AnchoredPanel({
  open,
  onClose,
  anchorRef,
  title,
  children,
  role,
  panelId,
  testId,
  sheetTestId,
  onPanelKeyDown,
  panelRef,
  align = "start",
  fallbackWidth = 0,
  panelClassName = "",
  popoverZIndexClass = "z-50",
  sheetZIndexClass,
  backdrop = true,
  escapeLayer = false,
  remeasureKey,
}: {
  open: boolean;
  onClose: () => void;
  // The control the popover is placed against. Unused in the sheet presentation,
  // which is anchored to the screen rather than to anything on it.
  anchorRef: React.RefObject<HTMLElement | null>;
  // The sheet's heading and accessible name. A sheet with no name is a sheet
  // whose purpose you infer from its rows (components/BottomSheet.tsx says so at
  // more length); the popover has no room for a heading and does not draw one.
  title: string;
  children: () => ReactNode;
  // The panel's ARIA role. `menu` is applied in BOTH presentations so a spec —
  // and a screen reader — sees the same thing at either width. `dialog` is the
  // POPOVER's alone: below `md` BottomSheet already is the dialog, names itself
  // from `title` and sets `aria-modal`, so repeating it on the content inside
  // would be two dialogs where there is one surface.
  role?: "menu" | "dialog";
  panelId?: string;
  testId?: string;
  // The sheet host's own testid, so `bottom-sheet` assertions elsewhere are not
  // caught by a menu (defaults to a menu-specific one).
  sheetTestId?: string;
  onPanelKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  // The mounted panel element, in EITHER presentation. A consumer that owns its
  // own outside-click handling needs to know what counts as inside.
  panelRef?: React.RefObject<HTMLElement | null>;
  align?: AnchoredAlign;
  fallbackWidth?: number;
  // POPOVER-ONLY geometry (width, padding). The sheet's width is the screen's.
  panelClassName?: string;
  popoverZIndexClass?: string;
  sheetZIndexClass?: string;
  // Draw the popover's click-away catcher. A field-owned panel says false and
  // keeps its own outside-click handling: a full-viewport catcher would swallow
  // the click that moves to the NEXT field instead of letting it land.
  backdrop?: boolean;
  // Mark the popover as the layer that answers Escape first, so a modal it is
  // open inside does not close underneath it (components/useFocusTrap.ts).
  // NEVER set on the sheet: the marker inside a sheet's own panel would make
  // that sheet's trap defer to itself and answer no Escape at all.
  escapeLayer?: boolean;
  remeasureKey?: unknown;
}) {
  const compact = useCompactViewport();
  const {
    panelStyle,
    measured,
    attachPanel,
    panelRef: popoverNodeRef,
  } = useAnchoredPopover({
    // Inert in the sheet presentation: no anchor to measure, no scroll listeners
    // to keep, nothing to reposition.
    open: open && !compact,
    anchorRef,
    align,
    fallbackWidth,
    remeasureKey,
  });

  // Keep the CONTENT constructed while the sheet plays its exit, so a closing
  // sheet does not slide away empty. This is not the sheet's presence — that is
  // BottomSheet's own, and it is what actually unmounts — it only decides when
  // `children()` is worth calling. Reduced motion is deliberately NOT consulted:
  // this timer gates construction, not animation, and a viewer who asked for no
  // motion gets the sheet unmounted immediately by BottomSheet regardless, which
  // takes the content with it.
  const { mounted } = usePresence(open, motionMs("sheet", false));

  // One ref callback for both jobs: the positioning hook measures on attach and
  // forgets on detach (which is what makes the next open start hidden), and the
  // consumer's ref follows the same element.
  const attach = useCallback(
    (node: HTMLElement | null) => {
      attachPanel(node);
      if (panelRef) panelRef.current = node;
    },
    [attachPanel, panelRef]
  );
  const attachSheet = useCallback(
    (node: HTMLElement | null) => {
      if (panelRef) panelRef.current = node;
    },
    [panelRef]
  );

  // Focus in on open, back to the opener on close — see the header. Keyed on
  // MEASURED rather than on `open`: the portal mounts `visibility: hidden` until
  // the positioner has placed it, and a hidden element cannot take focus in a
  // browser. (jsdom lets it, which is why the browser case in
  // e2e/sidebar-refit.spec.ts names the control focus actually lands on.)
  const focusIntoPanel = open && !compact && !!role && measured;
  useEffect(() => {
    if (!focusIntoPanel) return;
    const panel = popoverNodeRef.current;
    if (!panel) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    (focusablesIn(panel)[0] ?? panel).focus({ preventScroll: true });
    return () => {
      // A menu action can delete the row its trigger stood in; useFocusTrap
      // guards the same way.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [focusIntoPanel, popoverNodeRef]);

  // Escape closes the popover, matching its click-away catcher. The SHEET needs
  // nothing here: useFocusTrap answers Escape inside it, on the capture phase,
  // so this listener would only be a second voice saying the same thing.
  useEffect(() => {
    if (!open || compact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, compact]);

  if (compact) {
    // Nothing is mounted while the panel is closed. A phone renders a hundred ⋯
    // triggers on a long list and each one owns an AnchoredPanel; a BottomSheet
    // instance per row would run that many media-query subscriptions and focus
    // hooks to render null. The presence latch above is what lets this unmount
    // and still play an exit — it holds the host mounted for the sheet's own
    // travel and drops it after.
    if (!mounted) return null;
    return (
      <BottomSheet
        open={open}
        onClose={onClose}
        title={title}
        // An anchored panel's sheet title is the name of the ROW it came from
        // (#3501), so its length is the row's, not the copywriter's. One line,
        // ellipsised — declared here, for every ⋯ panel at once, rather than by
        // each of the thirty callers that mount one.
        titleTruncates
        testId={sheetTestId ?? "anchored-panel-sheet"}
        {...(sheetZIndexClass ? { zIndexClass: sheetZIndexClass } : {})}
      >
        <div
          ref={attachSheet}
          id={panelId}
          role={role === "dialog" ? undefined : role}
          data-testid={testId}
          data-anchored-panel="sheet"
          onKeyDown={onPanelKeyDown}
          className="pb-1"
        >
          {mounted ? children() : null}
        </div>
      </BottomSheet>
    );
  }

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <>
      {backdrop && (
        <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      )}
      <div
        ref={attach}
        id={panelId}
        role={role}
        // A dialog owes a name and the popover draws no heading to take one from
        // (the sheet does). A menu's name is its trigger's and is not repeated.
        aria-label={role === "dialog" ? title : undefined}
        // The landing spot when a panel has no focusable content of its own.
        tabIndex={role ? -1 : undefined}
        data-testid={testId}
        data-anchored-panel="popover"
        data-escape-layer={escapeLayer ? "true" : undefined}
        onKeyDown={onPanelKeyDown}
        style={panelStyle}
        className={`${popoverZIndexClass} overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border border-black/10 bg-surface shadow-lg dark:border-white/10 ${panelClassName}`}
      >
        {children()}
      </div>
    </>,
    document.body
  );
}

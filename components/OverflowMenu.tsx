"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { IconDots } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useConfirmOpen } from "@/components/ConfirmDialog";
import { useLatestRef } from "@/components/useLatestRef";

// Shared kebab (⋯) overflow menu used by the goals and supplement cards and the
// extracted-observations table. The caller owns the open state (so it can also lift
// its card's z-index while the menu is open) and passes it in controlled — this
// component renders the trigger, click-away backdrop, and panel.
//
// The panel is portaled to <body> and positioned `fixed` from the trigger's
// bounding rect, so it's never clipped by an `overflow` ancestor (e.g. a table
// inside a max-h scroll container). It right-aligns under the trigger, flips
// above when there isn't room below, and follows scroll/resize while open.
export const MENU_ITEM =
  "block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-800";
export const MENU_ITEM_DANGER =
  "block w-full px-3 py-1.5 text-left text-sm text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950";

const MENU_WIDTH = 160; // matches w-40
const GAP = 4;
const MARGIN = 8; // keep the panel this far from the viewport edges

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
}

export default function OverflowMenu({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: (helpers: MenuHelpers) => ReactNode;
}) {
  const toast = useToast();
  const confirmOpen = useConfirmOpen();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // null until measured; kept hidden until then so the panel never paints at a
  // stale position.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const close = () => {
    setPos(null);
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

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const mh = menu?.offsetHeight ?? 0;
    const mw = menu?.offsetWidth ?? MENU_WIDTH;
    // Below the trigger by default; flip above when it wouldn't fit and there's
    // more room up top.
    let top = r.bottom + GAP;
    if (top + mh > window.innerHeight - MARGIN && r.top - GAP - mh > MARGIN)
      top = r.top - GAP - mh;
    // Right-align to the trigger, clamped into the viewport.
    let left = r.right - mw;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - mw - MARGIN));
    setPos({ top, left });
  }, []);

  // The portal node entering the DOM is the event that makes measurement possible.
  // Measure from that ref callback before the panel becomes visible; subsequent
  // scroll/resize callbacks keep it aligned.
  const attachMenu = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node;
      if (node) reposition();
    },
    [reposition]
  );

  // Track scroll (in any ancestor, hence capture) and resize while open.
  useLayoutEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

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
  // popover, and it is stale the moment something the user must answer opens over
  // it. `close()` is called through a ref so the effect keys on the STATE, not on
  // a callback whose identity changes every render.
  const closeRef = useLatestRef(close);
  useEffect(() => {
    if (open && confirmOpen) closeRef.current();
  }, [open, confirmOpen, closeRef]);

  // Escape closes, matching the click-away backdrop.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) close();
          else {
            // A new open episode must measure before painting; never reuse the
            // previous episode position while the portal ref is attaching.
            setPos(null);
            onOpenChange(true);
          }
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
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            {/* click-away backdrop */}
            <div className="fixed inset-0 z-40" onClick={close} />
            <div
              ref={attachMenu}
              role="menu"
              style={{
                position: "fixed",
                top: pos?.top ?? 0,
                left: pos?.left ?? 0,
                visibility: pos ? "visible" : "hidden",
              }}
              className="z-50 w-40 overflow-hidden rounded-lg border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-ink-900"
            >
              {children({ close, runAction })}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}

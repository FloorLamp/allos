"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useFormStatus } from "react-dom";
import { IconDots, IconLoader2 } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useConfirmOpen } from "@/components/ConfirmDialog";
import { useLatestRef } from "@/components/useLatestRef";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import { overflowMenuLabel } from "@/lib/overflow-menu-label";

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
// row: fine under a mouse, under the 44px floor (#644; ruled one number on #3514)
// that the trigger below reaches with `.tap-target`. The floor is met where a
// finger is actually doing the tapping — 44px below `md`, where the sheet is, and
// 44px on a coarse pointer at any width above it (a tablet gets the popover and a
// thumb). That second number was `py-2.5`, a 40px row, written when the registry
// still said the floor was 40; #3514 ruled 44 and it moves with the rest.
// A fine pointer from
// `md` up keeps the compact desktop row. The two `md:` rules are keyed on
// MUTUALLY EXCLUSIVE pointer media, deliberately: a `md:py-1.5` sitting beside a
// `md:pointer-coarse:py-3` would leave which one wins to stylesheet order.
export const MENU_ITEM =
  "block w-full px-3 py-3 text-left text-sm text-slate-700 hover:bg-slate-50 md:pointer-fine:py-1.5 md:pointer-coarse:py-3 dark:text-slate-200 dark:hover:bg-ink-800";
export const MENU_ITEM_DANGER =
  "block w-full px-3 py-3 text-left text-sm text-rose-600 hover:bg-rose-50 md:pointer-fine:py-1.5 md:pointer-coarse:py-3 dark:text-rose-400 dark:hover:bg-rose-950";

type MenuSubmitProps = { children: ReactNode; pendingLabel?: ReactNode };

// A menu item that POSTS, and says so while it is posting. The panel is still up
// for the whole round trip (`runAction` below carries the measurement — its close
// is a transition update that does not commit until the action settles), so this
// spinner is the only answer a kebab write gives to "did my tap land?" until the
// toast arrives. Reachable at every one of its mounts; #2641 planned to delete it
// as unreachable, on a reading of `runAction` the browser does not agree with.
export function OverflowMenuSubmitItem({
  children,
  pendingLabel,
}: MenuSubmitProps) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      role="menuitem"
      disabled={pending}
      aria-busy={pending || undefined}
      className={`${MENU_ITEM} flex items-center gap-1.5`}
    >
      {pending && (
        <IconLoader2 className="size-4 motion-safe:animate-spin" aria-hidden />
      )}
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}

const MENU_WIDTH = 160; // matches w-40

// What a menu action may resolve with. `void` keeps the render-time message (the
// additive case). A RESULT lets the toast come from the write's OUTCOME instead of the
// stale render (#2133): a refusal (`ok: false`) toasts its error in the error tone, and
// a success may carry the state-named `message` the write actually performed.
export type MenuActionResult =
  void | { ok: true; message?: string } | { ok: false; error: string };

export interface MenuHelpers {
  close: () => void;
  // Run a menu item's server action, close the menu, and toast the outcome. The
  // close is REQUESTED before the await and TAKES EFFECT after it — see the
  // measurement below — so the order of the two statements is not the tap-time
  // paint it reads as.
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
  itemName,
  kind,
  open,
  onOpenChange,
  children,
  panelClassName = "w-40",
}: {
  // The DISPLAY NAME of the row these actions belong to — the medication, the
  // activity, the attention item — exactly as the row renders it. Required, and
  // required for a reason (#3501): the trigger's accessible name and the sheet's
  // heading are both built from it, and a sheet has detached from its row by the
  // time a viewer reads that heading. Not a finished sentence: the phrasing is
  // lib/overflow-menu-label.ts's, so it cannot drift across call sites.
  itemName: string;
  // The row's noun ("Medication", "Result", "More"), when the name alone would be
  // ambiguous on the surface. Optional; see the composer for why it exists.
  kind?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: (helpers: MenuHelpers) => ReactNode;
  panelClassName?: string;
}) {
  const label = overflowMenuLabel(itemName, kind);
  const toast = useToast();
  const confirmOpen = useConfirmOpen();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    onOpenChange(false);
  };
  // THE MENU DOES NOT CLOSE ON THE TAP, AND THIS IS WHERE IT WAS THOUGHT TO
  // (#2641 gap 2). Measured, because the sentence that used to stand here was the
  // opposite and a lot was built on it.
  //
  // `close()` is called before the `await`, so this reads as an optimistic paint:
  // the panel goes on the tap, the write settles afterwards. It is not one. A
  // form's `action` runs inside a React transition, and a state update made inside
  // an async transition — `onOpenChange(false)` reaching the caller's `useState` —
  // is not committed until the whole action settles. Writing `close()` first
  // changes when the close is REQUESTED, not when it is SEEN.
  //
  // What it actually looks like: /upcoming, a snooze whose Server Action POST is
  // held for five seconds. Two seconds in, the panel is still open with all four
  // items, and the tapped one is `aria-busy`, disabled and spinning. Identical to
  // the behaviour this comment claimed to have removed.
  //
  // SO THE PENDING AFFORDANCE IS THE ONE THING ANSWERING "DID MY TAP LAND?" —
  // `OverflowMenuSubmitItem` at the top of this file, at all ten of its mounts,
  // not the one it was measured at. #2641's phase-2 plan to delete it as dead
  // rests on the sentence that used to stand here;
  // it is not dead, and deleting it would leave every kebab write in the app with
  // no in-flight feedback at all for the length of the round trip. Making the
  // close actually land on the tap is a real change (it needs a paint outside the
  // transition, and it would then genuinely retire the affordance) — but it is a
  // change, not a comment, and nobody has made it.
  //
  // WHAT `runAction` DOES CARRY, and why every menu write still belongs on it: the
  // outcome. A typed refusal toasts its own error, a throw toasts the failure
  // sentence, and both are raised from THIS component, which outlives the panel —
  // so nothing is confirmed unconditionally (the inline-action rule, #2133) and
  // the deploy-skew classification each action returns is untouched. A hand-rolled
  // `await action(fd); close();` gets none of that, which is what
  // components/illness/EpisodeControls.tsx lost until it moved here.
  const runAction: MenuHelpers["runAction"] = async (action, fd, message) => {
    close();
    let result: MenuActionResult;
    try {
      result = await action(fd);
    } catch {
      // An uncaught menu-action throw used to escalate to the route error
      // boundary (issue #477) — toast the failure instead.
      toast("Couldn't complete that action. Try again.", {
        tone: "error",
      });
      return;
    }
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
        aria-haspopup="menu"
        data-testid="overflow-menu-trigger"
        // THE CONTROL BOX, LIKE EVERY OTHER CONTROL (#4362 ruling 5, over #3938).
        // This rendered 40 (`h-10`) and was the one control that did not, which
        // #4362's fifth item found by measuring #4076's row invariant rather than
        // its acceptance criteria: a 40px trigger sat beside a 34px "Mark taken" in
        // 48 rows. No exception is minted for it — it reads `--control-box` so the
        // number cannot drift from the one the box owns.
        //
        // ≥44px EFFECTIVE hit box (#644, one number ruled on #3514) still holds and
        // holds by the same mechanism: `.tap-target`'s `inset: -6px` per side is a
        // fixed 12px, so 34 + 2×6 = 46 clears the floor exactly as 40 + 12 = 52 did.
        // The 32px variant the responsive-table surface shrinks it to carries its own
        // `::after` (app/globals.css, `.table-cards`), also at -6px, also reaching 44.
        className="tap-target flex h-(--control-box) w-(--control-box) items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-300"
      >
        <IconDots className="h-4 w-4" />
      </button>
      <AnchoredPanel
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        // The trigger's accessible name names the row these actions belong to
        // ("Medication actions for Amoxicillin", "Actions for Fermented foods"),
        // which is exactly the heading the sheet owes a viewer who can no longer
        // see the row it came from. Since #3501 that is not a convention this
        // comment asks call sites to keep — the name is composed here, from a
        // required `itemName`, and lib/__tests__/overflow-menu-identity.test.ts
        // fails when a caller hard-codes one.
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

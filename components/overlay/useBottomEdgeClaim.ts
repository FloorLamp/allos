"use client";

import { useEffect } from "react";
import { BOTTOM_EDGE_OFFSET_VAR } from "./tokens";

// Claim the bottom edge for a base-layer surface (issue #1520 part B, #2651).
//
// Hand it the ref of a fixed, bottom-anchored element and it publishes how far
// that element's TOP EDGE sits above the viewport bottom, into the
// `--bottom-edge-offset` custom property on `<html>`, for as long as it is
// mounted. Every surface styled with BOTTOM_EDGE_NOTICE_BOTTOM then sits ABOVE
// it instead of over it — and with no claimant the var is absent, so those
// surfaces resolve to their unchanged `max(1rem, safe-area)` inset.
//
// ── THE TOP EDGE, NOT THE HEIGHT ─────────────────────────────────────────────
//
// #1520 published `offsetHeight`, which was the same number while the workout
// dock was the only claimant and sat flush at `bottom-0`. #2651 put the phone's
// nav dock underneath it and lifted the workout dock clear of that bar, and the
// height stopped answering the question: a toast placed at "dock height" from
// the bottom landed squarely on a dock that now starts 56px higher up. The
// question was never "how tall is it" — it is "how much of the edge is already
// spoken for", and the top edge is that number whatever the surface is resting
// on.
//
// It is also what keeps this from becoming the slot manager #1520 rejected. A
// claimant already lifted clear of the one below it reports a distance that
// INCLUDES the one below, so composing claimants is a MAX and never a sum, and
// no claimant has to know that another exists.
//
// A custom property rather than React context because the claimants (the workout
// dock, mounted by ActivityEditorProvider; the nav dock, a sibling of <main>) are
// DESCENDANTS of the consumers (the toast stack + offline queue live above them
// in the tree) — there is no provider position that reaches all of them without
// hoisting state the surfaces don't otherwise share. CSS is already the shared
// medium here.
//
// The measured distance INCLUDES the claimant's own safe-area padding, so on
// hardware with a home indicator a notice clears that inset twice. That is extra
// clearance, never less, and it is not worth a second variable.
//
// A claimant that is not RENDERED — the nav dock is `md:hidden`, and a
// `display: none` element's rect is all zeros, which would otherwise read as "the
// whole viewport is claimed" — publishes nothing at all. A claimant that is
// bottom-anchored only at SOME widths says so with the `gateRef` argument below,
// which is the same rule applied to a second element.

// Module-scope, because the var is: it lives on `<html>` and there is exactly one
// of it. Keyed on the element so a claimant that unmounts withdraws only its own
// claim, and the survivors keep theirs.
const claims = new Map<HTMLElement, number>();

function publish(): void {
  const root = document.documentElement;
  let claimed = 0;
  for (const value of claims.values()) claimed = Math.max(claimed, value);
  if (claimed > 0) {
    root.style.setProperty(BOTTOM_EDGE_OFFSET_VAR, `${claimed}px`);
  } else {
    root.style.removeProperty(BOTTOM_EDGE_OFFSET_VAR);
  }
}

export function useBottomEdgeClaim<T extends HTMLElement>(
  // The claimant's own element. Passed IN rather than returned, because a host
  // that already holds its element's ref for other reasons — BottomSheet hands
  // the same panel to the focus trap and the drag recognizer — must not have to
  // merge two refs onto one node to claim as well.
  ref: React.RefObject<T | null>,
  {
    gate,
    mounted = true,
  }: {
    // AN ELEMENT WHOSE RENDERED BOX GATES THE CLAIM (#4334). A claimant whose
    // bottom anchoring is RESPONSIVE cannot answer "am I on the bottom edge right
    // now?" from its own box — BottomSheet's `dialog` presentation is a sheet
    // below `md` and a centred card above it, and the panel has a real box either
    // way. It already renders its DRAG HANDLE exactly when it is bottom-anchored
    // (`md:hidden` on the responsive presentation, never drawn on a centred card),
    // and it already treats that handle's rendered box as the DOM truth gating the
    // drag. Reusing the same element here means the two facts cannot drift into
    // two answers, and the breakpoint stays in the stylesheet — no JS width check,
    // no resize-listener race, no wrong first paint (#2305).
    //
    // Passing a gate at all means "claim only while the gate is rendered", so a
    // gate absent from the tree withdraws the claim rather than being ignored.
    gate?: React.RefObject<HTMLElement | null>;
    // Re-measure when the claimant's ELEMENT is replaced, not only when this hook
    // mounts. The docks render their bar for as long as they are mounted, so the
    // default is right for them; a sheet HOST mounts once and mounts/unmounts its
    // panel on every open, and without this it would have measured the first panel,
    // kept that panel's claim after it was gone, and never seen the next one.
    mounted?: boolean;
  } = {}
) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !mounted) return;
    const measure = () => {
      const gateEl = gate ? gate.current : el;
      // `display: none` (the nav dock above `md`) — no rendered box, no claim.
      // Same rule applied to the gate, which is how a responsive claimant stops
      // claiming at the width where it stops being bottom-anchored.
      if (
        el.offsetHeight === 0 ||
        !gateEl ||
        gateEl.getClientRects().length === 0
      ) {
        claims.delete(el);
      } else {
        // THE RESTING TOP EDGE, NOT THE ANIMATED ONE (#4334, #4796). A surface
        // that ARRIVES carries a `translateY` while it does, and
        // `getBoundingClientRect` reads the TRANSFORMED box — the edge it is
        // sliding up FROM. Publishing that is the UNSAFE direction: for the
        // whole arrival the edge reads as LESS claimed than it is about to be,
        // so a notice raised in that window comes to rest on the panel, which is
        // the collision this exists to prevent. Discounting the element's own
        // transform publishes the edge it comes to REST on, from its first
        // frame. Overlay motion is transform/opacity only (app/globals.css,
        // pinned by lib/__tests__/overlay-motion-chokepoint.test.ts), so the
        // element's own transform is exactly its animation and a claimant at
        // rest carries none.
        const { transform } = getComputedStyle(el);
        // `none` is not a <transform-list>, so it is not DOMMatrix's to parse.
        const shift =
          transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
        const top = el.getBoundingClientRect().top - shift;
        claims.set(el, Math.max(0, window.innerHeight - top));
      }
      publish();
    };
    measure();
    // The claim can change after mount without the element being replaced: a
    // label wraps, a font lands, the viewport rotates past a breakpoint. A stale
    // offset leaves a visible gap or an overlap — the exact thing this exists to
    // prevent. ResizeObserver catches the element's own growth; the window
    // listener catches a rotation or a breakpoint crossing, where the element's
    // box may not change at all while its distance from the bottom does.
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      claims.delete(el);
      publish();
    };
  }, [ref, gate, mounted]);
}

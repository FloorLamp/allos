"use client";

import { useEffect, useRef } from "react";
import { BOTTOM_EDGE_OFFSET_VAR } from "./tokens";

// Claim the bottom edge for a base-layer surface (issue #1520 part B, #2651).
//
// Attach the returned ref to a fixed, bottom-anchored element and it publishes
// how far that element's TOP EDGE sits above the viewport bottom, into the
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
// whole viewport is claimed" — publishes nothing at all.

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

export function useBottomEdgeClaim<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // `display: none` (the nav dock above `md`) — no rendered box, no claim.
      if (el.offsetHeight === 0) {
        claims.delete(el);
      } else {
        const top = el.getBoundingClientRect().top;
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
  }, []);
  return ref;
}

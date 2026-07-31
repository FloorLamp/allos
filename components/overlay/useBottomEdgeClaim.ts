"use client";

import { useEffect, useRef } from "react";
import { BOTTOM_EDGE_OFFSET_VAR } from "./tokens";

// Claim the bottom edge for a base-layer surface (issue #1520, part B).
//
// Attach the returned ref to a fixed, bottom-anchored element and it publishes
// that element's height into the `--bottom-edge-offset` custom property on
// `<html>` for as long as it is mounted, removing it on unmount. Every surface
// styled with BOTTOM_EDGE_NOTICE_BOTTOM then sits ABOVE it instead of over it —
// and with no claimant the var is absent, so those surfaces resolve to their
// unchanged `max(1rem, safe-area)` inset.
//
// A custom property rather than React context because the claimant (the workout
// dock, mounted by ActivityEditorProvider) is a DESCENDANT of the consumers (the
// toast stack + offline queue live above it in the tree) — there is no provider
// position that reaches all four without hoisting state the surfaces don't
// otherwise share. CSS is already the shared medium here.
//
// The measured height INCLUDES the claimant's own safe-area padding, so on
// hardware with a home indicator a notice clears that inset twice. That is extra
// clearance, never less, and it is not worth a second variable.
//
// ONE claimant at a time (documented in tokens.ts): the last mount wins and the
// unmount clears. A second base-layer surface would need these summed — that is
// the line where this becomes the slot manager #1520 deliberately did not build.
export function useBottomEdgeClaim<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const apply = () =>
      root.style.setProperty(BOTTOM_EDGE_OFFSET_VAR, `${el.offsetHeight}px`);
    apply();
    // The claimant's height can change after mount (a label wraps, a font lands,
    // the viewport rotates), and a stale offset would leave a visible gap or an
    // overlap — the exact thing this exists to prevent.
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty(BOTTOM_EDGE_OFFSET_VAR);
    };
  }, []);
  return ref;
}

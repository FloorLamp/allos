"use client";

// The master/detail split (list beside panel on desktop, full-page takeover on
// mobile) happens at Tailwind's `lg`. Every JS check of that boundary must use
// this query so the pieces can't disagree.
export const LG_QUERY = "(min-width: 1024px)";

// The Explorer pages (Cardio/Sport/Strength) and the journal show a list beside
// a detail panel on desktop. On mobile the list can be long, so instead of
// stacking the detail far below it, a tapped row opens the detail as a
// full-page takeover (MobileDetailPage). This helper runs `open` only when the
// viewport is below the `lg` breakpoint, so desktop keeps its side-by-side
// layout untouched.
export function openDetailOnMobile(open: () => void) {
  if (typeof window !== "undefined" && !window.matchMedia(LG_QUERY).matches) {
    open();
  }
}

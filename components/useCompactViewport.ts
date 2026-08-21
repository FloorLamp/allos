"use client";

import { useSyncExternalStore } from "react";

// Is this a PHONE-WIDTH viewport — below Tailwind's `md`, the breakpoint every
// `md:` class in the app is written against?
//
// THE ONE IMPLEMENTATION of a question three surfaces already asked separately.
// `components/Toast.tsx` had `useSnackbarViewport` (which shape a toast takes),
// `app/(app)/trends/LogMeasurementsPanel.tsx` has its own inverted copy (which
// surface a deep link opens), and the anchored-panel fork (#3374/#3376) is the
// third — the point at which two near-copies become one shared hook, the same
// consolidation rule components/overlay/useAnchoredPopover.ts records for the
// positioning maths it took over.
//
// WHY A MEDIA QUERY IN JS AT ALL. A layout difference belongs in a `md:` class,
// and this hook is not for those. It answers a BEHAVIOUR question — which HOST a
// panel mounts in, which is one component or another, never two rendered copies
// with one hidden (#2305). A `hidden md:block` twin of a menu would be two
// action lists to keep in step; that is exactly what this exists to avoid.
//
// The server snapshot is false, so SSR and the first hydration pass agree on the
// desktop branch. Nothing reads the answer before an interaction — a panel is
// only ever consulted once its trigger has been pressed on the client — so there
// is no wrong first paint to correct.
const COMPACT_QUERY = "(max-width: 767.98px)";

// ONE MediaQueryList for the whole page, not one per subscriber. A table can
// render a hundred rows each owning a ⋯ menu, and each of those calls this hook;
// a fresh `matchMedia` per instance would be a hundred query objects answering
// one question. The listeners are still per-subscriber — that is what React's
// store contract needs — but they all hang off this.
let shared: MediaQueryList | null = null;

function query(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  shared ??= window.matchMedia(COMPACT_QUERY);
  return shared;
}

function subscribe(onChange: () => void): () => void {
  const mql = query();
  if (!mql) return () => {};
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  return query()?.matches ?? false;
}

const serverSnapshot = () => false;

export function useCompactViewport(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

"use client";

import { useSyncExternalStore } from "react";

// The channel between the root-layout update registrar and everything below it
// (#2471). Three signals, all of them bridges across a mount boundary no props or
// context can cross: `ServiceWorkerRegister` lives in `app/layout.tsx`, ABOVE the
// authenticated shell, its providers, and every form in the app.
//
// Same shape and same reasoning as `lib/offline/unsaved-work.ts`: module-level,
// content-free, one writer and at least one reader for each signal.
//
//   * STALE BUILD (trigger A). Produced by `useActivityAutosave` the moment a save
//     fails with the stale-action signature; read by the registrar's auto-reload
//     gate. Deliberately independent of the `/api/version` detector, so recovery
//     from a save failure still works in a tab whose poll has latched off — the
//     structural half of #2329's lesson, applied forward. Sticky, because nothing
//     this document does can make its build callable again.
//
//   * THE RELOAD ROUTINE. Registered by the registrar, called by the automatic path
//     AND by every manual affordance that survives (the "Update ready" bar, the
//     editor's stale-save banner). One reload path is what makes the resume marker
//     unconditional: #2155 establishes that a second machinery reload can legitimately
//     follow the first, and a marker written only at one call site would strand the
//     editor the other one reloaded.
//
//   * THE MANUAL FALLBACK FLAG. The registrar's verdict, published so a banner
//     rendered by a form can tell "the tab is about to fix this itself" from "the
//     automatic attempt is spent and you are the remedy". Without it the editor would
//     flash an ask-before banner during the few quiet seconds before the tab reloads
//     itself, which is the posture this issue removes.

let stale = false;
const staleListeners = new Set<() => void>();

/** A Server Action failed with the stale-action signature (`isStaleActionError`). */
export function reportStaleBuild(): void {
  if (stale) return;
  stale = true;
  for (const fn of staleListeners) fn();
}

export function isStaleBuild(): boolean {
  return stale;
}

export function subscribeStaleBuild(fn: () => void): () => void {
  staleListeners.add(fn);
  return () => {
    staleListeners.delete(fn);
  };
}

/**
 * Take the deploy, from wherever the request came from: flush every recoverable
 * draft, write the resume and toast markers, spend the ration, then reload through
 * the worker handshake the registrar owns. Resolves false when it refused (nothing
 * durable to reload over, or storage denied) — the caller then leaves the tab alone.
 */
export type UpdateReloadRoutine = () => Promise<boolean>;

let routine: UpdateReloadRoutine | null = null;

/** The registrar publishes its routine here for the whole tree. */
export function registerUpdateReload(fn: UpdateReloadRoutine | null): void {
  routine = fn;
}

/**
 * Ask for the shared reload. Falls back to a plain reload when no registrar is
 * mounted (the login tree, a unit-test render): a tab that cannot reach the shared
 * path must still be able to answer the user's tap, unprotected but never broken —
 * the same posture `useChromeRefresh` takes.
 */
export async function requestUpdateReload(): Promise<void> {
  if (routine) {
    const took = await routine();
    if (took) return;
  }
  window.location.reload();
}

let manualFallback = false;
const fallbackListeners = new Set<() => void>();

/** The registrar publishes whether the manual affordances may render. */
export function setManualUpdateFallback(live: boolean): void {
  if (manualFallback === live) return;
  manualFallback = live;
  for (const fn of fallbackListeners) fn();
}

export function manualUpdateFallbackLive(): boolean {
  return manualFallback;
}

export function subscribeManualUpdateFallback(fn: () => void): () => void {
  fallbackListeners.add(fn);
  return () => {
    fallbackListeners.delete(fn);
  };
}

/** Test seam: forget everything (no production caller). */
export function resetUpdateReloadChannel(): void {
  stale = false;
  routine = null;
  manualFallback = false;
}

/** React binding for the flag above, for a banner rendered anywhere in the tree. */
export function useManualUpdateFallback(): boolean {
  return useSyncExternalStore(
    subscribeManualUpdateFallback,
    manualUpdateFallbackLive,
    // Server render: the automatic path has not run, so nothing is a fallback yet.
    () => false
  );
}

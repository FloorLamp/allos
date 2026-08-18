"use client";

import { useEffect } from "react";

// Lock the page behind a full-screen surface while `active`: without it,
// (over)scroll chains to the document and the covered page drifts around
// underneath.
//
// REFERENCE-COUNTED, not save/restore (the PWA stuck-lock bug). The first
// version captured the body's previous inline overflow per hook instance and
// wrote it back on cleanup. That is correct only when locks release in strict
// LIFO order — and the app's overlays don't: a quick-log sheet row closes the
// sheet and opens the inner overlay in the SAME tick, but `usePresence` keeps
// the sheet mounted (lock held) through its exit animation, so the inner
// overlay's lock captured `prev = "hidden"`. The sheet's later cleanup unlocked
// the body UNDER the open overlay, and the overlay's cleanup then restored
// "hidden" onto a page with nothing on it. That end state is absorbing — every
// later lock faithfully captures and re-restores "hidden" — and it is what a
// stuck installed app looks like: the page cannot scroll, and pull-to-refresh
// (whose overlay clause reads exactly this style, lib/pull-to-refresh.ts) never
// arms again, so the one recovery gesture is dead too. Only a hard reload
// cleared it.
//
// A count is order-blind: the body is locked while ANY surface holds a lock and
// unlocked when the LAST holder releases, whatever the interleaving. Restoring
// to "" rather than a captured value is safe because this hook is the app's
// only writer of the body's INLINE overflow — the invariant
// components/PullToRefresh.tsx's `bodyScrollLocked` already leans on — so there
// is never a foreign value to preserve.
let lockHolders = 0;

export function useLockBodyScroll(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lockHolders += 1;
    document.body.style.overflow = "hidden";
    return () => {
      lockHolders -= 1;
      if (lockHolders === 0) document.body.style.overflow = "";
    };
  }, [active]);
}

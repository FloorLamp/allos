// Who is holding the page still, and therefore whether it is held (#2774).
//
// The PURE half of components/useLockBodyScroll.ts. It is here rather than
// inlined in the hook because the invariant it encodes is the one #2774 made
// mandatory before the hook could gain thirty-odd new callers: a dialog opened
// OVER an open sheet must leave the body locked when the INNER surface closes,
// in either closing order. That is a question about counting, not about the DOM,
// and the app's rule is that such a question has one computation with a test —
// lib/__tests__/scroll-lock.test.ts pins both orders.
//
// REFERENCE-COUNTED, not save/restore, and the difference is a shipped bug. The
// first version captured the body's previous inline overflow per holder and
// wrote it back on release, which is correct only when releases are strictly
// LIFO — and the app's overlays are not: a quick-log sheet row closes the sheet
// and opens the inner overlay in the SAME tick, but `usePresence` keeps the
// sheet mounted (holding its lock) through the exit animation, so the inner
// overlay captured `prev = "hidden"`. The sheet's later release unlocked the
// body UNDER the open overlay, and the overlay's release then restored "hidden"
// onto a page with nothing on it. That end state is ABSORBING — every later
// holder faithfully captures and re-restores "hidden" — and it is what a stuck
// installed app looks like: the page cannot scroll, and pull-to-refresh (whose
// overlay clause reads exactly this style, lib/pull-to-refresh.ts) never arms
// again, so the one recovery gesture is dead too. Only a hard reload cleared it.
//
// A count is ORDER-BLIND, which is the whole property: locked while ANY surface
// holds, unlocked when the LAST releases, whatever the interleaving.

export interface ScrollLockState {
  /** How many mounted surfaces are currently holding the page still. */
  holders: number;
}

export const EMPTY_SCROLL_LOCK: ScrollLockState = { holders: 0 };

export function acquireScrollLock(state: ScrollLockState): ScrollLockState {
  return { holders: state.holders + 1 };
}

// Clamped at zero so a double release — an effect cleanup running twice under
// StrictMode, a surface unmounted mid-transition — cannot drive the count
// NEGATIVE and leave the next genuine lock unable to reach 1.
export function releaseScrollLock(state: ScrollLockState): ScrollLockState {
  return { holders: Math.max(0, state.holders - 1) };
}

export function isScrollLocked(state: ScrollLockState): boolean {
  return state.holders > 0;
}

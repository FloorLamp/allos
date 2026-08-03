// Whether a click on a navigation link is a REPEAT of a navigation that link
// already started (issue #1956).
//
// The measured defect: a sidebar tap looked like it did nothing for seconds, so
// people tapped again. Instrumenting the click path showed the tap was never
// swallowed — `<Link>` intercepted it (`defaultPrevented === true`), the App
// Router issued the destination's RSC request ~20ms later and got a 200 back in
// well under 100ms. What was missing was any VISIBLE consequence: `(app)` ships
// no `loading.tsx` on purpose (see app/(app)/layout.tsx and issue #530), so the
// router transition has no Suspense boundary to reveal, renders the whole
// destination off-screen, and swaps only at commit. Until then the old page sits
// there completely unchanged.
//
// The second tap is what turns slow into stuck. Every tap dispatches a FRESH
// navigation, and React discards the transition render already in progress — so
// tapping once a second at a destination that takes ~1s to render restarts the
// render forever. Measured on the same box at 6x CPU throttle: Timeline commits
// in 7.1s from ONE tap and 10.1s from five, with five separate RSC requests in
// the trace. Impatience was the thing preventing the navigation from landing.
//
// So the affordance owes two things, and this module owns the second: while a
// link's own navigation is pending, further plain taps on it are suppressed
// rather than restarted.
//
// SUPPRESSED MEANS SUPPRESSED, NOT DISABLED. A modified click is how a person
// opens a route in a new tab or window, and it never touches the pending
// navigation in this one — so it must reach the browser untouched. Getting that
// wrong would trade a slow link for a link that can no longer be opened beside
// the current page, which is why the decision is pure and tested rather than
// four inline `&&`s in a click handler.

export type NavClickIntent = {
  /**
   * A navigation started by THIS link is still in flight — Next's
   * `useLinkStatus().pending`, which is set inside the same transition as the
   * navigate and clears however that transition ends (commit, abort, error).
   * Never a hand-rolled "I clicked and the pathname hasn't changed yet" timer:
   * that leaves the link permanently dead if the navigation never lands.
   */
  pending: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** `MouseEvent.button` — 0 is the primary button; 1 is middle-click. */
  button: number;
  /** The anchor's `target` attribute, or null when it carries none. */
  target: string | null;
};

/**
 * True when this click should be dropped because the link is already navigating
 * to the same place. The caller `preventDefault()`s on true, which is also how
 * `<Link>` is told to stand down (it runs the user `onClick` first and returns
 * early on `defaultPrevented`).
 *
 * False for every click that means something OTHER than "go there now":
 * cmd/ctrl/shift/alt-click and middle-click open a new tab or window, and an
 * anchor with a real `target` leaves this document entirely. Those are the same
 * conditions `<Link>` itself treats as "let the browser handle it".
 */
export function isDuplicateNavClick(intent: NavClickIntent): boolean {
  if (!intent.pending) return false;
  if (intent.button !== 0) return false;
  if (intent.metaKey || intent.ctrlKey || intent.shiftKey || intent.altKey) {
    return false;
  }
  if (intent.target && intent.target !== "_self") return false;
  return true;
}

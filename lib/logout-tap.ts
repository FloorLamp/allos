// THE PRE-HYDRATION LOG OUT TAP (#3515), and why this file exists at all.
//
// PURE — no JSX, no React, no DOM at module scope. The boot script below is a STRING of
// source that runs from the document <head> before any bundle has landed; the component
// that consumes what it records is components/SidebarContent.tsx. Same shape, and the
// same reason, as THEME_BOOT_SCRIPT (lib/theme.ts) and DISCLOSURE_BOOT_SCRIPT
// (lib/disclosure-memory.ts): a state that must be right BEFORE the bundle cannot wait
// for the bundle.
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────────────────
//
// Every other form in this app has a progressive-enhancement fallback. `<form
// action={serverAction}>` with `type="submit"` — the login form two routes away — carries
// a real `action` attribute in the server HTML, so a tap that lands before React attaches
// still posts natively. Log out has none of that, and each of the three reasons is
// individually deliberate:
//
//   * `type="button"`, so the browser will not submit the form natively. #2908 made it
//     that way ON PURPOSE: as a submit button the async IndexedDB wipe raced the
//     navigation and lost, leaving one login's device-local PHI — a med list, a dose
//     schedule, readable session-free at /offline — sitting there for the next person.
//   * `onClick` is a React handler, and it is not attached yet.
//   * the form's `action` is a CLIENT function, so React SSRs no usable action attribute
//     for the browser to post to on its own.
//
// So a tap in the hydration window produced NO submit, NO POST, NO navigation and NO
// error. The person is still signed in, the control never said otherwise, and the mental
// model they walk away with is "I logged out" — on a device they may be handing back.
// That is the half that is indefensible independent of how narrow the window is.
//
// ── WHICH SURFACE THAT WINDOW IS ON: `md` AND UP, AND NOT A PHONE ─────────────────────
//
// Written down because the first version of this file framed the stake as a phone, and a
// phone is the one viewport it does not describe. The Log out control reaches the SERVER
// HTML from exactly one place: the desktop sidebar in app/(app)/layout.tsx, whose
// `<aside>` is `hidden … md:flex`. Below `md` that aside is `display:none`, so there is
// nothing there to tap. The mobile drawer renders the same SidebarContent, but through a
// `createPortal` gated on `drawer.mounted` (components/MobileNav.tsx) — client state that
// is false on the first render — so the drawer is in no server HTML at all, and opening
// it already requires the bundle. e2e/smoke.mobile.spec.ts pins that the drawer is the
// only route to Log out on a phone.
//
// So below `md` there is no pre-hydration tap to queue, and the phone's version of "I
// tapped Log out and nothing happened" is a DIFFERENT defect with a different shape: not
// a tap that was swallowed, but a control that is unreachable until the bundle lands,
// behind a hamburger that is equally unreachable. Nothing here addresses that, and
// nothing here should pretend to. e2e/logout-pre-hydration.spec.ts runs at the default
// desktop viewport for exactly this reason.
//
// ── WHAT THIS DOES INSTEAD (owner ruling, 2026-08-22) ─────────────────────────────────
//
// QUEUE THE TAP AND SHOW A PENDING STATE. One capture-phase listener, registered from the
// head before the control it serves even exists, records that the tap happened on the
// element itself; the component fires the queued logout the moment its effect runs, which
// is the first instant the handler could have run anyway. The person waits instead of
// being misled.
//
// #2908's wipe-before-navigation design is UNTOUCHED. This does not restore a native
// submit path and deliberately does not try to: option 2 in #3515 (a route handler doing
// the server-side destroy, with the wipe re-thought as recoverable and completed on the
// next load) is the only option that restores the guarantee the other forms have, and it
// was considered and declined for now. ACCEPTED RESIDUAL, stated so the next reader does
// not think this closes the window: if the device is put down or handed over before
// hydration completes, the queued logout still never fires. The window is NARROWED, not
// closed.
//
// ── WHY A LISTENER AND NOT A MutationObserver ─────────────────────────────────────────
//
// DISCLOSURE_BOOT_SCRIPT needs an observer because it must find nodes in a document that
// is still streaming. This one does not: a listener on `document` exists from the moment
// this runs and resolves its target at CLICK time via `closest()`, so the control can
// arrive whenever it likes. It is also the reason this is safe to register once from the
// root layout, where the control exists on no route at all until you are signed in.

/**
 * The marker the Log out control renders, the selector this script matches, and the CSS
 * hook the pending state keys off. ONE attribute with three readers, deliberately: a
 * second spelling of "this is the logout control" is a thing that can drift.
 */
export const LOGOUT_BUTTON_ATTR = "data-logout-button";

/**
 * Set on the control by the boot script when a tap lands with no handler behind it.
 * A `data-` attribute on purpose: React never renders this one, so hydration cannot
 * remove it and the pending pixels survive the bundle landing.
 */
export const LOGOUT_TAPPED_ATTR = "data-logout-tapped";

/**
 * Set by the component while a logout is actually in flight. The CSS treats it and
 * LOGOUT_TAPPED_ATTR identically — one appearance, whichever side of hydration the tap
 * landed on, which is the whole point: the person cannot tell, and should not have to.
 */
export const LOGOUT_PENDING_ATTR = "data-pending";

/** Whether a tap was captured on this control before its handler was live. */
export function hasQueuedLogoutTap(el: Element | null | undefined): boolean {
  return el?.hasAttribute(LOGOUT_TAPPED_ATTR) ?? false;
}

/**
 * Drop the queued-tap marker and its busy announcement. Called only when a logout that
 * started does NOT proceed — a wipe that throws, a submit that never leaves — so the
 * control stops claiming to be working on something it has given up on. The happy path
 * never calls this: it navigates away pending, which is honest.
 */
export function clearQueuedLogoutTap(el: Element | null | undefined): void {
  el?.removeAttribute(LOGOUT_TAPPED_ATTR);
  el?.removeAttribute("aria-busy");
}

/**
 * Runs in <head>, before any bundle. Registers ONE capture-phase click listener that
 * marks the Log out control as tapped and busy.
 *
 * CAPTURE PHASE so nothing between the control and the document can stop this from
 * seeing the tap. It does NOT preventDefault and does NOT stopPropagation: once React is
 * attached the same tap must still reach the real handler, and this listener then merely
 * records the same state that handler is about to set. Both markers mean "pending", so a
 * tap on either side of hydration paints identically.
 *
 * IT DOES NOT ITSELF LOG ANYONE OUT, and that is not an omission. Wiping this device's
 * PHI is an async IndexedDB transaction and destroying the session is a Server Action —
 * neither is available to an inline script in the head, and reaching for a bare
 * `form.submit()` here would re-open exactly the #2908 race this app closed at some cost.
 * The tap is RECORDED here and REPLAYED by the component.
 *
 * `aria-busy` is set alongside, so the state is announced and not merely drawn. React
 * renders the same attribute from its own pending state a moment later, which is why the
 * control carries `suppressHydrationWarning` — the server rendered no aria-busy, this
 * script added one, and that disagreement is the feature.
 */
export const LOGOUT_BOOT_SCRIPT = `
(function () {
  try {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      var btn = t.closest('[${LOGOUT_BUTTON_ATTR}]');
      if (!btn) return;
      btn.setAttribute('${LOGOUT_TAPPED_ATTR}', '');
      btn.setAttribute('aria-busy', 'true');
    }, true);
  } catch (e) {}
})();
`;

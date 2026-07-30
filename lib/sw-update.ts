// The page ↔ service worker update contract (issue #1700).
//
// THE DEFECT THIS REPLACES. public/sw.js called `skipWaiting()` in install and
// `clients.claim()` in activate, while activate deleted every cache that wasn't the
// new build's. Registration is versioned by commit sha, so a deploy reliably ran
// install → immediate activation → the new worker claiming already-open tabs and
// dropping the shell the loaded document was built against. A page mid-form could
// then fail to fetch a chunk it expected and go down, taking every bit of unsaved
// React state with it. The caching POLICY was careful; the activation TIMING was the
// bug. Nothing about a new build is urgent enough to interrupt work in progress.
//
// THE POSTURE NOW: wait, then offer. A new worker installs and waits. Open clients
// keep running the build they loaded. The page shows a calm, dismissible "Update
// ready — reload when you like", and the reload happens on the user's tap. Users who
// never tap get the new build on their next natural cold start, which is the common
// path anyway.
//
// This is the contact-consent rule in its ordinary shape: the system may REDUCE what
// it does to you unilaterally (waiting is strictly less intrusive), and it may OFFER;
// it may not take an action that costs you something without being asked.
//
// The decisions below are pure so they can be tested without a browser; the wiring
// is components/ServiceWorkerRegister.tsx and public/sw.js.

/** The one message the page sends the waiting worker. Mirrored in public/sw.js. */
export const SW_SKIP_WAITING = "allos-skip-waiting";

/**
 * How long the page waits for the worker handshake before reloading anyway.
 *
 * The tap IS the request to reload; the SKIP_WAITING round-trip is only how we
 * arrange for the reload to land on the NEW build. A waiting worker can go stale
 * between the offer and the tap — the browser may have replaced or discarded it —
 * and when that happens the handshake never answers. Leaving the user's tap
 * unanswered is the one outcome the button must not have, so the reload proceeds on
 * its own timer. It is still exactly one reload (the same guard covers both paths),
 * and it is still nothing the user did not ask for.
 */
export const SW_RELOAD_FALLBACK_MS = 1500;

/**
 * Whether a waiting worker is an UPDATE worth offering.
 *
 * `controlled` is the discriminator: a waiting worker on an already-controlled page
 * is a new build queued behind the running one — offer it. A worker installing on a
 * page with no controller is the FIRST install (or a hard-reloaded page); there is
 * no running build to replace, nothing for the user to decide, and no reason to
 * interrupt them with a banner.
 */
export function shouldOfferUpdate({
  waiting,
  controlled,
}: {
  waiting: boolean;
  controlled: boolean;
}): boolean {
  return waiting && controlled;
}

/**
 * Whether THIS tab should reload when the controller changes.
 *
 * Two guards, each closing a real failure:
 *
 *   - `requestedByThisTab` — activation is registration-wide, so the tab that tapped
 *     Reload activates the new worker for EVERY open tab, and they all get
 *     `controllerchange`. Only the tab that asked may reload; a second tab sitting on
 *     a half-filled form must not be reloaded because someone tapped in the first.
 *     That is precisely the "never auto-reload mid-form" rule, and it is the case
 *     the naive `controllerchange → location.reload()` recipe gets wrong.
 *   - `alreadyReloaded` — the classic loop guard. Reload at most once per activation.
 */
export function shouldReloadOnControllerChange({
  requestedByThisTab,
  alreadyReloaded,
}: {
  requestedByThisTab: boolean;
  alreadyReloaded: boolean;
}): boolean {
  return requestedByThisTab && !alreadyReloaded;
}

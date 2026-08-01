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
// ONE UPDATE-PENDING STATE (issue #1795). A deploy used to raise TWO notices from two
// detectors: this one, and a separate `/api/version` COMMIT_SHA poll that rendered its
// own inline banner with its own Refresh button — a plain `location.reload()` that
// never messaged the waiting worker, so the bar re-offered the update the user had
// just taken. Both detectors survive; the second surface does not. The waiting worker
// is the PRIMARY signal wherever a worker exists, because it is the thing that decides
// which build a reload lands on. The sha poll is the FALLBACK detector for contexts
// with no worker at all (blocked in private mode, unsupported, failed registration,
// development) — and it feeds the same state, which one component renders as one bar.
//
// The decisions below are pure so they can be tested without a browser; the wiring
// is components/ServiceWorkerRegister.tsx, components/useDeployedVersion.ts and
// public/sw.js.

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

/**
 * How often a tab asks whether a new build exists.
 *
 * ONE cadence for both detectors (#1795): where a worker exists the tick is
 * `registration.update()`, and where none does it is a `/api/version` read. The
 * interval is inherited from the sha poll this unification absorbed — a deploy is
 * never urgent, and a minute is fast enough that someone who alt-tabs back finds
 * the offer already up.
 */
export const UPDATE_CHECK_MS = 60_000;

/** What the page knows about its service worker, once registration has answered. */
export type ServiceWorkerStatus = "probing" | "active" | "unavailable";

/** Which detector answers "has a new build shipped?" in this context. */
export type DeployDetector = "service-worker" | "version-poll" | "none";

/**
 * Pick the ONE detector for this context (#1795).
 *
 * The worker wins wherever it exists: its waiting state is not merely a signal that
 * a deploy happened, it is the mechanism that governs which build a reload lands on,
 * so a notice driven by it can always be resolved by the handshake. The sha poll is
 * for contexts where that mechanism is absent — private mode, an unsupported browser,
 * a registration that failed, or development (where the registrar deliberately
 * unregisters). Running both at once is what produced two notices for one deploy.
 *
 * `probing` runs neither: registration has not answered yet, and a poll started in
 * that window would race the worker for the same event.
 */
export function deployDetectorFor(status: ServiceWorkerStatus): DeployDetector {
  if (status === "active") return "service-worker";
  if (status === "unavailable") return "version-poll";
  return "none";
}

/** The single answer to "is an update pending, and what is it?" (#1795). */
export type UpdateState = {
  pending: boolean;
  /** The deployed commit's message, when the server has named a build we are not on. */
  commitMessage: string | null;
};

/**
 * Merge both detectors into ONE pending state.
 *
 * Either signal alone means an update is pending, and both together still mean one
 * pending update — the whole point of the merge is that a deploy which trips both
 * (a new COMMIT_SHA *and* a new `sw.js?v=<sha>`) produces one notice, not two.
 *
 * The commit message is only claimed when the server has actually named a DIFFERENT
 * build. A waiting worker on its own says an update exists but not what it is (the
 * worker carries no commit metadata), and the running server's own message would
 * describe the build the user is already on — so the bar stays silent about the
 * contents rather than misreporting them.
 */
export function resolveUpdateState({
  swWaiting,
  baselineSha,
  deployedSha,
  deployedMessage,
}: {
  swWaiting: boolean;
  baselineSha: string | null;
  deployedSha: string | null;
  deployedMessage: string | null;
}): UpdateState {
  const deployAhead = Boolean(
    baselineSha && deployedSha && deployedSha !== baselineSha
  );
  return {
    pending: swWaiting || deployAhead,
    commitMessage: deployAhead ? deployedMessage : null,
  };
}

/**
 * The ONE reload mechanic, in its two shapes (#1795).
 *
 * `handshake` — a worker is waiting, so the reload must resolve it: post SKIP_WAITING,
 * reload on the controller change, and fall back to reloading anyway on the timer
 * above. A plain reload here is the defect this issue is about: the page comes back on
 * the old build with the worker still waiting, and the offer returns immediately.
 *
 * `plain` — no worker is waiting (the fallback detector's context, or a worker that
 * has already been resolved), so there is nothing to hand over to and a reload is
 * simply a reload.
 */
export function reloadPlanFor({
  waitingWorker,
}: {
  waitingWorker: boolean;
}): "handshake" | "plain" {
  return waitingWorker ? "handshake" : "plain";
}

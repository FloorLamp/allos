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
 * What to do about a worker that is WAITING behind this page (#1905).
 *
 * THE LOOP THIS CLOSES. A manual browser refresh (F5, pull-to-refresh) fetches the
 * new build's HTML and assets over the network — but a refresh never activates a
 * WAITING service worker. Platform behaviour: only the skip-waiting handshake, or
 * closing every tab of the origin, does that. So the fresh load ends up behind the
 * new build's pending worker and re-offers, and the bar comes back offering an
 * "update" to a page that is already running the new build. Forever, until the
 * user taps the bar's own Reload. Only the WORKER path loops this way; the sha
 * fallback's baseline is the freshly-served sha, so a refresh self-clears it.
 *
 * WHEN THE WORKER ARRIVED IS NOT PART OF THE QUESTION. The first cut of this fix
 * keyed on `registration.waiting` being present when registration answered, and
 * missed the commoner shape of the same loop: on the FIRST load after a deploy the
 * new worker is usually not waiting YET, because this page's own
 * `register("/sw.js?v=<new sha>")` call is what tells the browser a deploy happened
 * at all (the update tick refetches the OLD versioned URL, whose bytes a deploy
 * does not change). That worker installs seconds after load and lands through
 * `updatefound` — a "mid-session" install in the platform's eyes, raised by a page
 * that already IS the new build. Offering it re-created the loop this decision
 * exists to close, one refresh later than before.
 *
 * THE DISCRIMINATOR is therefore only the sha the document was served with against
 * the sha the server reports, for every waiting worker however it arrived. Equal
 * means the page already HAS the new build's assets and the waiting worker is
 * merely queued to take over subsequent fetches — nothing to decide, nothing to
 * reload, so activate it silently and never raise the bar. Different means the
 * running document genuinely predates the deploy, which is the bar's whole charter
 * (#1700). The comparison is only as honest as the read is fresh: the caller
 * re-arms the read for each newly-waiting worker (see `useDeployedVersion`'s
 * `generation`), so a second deploy under the same open page is never judged
 * against the answer read for the first.
 *
 * `wait` is the third answer and not a hedge: the sha read is a round-trip, and
 * offering before it lands would flash the bar on every first load after a deploy.
 * It resolves as soon as that one read settles either way. When the read settles
 * with no answer at all — /api/version is session-gated, so an anonymous tab can
 * never learn the deployed sha — we `offer`, which is the behaviour that shipped;
 * silence is not something to invent for a context we cannot evaluate.
 */
export type WaitingWorkerPlan = "activate-silently" | "offer" | "wait";

export function waitingWorkerPlan({
  pageSha,
  deployedSha,
  deployedSettled,
}: {
  /** The commit this document was served with. */
  pageSha: string | null;
  /** The commit the server reports, once it has answered. */
  deployedSha: string | null;
  /** The one sha read has finished, with or without an answer. */
  deployedSettled: boolean;
}): WaitingWorkerPlan {
  // No baseline, nothing to compare — the page cannot claim to be on the new build.
  if (!pageSha) return "offer";
  if (!deployedSettled) return "wait";
  if (!deployedSha) return "offer";
  return deployedSha === pageSha ? "activate-silently" : "offer";
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

// ---------------------------------------------------------------------------
// DEPLOYMENT SKEW (issue #1906)
//
// A pending update means a deploy happened, and this tab is still running the OLD
// build. The deploy removed that build's hashed chunks from the server, so a client
// navigation to a route this tab has NOT visited fetches a chunk that no longer
// exists: 404, and a throw above the route group. The worker's cache-first asset
// policy protects only what was already fetched — unvisited routes are the
// unprotected set, deliberately, because deferring activation is what keeps the
// loaded document alive at all (#1700).
//
// That failure has exactly one recovery: a HARD load, which lands on the new build
// and always works. Re-rendering the same stale runtime cannot help, and neither can
// any soft navigation. So the error boundary asks this module — the same module the
// registrar asks about the same deploy — whether what it caught is that known state,
// and recovers before it renders anything.
// ---------------------------------------------------------------------------

/**
 * Where the registrar records "an update is pending" for the error boundary.
 *
 * The two live on opposite sides of a crash: `app/global-error.tsx` replaces the
 * ROOT LAYOUT, so `ServiceWorkerRegister` is not mounted when the boundary needs the
 * answer and no amount of props or context can reach it. sessionStorage is the right
 * shape for the handoff — per-tab, exactly like the state it describes, and gone when
 * the tab is.
 */
export const UPDATE_PENDING_KEY = "allos-update-pending";

/** The marker's shape lives here so the writer and the reader cannot disagree. */
export const UPDATE_PENDING_MARKER = "1";

export function updatePendingFromMarker(
  raw: string | null | undefined
): boolean {
  return raw === UPDATE_PENDING_MARKER;
}

/**
 * Error signatures that mean "this build's assets are gone", not "something broke".
 *
 * Deliberately narrow. A bare "Failed to fetch" is every network error there is and
 * must NOT match: mistaking an ordinary failure for skew would turn the error card
 * into a reload, which is a worse answer for a user whose connection dropped. Every
 * entry here is a loader-specific message from a browser or a bundler, matched
 * case-insensitively because they are not spelled the same across engines.
 */
const SKEW_SIGNATURES = [
  "chunkloaderror",
  "loading chunk",
  "loading css chunk",
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "unable to preload css",
  "failed to fetch rsc payload",
];

export function isDeploymentSkewError(
  error: { name?: string; message?: string } | null | undefined
): boolean {
  if (!error) return false;
  const haystack = `${error.name ?? ""} ${error.message ?? ""}`.toLowerCase();
  return SKEW_SIGNATURES.some((signature) => haystack.includes(signature));
}

/**
 * THE LOOP GUARD, which is the load-bearing part of this fix.
 *
 * Recovering skew means a hard load, and a hard load that fails the same way is an
 * infinite redirect — strictly worse than the error card it was trying to avoid, and
 * invisible to the user because no card ever stays on screen. So recovery is
 * RATIONED, not merely flagged: at most `SKEW_RECOVERY_MAX_ATTEMPTS` per tab per
 * window, counted from the first attempt in that window.
 *
 * A window rather than a permanent flag because the two failure modes need opposite
 * answers. A genuine spin retries immediately, so a window of a minute caps it at one
 * reload and then hands the user the card — it cannot spin. A second, unrelated skew
 * an hour later (another deploy, another unvisited route) is a fresh episode and
 * deserves its own recovery, which a permanent flag would deny forever.
 *
 * Note what is NOT here: the guard is never cleared by a page that loads
 * successfully. That was the tempting version, and it is the spinning one — a worker
 * serving a cached old document loads "successfully" every time, clearing the guard
 * on every pass.
 */
export const SKEW_RECOVERY_KEY = "allos-skew-recovery";
export const SKEW_RECOVERY_WINDOW_MS = 60_000;
export const SKEW_RECOVERY_MAX_ATTEMPTS = 1;

export type SkewRecoveryGuard = {
  /** Attempts made so far in this window. */
  attempts: number;
  /** When the window opened — the first attempt's timestamp, not the last. */
  at: number;
};

/** Read the stored guard. Anything unparseable is "no guard", never a throw. */
export function parseSkewGuard(
  raw: string | null | undefined
): SkewRecoveryGuard | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { attempts, at } = parsed as Record<string, unknown>;
    if (typeof attempts !== "number" || typeof at !== "number") return null;
    if (!Number.isFinite(attempts) || !Number.isFinite(at)) return null;
    return { attempts, at };
  } catch {
    return null;
  }
}

/** Attempts that still count — a window that has aged out counts for nothing. */
function attemptsInWindow(
  guard: SkewRecoveryGuard | null,
  now: number
): number {
  if (!guard) return 0;
  const age = now - guard.at;
  if (age < 0 || age > SKEW_RECOVERY_WINDOW_MS) return 0;
  return guard.attempts;
}

/** The guard to store when taking an attempt. Opens a new window when the old aged out. */
export function nextSkewGuard(
  guard: SkewRecoveryGuard | null,
  now: number
): SkewRecoveryGuard {
  const counted = attemptsInWindow(guard, now);
  if (counted === 0 || !guard) return { attempts: 1, at: now };
  return { attempts: counted + 1, at: guard.at };
}

/**
 * What the top-level error boundary should do (#1906).
 *
 * `hard-reload` only when all three hold: an update is pending (so a deploy really
 * did happen under this tab), the error looks like a missing build asset, and the
 * guard has an attempt left. Anything else renders the card, which remains the honest
 * answer for an ordinary crash and the terminus for a reload that did not help.
 */
export function skewRecoveryPlan({
  error,
  updatePending,
  guard,
  now,
}: {
  error: { name?: string; message?: string } | null | undefined;
  updatePending: boolean;
  guard: SkewRecoveryGuard | null;
  now: number;
}): "hard-reload" | "render-card" {
  if (!updatePending) return "render-card";
  if (!isDeploymentSkewError(error)) return "render-card";
  if (attemptsInWindow(guard, now) >= SKEW_RECOVERY_MAX_ATTEMPTS) {
    return "render-card";
  }
  return "hard-reload";
}

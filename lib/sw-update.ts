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
// just taken. Both detectors survive; the second SURFACE does not. `resolveUpdateState`
// merges the two signals into one `pending`, and one component renders one bar.
//
// DETECTION AND RESOLUTION ARE DIFFERENT JOBS (issue #2329). #1795 also made the two
// detectors mutually exclusive — the worker "wins wherever it exists" — and that half
// was wrong, because a waiting worker is the mechanism that RESOLVES an update, not a
// detector that can NOTICE one. For an already-open tab it structurally cannot notice:
// `public/sw.js` reads its version from its own URL, so a deploy changes not one byte
// of the script; `registration.update()` refetches the URL this document registered
// and installs nothing; and nothing re-registers an open tab. So the tab with a worker
// had no working detector at all, which is the tab the bar exists for. The sha poll
// now runs wherever there is a baseline to compare against — worker or not — and the
// waiting worker keeps its real job: governing which build a reload lands on.
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
 * ONE guard: `requestedByThisTab`. Activation is registration-wide, so the tab that
 * tapped Reload activates the new worker for EVERY open tab, and they all get
 * `controllerchange`. Only the tab that asked may reload; a second tab sitting on a
 * half-filled form must not be reloaded because someone tapped in the first. That is
 * precisely the "never auto-reload mid-form" rule, and it is the case the naive
 * `controllerchange → location.reload()` recipe gets wrong.
 *
 * DELIBERATELY NOT GUARDED on "already reloaded" (#2155). The fallback timer can
 * beat the handshake: Chrome may hold a skip-waiting activation until the outgoing
 * active worker is idle, so the controller swap sometimes lands only AFTER
 * `SW_RELOAD_FALLBACK_MS` has already called `location.reload()`. That fallback
 * navigation was dispatched under the OLD worker, and a swap landing mid-flight can
 * strand it — the navigation never commits and the tab hangs on a page that will
 * never change (observed repeatedly under the e2e harness). Answering the
 * controllerchange again replaces the possibly-stranded navigation with one
 * dispatched under the NEW controller: same URL, idempotent, and it cannot loop —
 * `controllerchange` fires once per activation, a commit destroys this document and
 * the fresh one starts with `requestedByThisTab` false, and the fallback timer
 * itself stays guarded by the reloaded-once flag.
 */
export function shouldReloadOnControllerChange({
  requestedByThisTab,
}: {
  requestedByThisTab: boolean;
}): boolean {
  return requestedByThisTab;
}

/**
 * How often a tab asks the server whether a new build exists.
 *
 * ONE cadence, and since #2329 one asker: the `/api/version` sha read, in every
 * context that has a baseline to compare against. The interval is inherited from the
 * poll this constant was named for — a deploy is never urgent, and a minute is fast
 * enough that someone who alt-tabs back finds the offer already up.
 *
 * There is deliberately no `registration.update()` tick beside it any more (#2329):
 * it refetched a byte-identical script every minute per tab and could never install
 * anything, and a worker installed by ANOTHER tab still arrives here through
 * `updatefound`, which is scope-wide and independent of any tick.
 */
export const UPDATE_CHECK_MS = 60_000;

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
 * at all — a fresh DOCUMENT is the only thing that ever does, since the script's
 * bytes are identical across deploys (#2329). That worker installs seconds after
 * load and lands through
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
 * `plain` — no worker is waiting, so there is nothing to hand over to and a reload is
 * simply a reload. That is a context with no worker at all, a worker that has already
 * been resolved, and — since #2329 — the COMMON deploy shape: an open tab that
 * noticed the deploy through the sha poll has no waiting worker, because only a fresh
 * document ever discovers one. A plain reload is right there: navigations are served
 * network-first (public/sw.js never caches HTML), so it lands on the new build's HTML,
 * which references chunk URLs the old cache does not hold and therefore fetches fresh.
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
 * Error signatures that mean "this tab's build can no longer CALL the server" —
 * the Server Action half of deployment skew.
 *
 * A Server Action reference is compiled into the client bundle as a build-keyed
 * id. The moment a deploy lands, an open tab POSTs ids the new server has never
 * heard of; Next answers with its action-not-found marker
 * (`x-nextjs-action-not-found`) and the client throws `UnrecognizedActionError`
 * ("Server Action \"<id>\" was not found on the server"). Every write from that
 * tab fails the same way until it reloads — RETRYING IN PLACE CANNOT SUCCEED,
 * which is what distinguishes this from every other failed request and is why its
 * consumers (the offline queue's capture predicate, the activity editor's reload
 * banner) treat it as a state, not an error.
 *
 * Matched by error name and by both message variants (the server-thrown wording
 * says "older or newer deployment"; the client-thrown one carries the
 * failed-to-find-server-action docs slug), case-insensitively. Deliberately
 * narrow, like SKEW_SIGNATURES above: an ordinary server error or a dropped
 * connection must NOT match — each of those has a different remedy.
 */
const STALE_ACTION_SIGNATURES = [
  "unrecognizedactionerror",
  "failed to find server action",
  "failed-to-find-server-action",
  "older or newer deployment",
];

export function isStaleActionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  const haystack = `${typeof name === "string" ? name : ""} ${
    typeof message === "string" ? message : ""
  }`.toLowerCase();
  return STALE_ACTION_SIGNATURES.some((s) => haystack.includes(s));
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

// ---------------------------------------------------------------------------
// THE TAB TAKES THE DEPLOY ITSELF (issue #2471)
//
// Everything above answers a deploy by OFFERING: the bar waits for a tap, and the
// stale-save banner waits for a tap. That was the right posture while a reload could
// destroy work — the user is the only one who knows whether it is safe. #2471's
// ruling is that the app should schedule it instead, and the ONLY thing that makes
// that legitimate is turning "is it safe" from a guess into a derived property.
//
// So the decision below is not "did a deploy happen" (that is `resolveUpdateState`,
// unchanged) but "may this tab throw its document away RIGHT NOW without losing a
// keystroke". It is refusal-first: every answer other than a proven-safe one leaves
// the tab exactly where it is, on today's manual affordances.
//
// WHAT IT IS ALLOWED TO ASSUME, and what it is not. Two registries report dirtiness
// and they mean different things:
//
//   * a DRAFT-BACKED form (components/useFormDraft.ts) holds its content in
//     IndexedDB. Its content survives a reload by construction, so the reload is
//     lossless once the debounce has been flushed — which is a step in the reload
//     SEQUENCE, not an input to this decision.
//   * any other form holding unsaved input (components/DirtyFormRegistry.tsx, #1878,
//     which sees every <form> in the app) has NO durable copy. Reloading over it is
//     exactly the destruction the manual bar existed to prevent, so it is a refusal:
//     `unrecoverableWork` holds the tab and renders the old affordance.
//
// That split is why this ships as a partial: a settings card mid-edit, a record form
// mid-composition, a file upload in flight — none of them auto-reload, and none of
// them need to, because the fallback they get is precisely today's behaviour.
// ---------------------------------------------------------------------------

/**
 * The auto-reload ration, per tab, per WINDOW, per observed target build.
 *
 * Same shape and same reasoning as `SkewRecoveryGuard` above — an automatic reload
 * that lands somewhere still broken must not try again forever — with one field
 * added. `target` is the build this tab is trying to reach, and rationing per target
 * is what makes a flapping `/api/version` harmless: two servers mid-rolling-deploy
 * answering with different shas would otherwise ping-pong a tab between them, each
 * answer looking like a fresh episode to a target-blind guard. A genuinely new deploy
 * IS a new target and deserves its own attempt; the same target twice does not.
 *
 * Deliberately a SEPARATE key from `SKEW_RECOVERY_KEY`. The two rations bound
 * different actions taken by different code on opposite sides of a crash, and the
 * worst case that matters — a broken deploy under a dirty editor — is their SUM,
 * which is bounded because neither ever refills the other.
 */
export const AUTO_RELOAD_KEY = "allos-auto-reload";
export const AUTO_RELOAD_WINDOW_MS = 60_000;
/** At most one automatic attempt per target build, per window. */
export const AUTO_RELOAD_MAX_ATTEMPTS = 1;
/**
 * …and at most this many DISTINCT targets per window, whatever the server says.
 *
 * The per-target rule alone is not a bound. Two servers mid-rolling-deploy answering
 * A, B, A, B each look like a fresh target to a guard that only remembers the last
 * one, so the tab would reload forever while each individual target stayed within its
 * ration. Remembering the SET is what closes that, and the total cap is what keeps
 * three servers from doing the same thing more slowly. Two is generous: a genuine
 * second deploy inside one 60s window, under one open tab, is not a thing that
 * happens on a single-operator instance.
 */
export const AUTO_RELOAD_MAX_TARGETS = 2;

/** The target name used when a trigger knows a deploy happened but not which build. */
export const AUTO_RELOAD_UNNAMED_TARGET = "unnamed";

export type AutoReloadGuard = {
  /** The builds this tab has already tried to reach in this window. */
  targets: string[];
  /** When the window opened — the first attempt's timestamp, not the last. */
  at: number;
};

/** Read the stored guard. Anything unparseable is "no guard", never a throw. */
export function parseAutoReloadGuard(
  raw: string | null | undefined
): AutoReloadGuard | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { targets, at } = parsed as Record<string, unknown>;
    if (!Array.isArray(targets) || targets.length === 0) return null;
    if (!targets.every((t) => typeof t === "string" && t !== "")) return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    return { targets: targets as string[], at };
  } catch {
    return null;
  }
}

/** The guard, or null when its window has aged out and it counts for nothing. */
function liveGuard(
  guard: AutoReloadGuard | null,
  now: number
): AutoReloadGuard | null {
  if (!guard) return null;
  const age = now - guard.at;
  if (age < 0 || age > AUTO_RELOAD_WINDOW_MS) return null;
  return guard;
}

/** Whether the automatic path has nothing left to spend on this target. */
export function autoReloadRationSpent({
  guard,
  target,
  now,
}: {
  guard: AutoReloadGuard | null;
  target: string;
  now: number;
}): boolean {
  const live = liveGuard(guard, now);
  if (!live) return false;
  const forThisTarget = live.targets.filter((t) => t === target).length;
  if (forThisTarget >= AUTO_RELOAD_MAX_ATTEMPTS) return true;
  return live.targets.length >= AUTO_RELOAD_MAX_TARGETS;
}

/** The guard to store when taking an attempt. An aged-out window opens a new one. */
export function nextAutoReloadGuard(
  guard: AutoReloadGuard | null,
  target: string,
  now: number
): AutoReloadGuard {
  const live = liveGuard(guard, now);
  if (!live) return { targets: [target], at: now };
  if (live.targets.includes(target)) return live;
  return { targets: [...live.targets, target], at: live.at };
}

/**
 * How long the page must see no pointer or key activity ANYWHERE before a reload
 * counts as unobtrusive.
 *
 * Not "no activity inside a form": a reload mid-scroll, mid-drag or mid-picker is
 * the disruption the bar was protecting against just as much as a reload mid-typing,
 * and none of those touch a form field. Short, because a tab that never goes quiet
 * simply stays on the old build — the cost of waiting is nothing, and #1906 already
 * covers the stale navigation while it waits.
 *
 * IT IS MEASURED FROM WHEN WE STARTED WATCHING, not only from the last event. "No
 * input has been seen" and "the page is quiet" are the same sentence everywhere
 * except at the very start of a document, where the first is true because nothing
 * has been observed YET. A tab that discovers a deploy in the first milliseconds of
 * its life — the poll's mount read answers before a scroll can reach a listener that
 * has only just attached — would otherwise reload out from under a user who is
 * mid-gesture, which is exactly the harm the gate exists to prevent. So a freshly
 * mounted tab must WATCH for the window before it may call the page quiet. The cost
 * is that a clean tab converges three seconds later; the alternative is a gate that
 * answers "quiet" from a position of having seen nothing at all.
 */
export const INPUT_QUIET_MS = 3_000;

/**
 * How long after ANY form submit the tab still counts as busy.
 *
 * A submit starts a write whose completion this module cannot see, and tearing the
 * document down mid-POST is the one way an automatic reload could lose a write the
 * user already committed to. Watching submits at the document level is the same
 * completeness argument #1878 makes for the dirty-form registry: it covers every
 * form in the app, present and future, with no per-form wiring to forget.
 */
export const SUBMIT_SETTLE_MS = 5_000;

/**
 * What the tab should do about the deploy it has noticed.
 *
 * `reload` — provably safe now. `wait` — safe eventually, nothing to show yet (this
 * is the state a tab sits in while the user is mid-scroll). `hold` — the automatic
 * path is off for this episode, so render the manual affordance that shipped before
 * this issue. `none` — no deploy to answer.
 *
 * `hold` and `wait` are deliberately different answers rather than one "not now":
 * only `hold` may raise a bar. A bar that appeared during a two-second scroll pause
 * would re-create the ask-before posture this issue removes.
 */
export type AutoReloadVerdict =
  | { action: "reload"; target: string }
  | { action: "wait"; reason: "input" | "submit" }
  | { action: "hold"; reason: "ration-spent" | "unrecoverable-work" }
  | { action: "none" };

/**
 * THE "first safe moment" DECISION (#2471).
 *
 * Order matters and is the safety argument:
 *
 *   1. no trigger → nothing to do. `staleBuild` (a save that failed with the
 *      stale-action signature) is deliberately its own trigger, independent of the
 *      detector: it fires seconds after the deploy from the failure itself, so
 *      recovery still works in a tab whose `/api/version` poll has latched off.
 *   2. ration spent for this target → hold. A broken deploy degrades to the manual
 *      bar, never to a loop.
 *   3. work with no durable copy → hold. This is the refusal that keeps the feature
 *      honest; see the header above.
 *   4. a submit is still settling → wait, hidden or not. Safety outranks the
 *      convenience of the hidden fast path.
 *   5. hidden → reload. The user who "isn't looking" genuinely cannot be
 *      interrupted, and no pointer or key event can arrive at a hidden document.
 *   6. input-quiet — for `INPUT_QUIET_MS`, counted from the later of the last event
 *      and `watchingSince` — reload; otherwise wait.
 *
 * `lastSubmitAt` is 0 for "never", which reads as long-ago rather than as just-now.
 * `lastInputAt` has no such sentinel any more: silence is only quiet once we have
 * been in a position to hear it, which is what `watchingSince` measures.
 */
export function autoReloadPlan({
  staleBuild,
  pending,
  targetSha,
  unrecoverableWork,
  hidden,
  watchingSince,
  lastInputAt,
  lastSubmitAt,
  guard,
  now,
}: {
  /** A save failed with the stale-action signature (trigger A). */
  staleBuild: boolean;
  /** `resolveUpdateState().pending` — the detector's answer (trigger B). */
  pending: boolean;
  /** The build the server named, when it named one. */
  targetSha: string | null;
  /** Any form holding unsaved input that no draft would restore. */
  unrecoverableWork: boolean;
  hidden: boolean;
  /**
   * Epoch ms from which input has actually been OBSERVED — when the listeners
   * attached. Silence before this instant is ignorance, not quiet.
   */
  watchingSince: number;
  /** Epoch ms of the last pointer/key event anywhere on the page; 0 for never. */
  lastInputAt: number;
  /** Epoch ms of the last form submit anywhere on the page; 0 for never. */
  lastSubmitAt: number;
  guard: AutoReloadGuard | null;
  now: number;
}): AutoReloadVerdict {
  if (!staleBuild && !pending) return { action: "none" };
  const target = targetSha ?? AUTO_RELOAD_UNNAMED_TARGET;
  if (autoReloadRationSpent({ guard, target, now })) {
    return { action: "hold", reason: "ration-spent" };
  }
  if (unrecoverableWork) {
    return { action: "hold", reason: "unrecoverable-work" };
  }
  if (lastSubmitAt > 0 && now - lastSubmitAt < SUBMIT_SETTLE_MS) {
    return { action: "wait", reason: "submit" };
  }
  if (hidden) return { action: "reload", target };
  // The window runs from the LATER of the last event and the moment we started
  // watching — see INPUT_QUIET_MS. A hidden tab short-circuits above and needs no
  // observation period, because no input can reach a hidden document at all.
  // Not watching yet (0) is the strongest form of "we have not heard silence": it
  // means the listeners are not even attached, so nothing could have been heard.
  if (watchingSince <= 0) return { action: "wait", reason: "input" };
  const quietSince = Math.max(lastInputAt, watchingSince);
  if (now - quietSince < INPUT_QUIET_MS) {
    return { action: "wait", reason: "input" };
  }
  return { action: "reload", target };
}

/**
 * Whether the manual affordance — the "Update ready" bar, and the editor's
 * stale-save banner — may render.
 *
 * ONE deploy still gets ONE notice (#1795/#1806), and after this issue the notice is
 * normally the after-the-fact toast rather than a bar. The bar survives only as the
 * rationed-failure fallback: the automatic attempt has been spent and the tab is
 * still stale, or the tab is holding because work on screen would not survive. A tab
 * that is merely WAITING for a quiet moment shows nothing, because showing something
 * would be the ask-before consent gate this issue removes.
 */
export function showsManualUpdateNotice(verdict: AutoReloadVerdict): boolean {
  return verdict.action === "hold";
}

/**
 * The one-shot pointer written across an update reload so the editor comes back.
 *
 * A POINTER ONLY — form identity, record identity, live-ness and a timestamp. No
 * field content ever leaves IndexedDB (`lib/offline/drafts.ts`'s PHI rule), and
 * sessionStorage is the deliberate home: per-tab, so only the tab that lost its build
 * reopens its editor, and crash-scoped, so it cannot outlive the episode.
 *
 * `app/global-error.tsx` replaces the root layout, so nothing consumes this marker
 * on the crash path — it must survive to the next healthy boot, and it is parsed as
 * defensively as `parseSkewGuard` so a malformed one is ignored rather than thrown.
 */
export const RESUME_EDITOR_KEY = "allos-resume-editor";

export type ResumeMarker = {
  /** A `DraftFormKey`, kept as a string so this module stays free of the draft types. */
  formKey: string;
  /** The stored row being edited, or null for a create form. */
  recordId: number | null;
  /** The editor was in live-workout mode. */
  live: boolean;
  /** When the marker was written. */
  at: number;
};

export function parseResumeMarker(
  raw: string | null | undefined
): ResumeMarker | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { formKey, recordId, live, at } = parsed as Record<string, unknown>;
    if (typeof formKey !== "string" || formKey === "") return null;
    if (recordId !== null && typeof recordId !== "number") return null;
    if (typeof recordId === "number" && !Number.isFinite(recordId)) return null;
    if (typeof live !== "boolean") return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    return { formKey, recordId, live, at };
  } catch {
    return null;
  }
}

/**
 * How young a continuation must be for a draft to be applied without a tap.
 *
 * Minutes, not the draft TTL's seven days. The exception this gates is argued from
 * "the tap already happened — the user typed this seconds ago in this same tab", and
 * that argument expires quickly: a tab restored by the browser an hour later is a
 * revisit, and a revisit gets the offer banner like everything else.
 */
export const RESUME_MARKER_MAX_AGE_MS = 5 * 60_000;

/**
 * Whether a stored draft may be applied WITHOUT the user's tap.
 *
 * `useFormDraft`'s never-apply-without-a-tap rule stays the rule; this is its one
 * argued exception, and every leg is a way of checking that the tap really did
 * happen. The marker must name this exact form and record, the marker and the draft
 * must both be young, and the record must not have changed under us — if it did,
 * applying would clobber a write from another tab or from Telegram, so the offer
 * banner is the right answer and nothing is lost by falling back to it.
 */
export function shouldAutoApplyDraft({
  marker,
  formKey,
  recordId,
  savedAt,
  conflicts,
  now,
}: {
  marker: ResumeMarker | null;
  formKey: string;
  recordId: number | null;
  /** The stored draft's `savedAt`. */
  savedAt: number;
  /** `draftConflictsWithInput` — the form on screen has moved off its seed. */
  conflicts: boolean;
  now: number;
}): boolean {
  if (!marker) return false;
  if (marker.formKey !== formKey) return false;
  if (marker.recordId !== recordId) return false;
  if (conflicts) return false;
  const markerAge = now - marker.at;
  if (markerAge < 0 || markerAge > RESUME_MARKER_MAX_AGE_MS) return false;
  const draftAge = now - savedAt;
  if (draftAge < 0 || draftAge > RESUME_MARKER_MAX_AGE_MS) return false;
  return true;
}

/**
 * The second one-shot marker: what to TELL the user once the new build is up.
 *
 * The notice inverts with this issue — ask-before becomes tell-after — and the
 * dedupe is the consumption itself. Written immediately before an update-machinery
 * reload, read and removed on the next healthy boot, so a build taken twice (a
 * second machinery reload, #2155's late controller swap) cannot toast twice, and a
 * same-build waiting worker consumed silently (#2120) writes nothing and therefore
 * says nothing.
 */
export const UPDATE_TAKEN_KEY = "allos-update-taken";

export type UpdateTaken = {
  /** The build the tab was heading for, when the server had named one. */
  sha: string | null;
  commitMessage: string | null;
};

export function parseUpdateTaken(
  raw: string | null | undefined
): UpdateTaken | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { sha, commitMessage } = parsed as Record<string, unknown>;
    if (sha !== null && typeof sha !== "string") return null;
    if (commitMessage !== null && typeof commitMessage !== "string") {
      return null;
    }
    return { sha: sha ?? null, commitMessage: commitMessage ?? null };
  } catch {
    return null;
  }
}

/** The toast's words. One place, so the e2e and the component cannot disagree. */
export const UPDATE_TAKEN_MESSAGE = "The app has updated";

export function updateTakenMessage(taken: UpdateTaken): string {
  return taken.commitMessage
    ? `${UPDATE_TAKEN_MESSAGE} — ${taken.commitMessage}`
    : UPDATE_TAKEN_MESSAGE;
}

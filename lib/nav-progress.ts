// The slow-navigation floor, and what a navigation that cannot reach the server
// resolves into (issue #2869).
//
// #1956 answered the tap on a NAV ROW. #2869's report was that everything else
// is silent: a card link, a table row, a drill-down, a swipe — anything the app
// navigates from that has no spinner slot of its own. Those cannot each grow a
// treatment, and most of them should not: a link inside a sentence has nowhere
// to put a spinner. So there is one FLOOR beneath all of them — a thin top-edge
// indicator that appears only when a navigation is still pending past a
// threshold, and resolves at commit.
//
// The threshold is what keeps this from being noise. `(app)` ships no
// `loading.tsx` (#530), so on a fast connection the whole destination renders
// and swaps well inside 300ms and nothing is ever painted. The indicator exists
// for the connection the report was made on.
//
// ── Why this module holds state at all ───────────────────────────────────────
//
// The start of a navigation is observable only OUTSIDE React: Next 16 calls
// `onRouterTransitionStart` from `instrumentation-client.ts`, which is a plain
// module, not a component. The failure of a navigation's RSC fetch is observable
// only in `lib/nav-fetch-guard.ts`, also a plain module. Both need to reach the
// one component that paints. So this is a `useSyncExternalStore` store: two
// module-level writers, one React reader, no context plumbing through a tree
// that has not committed yet.
//
// It is deliberately NOT a per-navigation queue. Only the newest navigation can
// be the one the person is waiting for — starting a second one abandons the
// first (React discards the transition already in flight), so a single current
// state is the whole truth.

/**
 * How long a navigation may run before the floor paints. Under it, nothing is
 * shown at all, so a fast network never sees a flash — the indicator is
 * evidence of slowness, not decoration on every tap.
 */
export const NAV_PROGRESS_THRESHOLD_MS = 300;

/**
 * How the app is currently answering a navigation.
 *
 * - `idle` — nothing in flight, or the last one committed.
 * - `waiting` — in flight, still inside the threshold. Nothing paints.
 * - `slow` — in flight past the threshold. The indicator is on screen.
 * - `failed` — the RSC fetch could not reach the server and the bounded retries
 *   in `lib/nav-fetch-guard.ts` are spent. The navigation is NOT abandoned and
 *   the page under it is untouched; we are asking rather than ejecting.
 */
export type NavProgressPhase = "idle" | "waiting" | "slow" | "failed";

/**
 * The phase a navigation is in, given how long it has been running and whether
 * its fetch has conceded. Pure, so the timing rule is a tested rule rather than
 * an inline comparison inside an effect.
 */
export function navProgressPhase({
  navigating,
  elapsedMs,
  failed,
}: {
  navigating: boolean;
  elapsedMs: number;
  failed: boolean;
}): NavProgressPhase {
  if (!navigating) return "idle";
  // Failure outranks the threshold: a fetch that has already given up is not
  // "still loading", and it must be say-so-able before 300ms have passed if the
  // connection was dead enough to fail that fast.
  if (failed) return "failed";
  return elapsedMs >= NAV_PROGRESS_THRESHOLD_MS ? "slow" : "waiting";
}

type Listener = () => void;

let phase: NavProgressPhase = "idle";
const listeners = new Set<Listener>();
let thresholdTimer: ReturnType<typeof setTimeout> | null = null;
// Resolved when the person (or a restored connection) asks the held fetch to go
// again. `lib/nav-fetch-guard.ts` awaits it; nothing else may resolve it.
let retryWaiter: (() => void) | null = null;

function emit(next: NavProgressPhase) {
  if (phase === next) return;
  phase = next;
  for (const listener of listeners) listener();
}

function clearThresholdTimer() {
  if (thresholdTimer !== null) {
    clearTimeout(thresholdTimer);
    thresholdTimer = null;
  }
}

export function subscribeNavProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNavProgress(): NavProgressPhase {
  return phase;
}

/**
 * The server snapshot `useSyncExternalStore` needs. Always `idle`: a navigation
 * is a client event, and rendering the indicator into HTML would put it on
 * screen for every cold load.
 */
export function getServerNavProgress(): NavProgressPhase {
  return "idle";
}

/**
 * A navigation started. Called from `onRouterTransitionStart` for every push,
 * replace and back/forward traversal — link taps, `router.push` from the day
 * swipe, and the browser's own buttons all land here.
 */
export function startNavProgress(): void {
  clearThresholdTimer();
  // A new navigation supersedes whatever the previous one was waiting on: its
  // held fetch is abandoned (see the guard), so its failure state must not stay
  // on screen over a navigation that is now running fine.
  retryWaiter = null;
  emit("waiting");
  thresholdTimer = setTimeout(() => {
    thresholdTimer = null;
    if (phase === "waiting") emit("slow");
  }, NAV_PROGRESS_THRESHOLD_MS);
}

/** The navigation committed — the destination is on screen. */
export function settleNavProgress(): void {
  clearThresholdTimer();
  retryWaiter = null;
  emit("idle");
}

/**
 * The navigation's RSC fetch could not reach the server and its bounded retries
 * are spent. Nothing is torn down; the current page is still on screen and still
 * interactive, and this is what turns the indicator into the ask.
 */
export function failNavProgress(): void {
  clearThresholdTimer();
  emit("failed");
}

/**
 * Ask the held fetch to try again — from the indicator's Retry control, or from
 * the browser reporting the connection back. Returns to `slow` rather than
 * `waiting`: the person has already been waiting past the threshold, and
 * dropping back under it would hide the indicator mid-navigation.
 */
export function retryNavProgress(): void {
  if (phase !== "failed") return;
  const waiter = retryWaiter;
  retryWaiter = null;
  emit("slow");
  waiter?.();
}

/**
 * Registered by the fetch guard while it holds a conceded navigation. Resolves
 * when `retryNavProgress()` runs, and never otherwise — a guard whose navigation
 * was superseded is left parked on purpose, because React has already discarded
 * the transition that was waiting on it.
 */
export function awaitNavRetry(): Promise<void> {
  return new Promise<void>((resolve) => {
    retryWaiter = resolve;
  });
}

/** Test seam: drop every listener, timer and waiter. */
export function resetNavProgress(): void {
  clearThresholdTimer();
  retryWaiter = null;
  phase = "idle";
  listeners.clear();
}

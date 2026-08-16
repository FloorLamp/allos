// A navigation whose fetch dies must not take the page you are on with it
// (issue #2869, the failure leg).
//
// ── What happens without this ────────────────────────────────────────────────
//
// During a soft navigation the old page never leaves the screen: `(app)` ships
// no `loading.tsx` (#530), so React renders the destination off-screen and swaps
// only at commit, and until then the page you were using is there and fully
// interactive. If the destination's RSC fetch then dies on a flaky connection,
// Next 16.3.0 catches it, logs "Failed to fetch RSC payload … Falling back to
// browser navigation." and returns the URL as an MPA target — a full document
// load of the same URL. The soft-nav fetch is not `mode: "navigate"`, so the
// service worker never sees it, but the MPA fallback IS, and on a dead network
// `networkThenOffline` in public/sw.js serves the precached "You're offline"
// page. Either branch throws away a working page because one fetch failed.
//
// `app/(app)/error.tsx` is not involved — it catches render throws, not failed
// navigation fetches. So there is nothing in the app that can answer this; it
// has to be answered before Next sees the rejection.
//
// ── Why not `experimental.useOffline` ───────────────────────────────────────
//
// #2869 named Next's own remedy as the first lever to evaluate, and it does fit
// the navigation half: with `experimental.useOffline` on, a rejected navigation
// fetch waits for connectivity and retries instead of falling back to an MPA,
// which is exactly the behaviour wanted here.
//
// It was NOT adopted, because the flag is not scoped to navigation. The same
// build-time flag also wraps the Server Action fetch
// (`router-reducer/reducers/server-action-reducer.js`): a rejected action would
// likewise wait for connectivity and retry rather than throwing. This app's
// offline write queue (#28) is built on that throw — `shouldQueueOffline` in
// lib/offline/queue.ts reads the `TypeError` a dead connection produces as the
// signal to queue the write, and `DoseStatusControl` (and every other quick-log
// surface) enqueues from that catch. Under `useOffline` the action would hang
// instead of rejecting, so an offline dose tap would produce no queue entry, no
// queued badge and no toast — it would simply never finish. #2869's own
// invariant is that write-path feedback stays untouched, and a flag that silently
// disables the write queue is not a navigation fix.
//
// So the lever is taken at the one layer where navigation and writes are
// distinguishable: a navigation RSC read is a GET carrying `RSC: 1`, a Server
// Action is a POST. This guard wraps `window.fetch`, matches only the former,
// and passes literally everything else through by reference — same arguments,
// same body, no `Request` construction — so no other fetch in the app can be
// changed by it.
//
// ── What it does with a match ────────────────────────────────────────────────
//
// A bounded retry first (400ms → 1.2s → 3s): most "spotty internet" is a blip,
// and a navigation that lands 1.6s late is a slow navigation, which the #2869
// indicator already answers honestly.
//
// If the retries are spent AND this fetch belongs to the navigation the person
// is actually waiting for, the promise is HELD rather than rejected, and
// `failNavProgress()` turns the indicator into "Couldn't load — check your
// connection" with a Retry. Held, not rejected, is the whole point: a rejection
// is what Next turns into the hard exit. The page underneath keeps running, the
// navigation is paused rather than abandoned, and Retry (or the browser
// reporting the connection back) resumes the same fetch — so the navigation
// lands once, when it can, instead of being restarted from a torn-down document.
//
// A fetch that is NOT the pending navigation — a background `router.refresh()`
// from the toaster poll, a prefetch — is retried but never held and never
// painted. Those run on a timer and nobody is waiting on them; turning a
// polling miss into a banner would make the banner meaningless. They reject
// exactly as they do today.

import {
  awaitNavRetry,
  failNavProgress,
  getNavProgress,
} from "@/lib/nav-progress";

/**
 * Backoff before each retry of a navigation fetch that failed at the network.
 * Three attempts, ~4.6s total: long enough to ride out a blip, short enough
 * that a person on a genuinely dead connection is told rather than left
 * watching a spinner.
 */
export const NAV_RETRY_DELAYS_MS = [400, 1200, 3000] as const;

/** How long to wait before retry `attempt` (1-based). 0 once they are spent. */
export function navRetryDelayMs(attempt: number): number {
  return NAV_RETRY_DELAYS_MS[attempt - 1] ?? 0;
}

/** Whether `attempt` (1-based) is still inside the bounded retry budget. */
export function hasNavRetryBudget(attempt: number): boolean {
  return attempt <= NAV_RETRY_DELAYS_MS.length;
}

/**
 * Case-insensitive lookup across every shape `RequestInit.headers` can take.
 * Next passes a plain object here; a `Headers` instance and an entry array are
 * both legal and cost nothing to support.
 */
export function headerValue(
  headers: HeadersInit | undefined,
  name: string
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === wanted) return value;
    }
    return null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value);
  }
  return null;
}

/**
 * Is this the App Router reading a route's RSC payload for a navigation?
 *
 * `RSC: 1` marks every flight read. `Next-Router-Prefetch` marks the ones
 * `<Link>` issues speculatively — those must pass through untouched, because
 * holding a prefetch would stall the control rather than the navigation, and
 * the two are only distinguishable by that header (the same distinction
 * e2e/nav-pending.spec.ts has drawn since #1956). A Server Action is a POST and
 * never matches.
 */
export function isNavigationRscFetch({
  method,
  headers,
}: {
  method: string;
  headers: HeadersInit | undefined;
}): boolean {
  if (method.toUpperCase() !== "GET") return false;
  if (headerValue(headers, "RSC") !== "1") return false;
  return headerValue(headers, "Next-Router-Prefetch") === null;
}

/**
 * Did this fetch fail at the network, as opposed to returning an error status?
 * `fetch` rejects with a `TypeError` when the connection cannot be made; an
 * `AbortError`/`TimeoutError` is a deliberate cancellation and must be handed
 * straight back. A non-2xx response is not a rejection at all and never reaches
 * here — that is a server answer, and the app's error boundaries own it.
 */
export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name !== "AbortError" && err.name !== "TimeoutError";
  }
  return err instanceof TypeError;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

declare global {
  interface Window {
    __allosNavFetchGuard?: true;
  }
}

/**
 * Wrap `window.fetch` once. Called from `instrumentation-client.ts`, which runs
 * before the app becomes interactive, so the very first navigation is covered.
 */
export function installNavFetchGuard(win: Window = window): void {
  if (win.__allosNavFetchGuard) return;
  win.__allosNavFetchGuard = true;
  const original = win.fetch.bind(win);

  win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      !init ||
      !isNavigationRscFetch({ method: init.method ?? "GET", headers: init.headers })
    ) {
      return original(input, init);
    }
    return navigationFetch(original, input, init);
  };
}

async function navigationFetch(
  original: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    try {
      return await original(input, init);
    } catch (err) {
      if (init.signal?.aborted) throw err;
      if (!isNetworkFailure(err)) throw err;
      attempt += 1;
      if (hasNavRetryBudget(attempt)) {
        await sleep(navRetryDelayMs(attempt));
        continue;
      }
      // Out of budget. Only the navigation someone is waiting on earns the
      // in-app ask; everything else rejects the way it does today.
      if (getNavProgress() === "idle") throw err;
      const resume = awaitNavRetry();
      failNavProgress();
      await resume;
      attempt = 0;
    }
  }
}

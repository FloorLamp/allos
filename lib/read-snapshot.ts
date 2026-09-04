import { AsyncLocalStorage } from "node:async_hooks";

const readSnapshot = new AsyncLocalStorage<Map<string, unknown>>();

/**
 * Open a read-only snapshot for a bounded server operation. Values are
 * discarded when the aggregation returns; callers that can write must not open
 * this scope.
 *
 * IT REACHES THIS CALL'S OWN FRAME, NOT THE COMPONENTS BELOW IT (#5012). The
 * scope is AsyncLocalStorage, so it follows every `await` inside `fn` — but a
 * child Server Component is rendered by React from its own scheduling context
 * rather than from the caller's stack, and runs with the scope CLOSED. Measured
 * on a real /trends render, `next dev` and `next start` agreeing exactly: the
 * page's own frame reported the scope open either side of its gathers, and all
 * 57 `getProfileSetting` calls — every one inside `TrendingDigest`,
 * `BodySection` or the shell — reported it closed. So wrapping that page
 * collapsed no reads and added one statement (505 against 504, `npm run
 * profile:dashboard -- --page "app/(app)/trends/page"`), and it was not landed.
 *
 * STREAMING IS NOT THE REASON, which is the part to know before trying again:
 * `TrendingDigest` sits under no Suspense boundary and loses the scope exactly
 * as the streamed `BodySection` does, and the test beside this module pins that
 * the scope survives the `setImmediate` yield `StreamedSection` resumes on. The
 * boundary is the component, not the flush.
 *
 * So this pays off only where the gathers run in the SAME function that opens
 * it. That is why `app/(app)/page.tsx` works — 215 of its 226 setting reads
 * land inside the scope — and why a page that gathers inside child components
 * has to open the scope in each of those components instead.
 */
export function withReadSnapshot<T>(fn: () => T): T {
  return readSnapshot.run(new Map(), fn);
}

/** Memoize a read only while an explicit read snapshot is open. */
export function snapshotCached<A extends unknown[], R>(
  name: string,
  keyOf: (...args: A) => string,
  fn: (...args: A) => R
): (...args: A) => R {
  return (...args: A): R => {
    const snapshot = readSnapshot.getStore();
    if (!snapshot) return fn(...args);
    const key = `${name}:${keyOf(...args)}`;
    if (snapshot.has(key)) return snapshot.get(key) as R;
    const value = fn(...args);
    snapshot.set(key, value);
    return value;
  };
}

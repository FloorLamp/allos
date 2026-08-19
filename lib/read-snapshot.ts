import { AsyncLocalStorage } from "node:async_hooks";

const readSnapshot = new AsyncLocalStorage<Map<string, unknown>>();

/**
 * Open a read-only snapshot for a bounded server operation. Values are
 * discarded when the aggregation returns; callers that can write must not open
 * this scope.
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

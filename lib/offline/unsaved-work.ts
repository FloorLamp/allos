// "Is the user mid-composition right now?" — a tiny, device-local registry the
// draft hook writes and the service-worker update affordance reads (issues
// #1699/#1700).
//
// WHY IT EXISTS. The update prompt must never interrupt work in progress: it stays
// passive while a form is half-filled, and says so. That is a UI decision, not a
// data one, so this holds no content whatsoever — only the KEYS of the forms
// currently holding unsaved input. Never a value, never a label, never PHI.
//
// Module-level rather than a React context on purpose: the readers (a root-layout
// banner) and the writers (any form, anywhere in the tree) have no common ancestor
// worth threading a provider through, and an unsaved-work flag has no per-subtree
// meaning.

const dirtyKeys = new Set<string>();
const listeners = new Set<(dirty: boolean) => void>();

function notify() {
  const dirty = dirtyKeys.size > 0;
  for (const fn of listeners) fn(dirty);
}

/** Record (or clear) that the form behind `key` is holding unsaved input. */
export function markUnsavedWork(key: string, dirty: boolean): void {
  const had = dirtyKeys.has(key);
  if (dirty === had) return;
  if (dirty) dirtyKeys.add(key);
  else dirtyKeys.delete(key);
  notify();
}

/** True while any form is holding unsaved input. */
export function hasUnsavedWork(): boolean {
  return dirtyKeys.size > 0;
}

/** Subscribe to changes; returns an unsubscribe. */
export function subscribeUnsavedWork(fn: (dirty: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: forget everything (no production caller). */
export function resetUnsavedWork(): void {
  dirtyKeys.clear();
  notify();
}

// "Is the user mid-composition right now, and would a reload cost them anything?" —
// a tiny, device-local registry the draft hook writes and the service-worker update
// affordances read (issues #1699/#1700/#2471).
//
// WHY IT EXISTS. The update prompt must never interrupt work in progress: it stays
// passive while a form is half-filled, and says so. That is a UI decision, not a
// data one, so this holds no content whatsoever — only the KEYS of the forms
// currently holding unsaved input. Never a value, never a label, never PHI.
//
// TWO AXES, BECAUSE THE ANSWER DIFFERS (#2471). Once a deploy can reload the tab by
// itself, "a form is dirty" stops being one fact:
//
//   * RECOVERABLE work is a draft-backed form (components/useFormDraft.ts). Its
//     content is in IndexedDB, so a reload costs nothing once the debounce has been
//     flushed — and each entry can flush itself on demand through `capture`.
//   * UNRECOVERABLE work is any other form holding unsaved input, reported by the
//     #1878 dirty-form registry, which sees every <form> in the app. Reloading over
//     it would destroy exactly what the manual bar existed to protect, so the
//     automatic path refuses while any of it exists.
//
// Module-level rather than a React context on purpose: the readers (a root-layout
// banner, the root-layout registrar) and the writers (any form, anywhere in the
// tree, and a provider mounted below the root) have no common ancestor worth
// threading a provider through, and an unsaved-work flag has no per-subtree meaning.

/**
 * What a recoverable entry hands back once it has made itself durable: the pointer
 * an update reload should leave behind so the editor comes back on the other side.
 * Identifiers only — the content stays in IndexedDB (`lib/offline/drafts.ts`).
 */
export interface ResumePointer {
  formKey: string;
  recordId: number | null;
  live: boolean;
}

export interface UnsavedWorkEntry {
  /**
   * Flush this form's pending local write and resolve once it is durable. Resolves
   * with a resume pointer when the form wants to be reopened on the other side of a
   * reload, or null when it does not. A rejection means the work is NOT durable, and
   * the caller must not reload.
   */
  capture: () => Promise<ResumePointer | null>;
}

export interface DiscardableUnsavedWorkEntry extends UnsavedWorkEntry {
  // DOM identity only; the draft content stays in IndexedDB.
  owner: Node | null;
  discard: () => Promise<void>;
}

function isDiscardable(
  entry: UnsavedWorkEntry
): entry is DiscardableUnsavedWorkEntry {
  return "discard" in entry && "owner" in entry;
}

const dirtyKeys = new Map<string, UnsavedWorkEntry | null>();
const unrecoverableKeys = new Set<string>();
const listeners = new Set<(dirty: boolean) => void>();

function notify() {
  const dirty = dirtyKeys.size > 0;
  for (const fn of listeners) fn(dirty);
}

/**
 * Record (or clear) that the draft-backed form behind `key` is holding unsaved
 * input. `entry` supplies the flush used before an automatic reload; a caller with
 * nothing to flush may omit it.
 */
export function markUnsavedWork(
  key: string,
  dirty: boolean,
  entry?: UnsavedWorkEntry
): void {
  const had = dirtyKeys.has(key);
  if (dirty) {
    // Re-marking an already-dirty key refreshes its entry: the callback closes over
    // the current mount, and a stale one would flush a form that no longer exists.
    dirtyKeys.set(key, entry ?? null);
    if (!had) notify();
    return;
  }
  if (!had) return;
  dirtyKeys.delete(key);
  notify();
}

/** True while any draft-backed form is holding unsaved input. */
export function hasUnsavedWork(): boolean {
  return dirtyKeys.size > 0;
}

/** Discard registered dirty drafts owned by `root`, and no others. */
export async function discardUnsavedWorkWithin(root: Node): Promise<void> {
  const owned = new Set<DiscardableUnsavedWorkEntry>();
  for (const entry of dirtyKeys.values()) {
    if (!entry || !isDiscardable(entry)) continue;
    if (entry.owner && root.contains(entry.owner)) owned.add(entry);
  }
  await Promise.all([...owned].map((entry) => entry.discard()));
}

/**
 * Record (or clear) that the form behind `key` holds unsaved input that NOTHING
 * would restore after a reload. Written by the #1878 dirty-form registry for every
 * dirty form that is not inside a draft-backed subtree.
 *
 * ── THIS KEY SET IS NOT THE WHOLE ANSWER, DELIBERATELY (#3371) ───────────────
 *
 * The recorded decision the issue asked for, because "does the `data-unsaved` marker
 * gate the automatic update reload?" has a yes and a where, and only the yes is
 * obvious.
 *
 * IT DOES GATE IT. A form that composes its FormData by hand out of React state has
 * no named controls, so the registry never opens a record for it and nothing here is
 * ever written about it — which left the reload blind to exactly the surfaces #3356
 * existed for. It no longer is.
 *
 * BUT NOT FROM HERE, AND THAT IS THE POINT. A declaration is a rendered DOM
 * attribute: it appears, flips and vanishes with its element, on React's schedule and
 * not on any event a registry listens to. Mirroring it into this set would need a
 * MutationObserver plus removal bookkeeping, and every gap in that bookkeeping fails
 * toward a key nothing can ever clear — a tab permanently refusing updates, with no
 * form on screen to explain why. This module also holds no DOM knowledge at all
 * (see the header), and buying that mirror would cost it.
 *
 * So the declaration axis is READ AT THE DECISION POINT instead:
 * `components/DirtyFormRegistry.tsx#pageDeclaresUnrecoverableWork` scans for
 * `[data-unsaved="true"]` outside any `data-draft-backed` subtree, and
 * `components/useAutoUpdateReload.ts` ORs it with `hasUnrecoverableWork()` both when
 * it evaluates the plan and again immediately before it reloads. One read, no state
 * to get wrong, and nothing left holding the gate once the element is gone.
 *
 * `hasUnrecoverableWork()` below therefore answers about THIS SET ONLY. Anyone adding
 * a second consumer of "would a reload cost the user something?" must ask both.
 */
export function markUnrecoverableWork(key: string, dirty: boolean): void {
  const had = unrecoverableKeys.has(key);
  if (dirty === had) return;
  if (dirty) unrecoverableKeys.add(key);
  else unrecoverableKeys.delete(key);
  notify();
}

/**
 * True while any REGISTRY-TRACKED form holds unsaved input with no durable copy behind
 * it. Not the whole question — see the note on `markUnrecoverableWork` for the
 * declaration axis and where it is asked (#3371).
 */
export function hasUnrecoverableWork(): boolean {
  return unrecoverableKeys.size > 0;
}

/**
 * Make every dirty draft-backed form durable, then say what should be reopened.
 *
 * The ordering #2471 fixes: flushed and settled → marker written → reload. A
 * rejection anywhere answers `{ ok: false }` and the caller must not reload — an
 * automatic reload that can drop a keystroke is worse than the taps it replaces.
 *
 * A resume pointer is returned only when EXACTLY ONE form asked for one. The marker
 * is a single per-tab slot, and picking a winner between two open editors would be a
 * guess; both drafts survive either way and both get today's offer banner.
 */
export async function captureUnsavedWork(): Promise<{
  ok: boolean;
  resume: ResumePointer | null;
}> {
  const entries = [...dirtyKeys.values()].filter(
    (entry): entry is UnsavedWorkEntry => entry != null
  );
  const pointers: ResumePointer[] = [];
  for (const entry of entries) {
    try {
      const pointer = await entry.capture();
      if (pointer) pointers.push(pointer);
    } catch {
      return { ok: false, resume: null };
    }
  }
  return { ok: true, resume: pointers.length === 1 ? pointers[0] : null };
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
  unrecoverableKeys.clear();
  notify();
}

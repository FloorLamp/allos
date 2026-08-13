"use client";

import {
  parseResumeMarker,
  RESUME_EDITOR_KEY,
  type ResumeMarker,
} from "@/lib/sw-update";

// The consumer half of the one-shot resume marker (#2471).
//
// TWO READERS, ONE CONSUMPTION. The marker written before an update reload has to
// reach two places on the other side: `ActivityEditorProvider`, which reopens the
// editor, and `useFormDraft`, which applies the draft without a tap. A one-shot
// marker with two independent read-and-remove calls is a race — whoever ran first
// would win and the other would see nothing — so the sessionStorage read happens
// exactly once per document here, and both readers ask this module instead.
//
// REMOVE ON READ IS THE LOOP GUARD. The key is deleted the first time this document
// looks at it, before anything acts on it, so a reload that happens for any reason
// afterwards (a second machinery reload, #2155's late controller swap, a manual F5)
// finds nothing to resume and behaves exactly as it did before this issue. A
// malformed value is parsed defensively and removed all the same.
//
// The crash path never runs this: `app/global-error.tsx` replaces the root layout,
// so none of these components mount there and the marker survives to the next
// healthy boot, which is the intended behaviour.

let read = false;
let marker: ResumeMarker | null = null;
/** Draft keys this document has already auto-applied — at most once each. */
const burned = new Set<string>();

function ensureRead(): void {
  if (read) return;
  read = true;
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(RESUME_EDITOR_KEY);
    if (raw !== null) sessionStorage.removeItem(RESUME_EDITOR_KEY);
  } catch {
    // Storage denied (private mode, blocked cookies). No marker, no continuation —
    // every surface falls back to the offer banner, which is the pre-#2471 shape.
    return;
  }
  marker = parseResumeMarker(raw);
}

/**
 * The continuation this document booted with, or null. Idempotent: the underlying
 * sessionStorage entry is consumed on the first call and the parsed value is what
 * every later caller sees.
 */
export function resumeContinuation(): ResumeMarker | null {
  ensureRead();
  return marker;
}

/**
 * The continuation, if it names this draft key AND that key has not already used
 * it. Applying a draft is a one-time act per key; a form that remounts (a card
 * switch, a StrictMode double-mount) must not re-apply it on top of live input.
 */
export function takeResumeContinuationFor(key: string): ResumeMarker | null {
  const current = resumeContinuation();
  if (!current) return null;
  if (burned.has(key)) return null;
  burned.add(key);
  return current;
}

/** Test seam: forget this document's consumption (no production caller). */
export function resetResumeContinuation(): void {
  read = false;
  marker = null;
  burned.clear();
}

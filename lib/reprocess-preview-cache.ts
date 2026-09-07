// Single-use preview inputs, bound to a profile, document, and persisted generation.
// Cache loss or expiry requires a new preview; apply never re-extracts as a fallback.
import crypto from "node:crypto";
import type { PersistInput } from "./import-shape";

// ~15 minutes: long enough for a user to review a diff and confirm, short enough
// that a stale in-memory input can't outlive the document's on-disk reality by much.
const TTL_MS = 15 * 60 * 1000;

interface PreviewEntry {
  profileId: number;
  docId: number;
  input: PersistInput;
  // A signature of the document row captured at preview time (content_hash +
  // extraction generation). The apply refuses the cached input when the current
  // row's signature differs.
  stalenessKey: string;
  expiresAt: number;
}

// Keyed by the random token. Small (one entry per in-flight preview), so the
// eviction sweep can iterate it.
const cache = new Map<string, PreviewEntry>();

export type TakePreviewResult =
  { input: PersistInput } | { reason: "missing" | "expired" | "stale" };

// Stash a preview's reduced input and return its single-use token. A fresh
// preview for the same (profileId, docId) supersedes any earlier one (the user
// re-previewed), so we drop prior entries for that document first — bounding
// memory and guaranteeing the token the client just received is the live one.
export function stashPreviewInput(args: {
  profileId: number;
  docId: number;
  input: PersistInput;
  stalenessKey: string;
}): string {
  evictPreviewsForDocument(args.profileId, args.docId);
  const token = crypto.randomBytes(18).toString("hex");
  cache.set(token, {
    profileId: args.profileId,
    docId: args.docId,
    input: args.input,
    stalenessKey: args.stalenessKey,
    expiresAt: Date.now() + TTL_MS,
  });
  return token;
}

// Consume a previewed input for (profileId, docId) by token. SINGLE-USE: a
// successful take — and any take by the RIGHTFUL owner (expired/stale included) —
// deletes the entry, so a second apply is refused. A token for another profile
// is treated as `missing` and never consumes the owner's entry: the
// key includes profileId AND docId, and only the matching owner may burn it.
export function takePreviewInput(
  profileId: number,
  docId: number,
  token: string,
  currentStalenessKey: string
): TakePreviewResult {
  const entry = cache.get(token);
  // Not found, or belongs to another profile/document — do NOT delete it here; a
  // cross-profile lookup must not be able to invalidate the owner's preview.
  if (!entry || entry.profileId !== profileId || entry.docId !== docId) {
    return { reason: "missing" };
  }
  // The rightful owner is consuming its token — single-use, so drop it now
  // regardless of the validation outcome below.
  cache.delete(token);
  if (entry.expiresAt <= Date.now()) return { reason: "expired" };
  if (entry.stalenessKey !== currentStalenessKey) return { reason: "stale" };
  return { input: entry.input };
}

// Drop every cached preview for a document. Called whenever an upload/reprocess/
// delete/reassign mutates the document, so a preview can't be applied over a row
// that has since changed underneath it. (The staleness key is the correctness
// guard; eviction also releases the cached input.)
export function evictPreviewsForDocument(
  profileId: number,
  docId: number
): void {
  for (const [token, entry] of cache) {
    if (entry.profileId === profileId && entry.docId === docId) {
      cache.delete(token);
    }
  }
}

// Test-only: clear the whole cache between cases so process-local state can't leak.
export function _resetPreviewCache(): void {
  cache.clear();
}

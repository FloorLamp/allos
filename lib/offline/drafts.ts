// Local form drafts (issue #1699) — the pure half.
//
// WHAT THIS IS. Every long form in the app held its in-progress state in React
// `useState` only, so ANY unmount lost it: an accidental refresh, a chunk-load
// failure, an iOS tab eviction, a phone reboot mid-gym — or a service worker taking
// over the client on deploy (the sibling issue #1700). The worst case is the
// activity editor: entered mid-workout, on a phone, over 30–60 minutes, holding
// information the user cannot reconstruct (nobody re-remembers set 3's RPE).
//
// THE DRAFT / OFFLINE-QUEUE BOUNDARY (read this before touching either).
// They look alike — both are health data parked in the browser's IndexedDB — and
// they are NOT the same thing:
//
//   * A QUEUED WRITE (lib/offline/queue.ts, #28/#1427) is a COMPLETED intent the
//     user already committed to, waiting only on the network. It replays BY ITSELF
//     the moment connectivity returns, without asking, because the user's decision
//     is already made. Its unit is one tap (a dose confirm, a weight).
//   * A DRAFT (this module) is an INCOMPLETE composition waiting on the USER. It is
//     never sent anywhere, never replayed, and never applied without an explicit
//     tap. Its unit is a half-filled form.
//
// So: a form that successfully submits — or successfully queues its write — CLEARS
// its draft. The two stores never hold the same work at the same time, and a draft
// can never re-submit anything on its own. (A stale draft resurrecting an
// already-submitted workout would be #1699 inverted, which is why clear-on-save is
// mandatory rather than best-effort.)
//
// They share ONE thing deliberately: the `allos-offline` IndexedDB database. One
// database is one PHI perimeter — one logout wipe, one quota story, one place to
// look. See lib/offline/draft-db.ts for the store, components/useFormDraft.ts for
// the React binding.
//
// PHI DISCIPLINE. Drafts are health data at rest on the device: never localStorage
// (the queue's IndexedDB store is the established home), never logged, never part of
// a diagnostic export, cleared on logout, keyed per profile so a profile switch
// cannot surface another subject's half-typed entry, and expired after a bounded age
// so a forgotten draft cannot resurface weeks later.

/**
 * The forms that persist drafts. A form identity is part of the storage key, so
 * these strings are durable: renaming one orphans that form's drafts (harmless —
 * they expire — but the offer is lost).
 */
export const DRAFT_FORM_KEYS = [
  "activity",
  "supplement",
  "medication",
  "medical-record",
  "protocol",
  "routine",
] as const;

export type DraftFormKey = (typeof DRAFT_FORM_KEYS)[number];

/** One named DOM field value: `[name, value]`, in document order. */
export type DraftField = [string, string];

export interface FormDraft {
  /** `draftKey()` — the object store's keyPath. */
  key: string;
  profileId: number;
  formKey: DraftFormKey;
  /** The stored row being edited, or null for a create form. */
  recordId: number | null;
  /** Epoch ms of the last autosave — what the resume affordance shows. */
  savedAt: number;
  /**
   * The form's named DOM fields. Covers everything a `<form action={...}>` would
   * submit: controlled and uncontrolled inputs alike, because the server action
   * reads them out of the same FormData. Files and passwords are never captured.
   */
  fields: DraftField[];
  /**
   * Form state with no named DOM field of its own — dynamic dose rows, the parts
   * list of an activity, picker state serialized into FormData at submit time.
   * Opaque JSON owned by the form that wrote it.
   */
  extra: unknown;
}

/** How long a draft stays offerable. Older ones are ignored and purged on read. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The storage key: profile + form identity + record.
 *
 * Profile-scoped so a switch can never surface another subject's draft. Edit and
 * create are keyed SEPARATELY (`<id>` vs `new`) so an in-flight edit of an existing
 * record can't be confused with a new one — and so a create form that has already
 * produced a server row (the activity editor's auto-save does exactly that) hands
 * its draft over to that row's key instead of leaving a "new" draft behind that
 * would restore into a second, duplicate record.
 */
export function draftKey({
  profileId,
  formKey,
  recordId,
}: {
  profileId: number;
  formKey: DraftFormKey;
  recordId: number | null;
}): string {
  return `${profileId}:${formKey}:${recordId ?? "new"}`;
}

/** A stable signature of a form snapshot, for "did this change?" comparisons. */
export function draftSig(
  fields: readonly DraftField[],
  extra: unknown
): string {
  return JSON.stringify([fields, extra ?? null]);
}

export function isDraftExpired(draft: FormDraft, now: number): boolean {
  return now - draft.savedAt >= DRAFT_TTL_MS;
}

/**
 * Whether a stored draft should be OFFERED for the form now on screen.
 *
 * Offering is all this decides: a draft is never applied without the user's tap
 * (`docs`: no writes or state changes the user didn't ask for). The rules:
 *
 *   - nothing stored, or stored under a different profile/form/record → no offer
 *     (the key already guarantees that; the profile check is belt-and-braces for a
 *     provider that re-rendered under a new profile before the hook re-keyed)
 *   - expired → no offer (and the caller purges it)
 *   - byte-identical to what's already on screen → no offer; there is nothing to
 *     restore and a banner would be noise
 *
 * A draft that DIFFERS from a form the user has already started filling is still
 * offered — refusing would hide recoverable work — but the affordance must say that
 * resuming replaces what's on screen. `draftConflictsWithInput` is that flag.
 */
export function shouldOfferDraft({
  draft,
  profileId,
  formKey,
  recordId,
  currentSig,
  now,
}: {
  draft: FormDraft | null;
  profileId: number;
  formKey: DraftFormKey;
  recordId: number | null;
  currentSig: string;
  now: number;
}): boolean {
  if (!draft) return false;
  if (draft.key !== draftKey({ profileId, formKey, recordId })) return false;
  if (isDraftExpired(draft, now)) return false;
  return draftSig(draft.fields, draft.extra) !== currentSig;
}

/**
 * True when resuming would overwrite input the user has already typed into the
 * form on screen — i.e. the form has moved off its initial seed. Drives the
 * affordance's warning copy; it never suppresses the offer.
 */
export function draftConflictsWithInput({
  currentSig,
  initialSig,
}: {
  currentSig: string;
  initialSig: string;
}): boolean {
  return currentSig !== initialSig;
}

/**
 * Whether a snapshot is worth persisting: only once the form has moved off the
 * state it mounted with. A pristine form writes nothing, so opening and closing a
 * blank create form never leaves a draft — and never overwrites the one being
 * offered.
 */
export function shouldPersistDraft({
  currentSig,
  initialSig,
}: {
  currentSig: string;
  initialSig: string;
}): boolean {
  return currentSig !== initialSig;
}

/**
 * Group `[name, value]` pairs into a name → values multimap, preserving document
 * order within a name. Restoring walks the live form's elements and consumes from
 * this, so repeated names (a checkbox group, a repeated row field) line up with the
 * elements that produced them.
 */
export function fieldMultimap(
  fields: readonly DraftField[]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [name, value] of fields) {
    const bucket = map.get(name);
    if (bucket) bucket.push(value);
    else map.set(name, [value]);
  }
  return map;
}

/**
 * A human-facing "when" for the resume affordance: `14:32` for a draft from today,
 * else a short date + time. Formatted from the viewer's own locale clock — a draft
 * is device-local state, so the device's clock is the honest reference (unlike
 * stored records, which are read in the profile's timezone).
 */
export function draftAgeLabel(savedAt: number, now: number): string {
  const then = new Date(savedAt);
  const time = then.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameDay = new Date(now).toDateString() === then.toDateString();
  if (sameDay) return time;
  const date = then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${date}, ${time}`;
}

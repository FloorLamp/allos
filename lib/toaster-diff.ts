// Pure diff logic shared by the app-wide completion toasters (ExtractionToaster
// for medical-document extraction, ImportJobsToaster for paste/CSV import jobs).
//
// Both poll a server action that returns the full set of the session's ACTIVE
// profile's documents/jobs with their current status, and toast when an item
// transitions into a terminal state. They diff each poll against a seed map
// captured on the first poll (seeded silently, so pre-existing terminal items
// don't re-announce on load).
//
// The subtlety this module isolates — and the bug it fixes (#296) — is that the
// polled set is scoped to whichever profile is active, but the seed ref survives
// a profile switch (the layout's client components don't remount on
// router.refresh()). Without resetting the seed on a switch, the new profile's
// entire terminal history reads as `before === undefined` and ghost-toasts as
// freshly finished. `shouldResetSeed` is the decision the caller uses to discard
// its seed on a switch so the new profile gets clean first-poll seed semantics.

export interface PolledItem {
  id: number;
  status: string;
}

export interface CompletionDiff<T extends PolledItem> {
  // Items that just reached a terminal status and therefore deserve a toast.
  finished: T[];
  // Whether the polled set changed vs the seed (drives router.refresh()).
  changed: boolean;
  // The map to store as the new seed for the next poll.
  next: Map<number, string>;
  // True when this call merely seeded the baseline (prev was null): nothing is
  // toasted and no refresh is warranted. The first poll of a profile — including
  // the poll right after a profile switch resets the seed — hits this path.
  seeded: boolean;
}

// Diff a fresh poll against the previous seed. `prev === null` means "no seed
// yet" (first poll, or the poll immediately after a profile-switch reset): seed
// silently and emit nothing.
//
// An item is "finished now" when it reaches a terminal status either from
// 'processing' (the async extraction path) OR from not-yet-seen
// (`before === undefined`). The undefined case is deliberate: a small
// deterministic import can land in a terminal state SYNCHRONOUSLY within a single
// poll interval (or a rejected/duplicate upload is inserted straight into a
// terminal state), so it's never observed as 'processing'. Because the first poll
// seeds `prev`, pre-existing terminal items are never in that undefined case on a
// live seed — which is exactly why the seed must be reset on a profile switch.
export function diffCompletions<T extends PolledItem>(
  prev: Map<number, string> | null,
  items: readonly T[],
  isTerminal: (status: string) => boolean
): CompletionDiff<T> {
  const next = new Map(items.map((i) => [i.id, i.status]));
  if (prev === null) {
    return { finished: [], changed: false, next, seeded: true };
  }
  const finished: T[] = [];
  let changed = next.size !== prev.size;
  for (const item of items) {
    const before = prev.get(item.id);
    if (before === undefined || before !== item.status) changed = true;
    const finishedNow =
      (before === "processing" || before === undefined) &&
      isTerminal(item.status);
    if (finishedNow) finished.push(item);
  }
  return { finished, changed, next, seeded: false };
}

// Whether a poll set now belongs to a different profile than the one the seed was
// built for. When true the caller must discard its seed (reset to null) so the
// switch gets first-poll seed semantics instead of announcing the new profile's
// entire terminal history as "just finished" (#296). A null `seededFor` means the
// seed hasn't been claimed by any profile yet (fresh mount), which is not a reset.
export function shouldResetSeed(
  seededFor: number | null,
  currentProfileId: number
): boolean {
  return seededFor !== null && seededFor !== currentProfileId;
}

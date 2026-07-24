// Pure keyed-upsert semantics for the app-wide toast list (#1315). The document
// lifecycle used to span TWO toast systems — the generic ToastProvider and the
// bespoke ExtractionToaster — so an upload confirmation and its extraction-complete
// toast could only ever STACK, never replace. Merging onto one system needs a
// keyed slot: a toast posted with a `key` REPLACES the live toast carrying the same
// key in place (position kept, timer reset via a bumped revision), and dismissKey
// clears it. This module isolates that list arithmetic so it's unit-tested without
// React (the provider is a thin wrapper over these two functions).

export interface KeyedToast {
  // Stable React identity — preserved across upserts of the same key so the DOM
  // node stays put (position is kept, the toast upgrades in place).
  id: number;
  // The upsert key. A keyless toast is always appended (no replacement).
  key?: string;
  // Bumped on every in-place replace so the card's auto-dismiss effect re-runs and
  // the countdown restarts (an unchanged duration alone wouldn't reset it).
  revision: number;
}

// Insert `incoming`, or REPLACE the live toast with the same key in place. On a
// match the existing id is kept (stable DOM node / position) and revision is
// bumped from the existing value (timer reset); the incoming id/revision are
// discarded. A keyless toast, or one whose key isn't live, is appended.
export function upsertToast<T extends KeyedToast>(list: T[], incoming: T): T[] {
  if (incoming.key != null) {
    const idx = list.findIndex((t) => t.key === incoming.key);
    if (idx >= 0) {
      const next = list.slice();
      next[idx] = {
        ...incoming,
        id: list[idx].id,
        revision: list[idx].revision + 1,
      };
      return next;
    }
  }
  return [...list, incoming];
}

// Remove the live toast with this key. An unknown key is a no-op (the list is
// returned unchanged in content).
export function dismissKeyed<T extends KeyedToast>(
  list: T[],
  key: string
): T[] {
  return list.filter((t) => t.key !== key);
}

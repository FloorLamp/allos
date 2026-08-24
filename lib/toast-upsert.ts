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
  // Set while the toast is playing its EXIT animation (#3373). It is still in the
  // list — which is what makes the phone's one-at-a-time queue hand over after the
  // outgoing bar has left rather than underneath it — but its countdown is over and
  // it leaves the list when the animation ends.
  exiting?: boolean;
  // Profile-owned receipts may outlive the route that posted them. The provider
  // keeps this subject stamp so a profile switch can clear every old-profile
  // card, including phone snackbars still waiting in the queue (#3611).
  profileId?: number;
  // Generation of the authenticated profile scope that created this receipt.
  // Profile id alone is insufficient when A logs out and later signs back into A:
  // a completion from the old session must not enter the new session's queue.
  profileToken?: number;
}

export interface ProfileToastScope {
  profileId: number;
  token: number;
}

export function acceptsProfileToast(
  active: ProfileToastScope | null,
  incoming: Pick<KeyedToast, "profileId" | "profileToken">
): boolean {
  if (incoming.profileId == null) return true;
  return (
    active != null &&
    active.profileId === incoming.profileId &&
    active.token === incoming.profileToken
  );
}

export function clearProfileToasts<T extends KeyedToast>(list: T[]): T[] {
  return list.filter((toast) => toast.profileId == null);
}

// Keep only unscoped toasts and receipts owned by the profile now in force. This
// is deliberately list-wide: below `md`, a previous profile's receipt may be
// queued and therefore have no mounted DOM node to dismiss individually.
export function dismissOtherProfileToasts<T extends KeyedToast>(
  list: T[],
  activeProfileId: number
): T[] {
  return list.filter(
    (toast) => toast.profileId == null || toast.profileId === activeProfileId
  );
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
        // An upgrade CANCELS a dismissal already in flight. Without this a keyed
        // replace that lands inside the 240ms exit window would swap the message
        // into a bar that is still sliding away, and the pending removal would
        // then take the NEW message off screen — the upgrade would look like a
        // toast that never arrived.
        exiting: false,
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

// Start the exit animation for one toast. The item stays in the list, marked, so
// (a) the card can switch from its enter class to its exit class and (b) the slot
// stays occupied for the length of the animation — on a phone, where one toast is
// visible at a time, that is what makes the next toast arrive AFTER this one has
// left instead of appearing underneath it mid-slide.
//
// Marking an already-exiting toast is a no-op that returns the SAME array, so a
// double dismissal (the auto-dismiss timer firing on a card the user just closed)
// does not re-render the stack or restart the animation.
export function beginExit<T extends KeyedToast>(list: T[], id: number): T[] {
  const idx = list.findIndex((t) => t.id === id && !t.exiting);
  if (idx < 0) return list;
  const next = list.slice();
  next[idx] = { ...list[idx], exiting: true };
  return next;
}

// Remove a toast once its exit animation has run. Deliberately conditional on
// `exiting`: a keyed replace that arrived during the animation cleared the flag
// (see upsertToast), and this pending removal must not take the upgrade with it.
export function dropExited<T extends KeyedToast>(list: T[], id: number): T[] {
  return list.filter((t) => !(t.id === id && t.exiting));
}

// The toasts actually on screen (#3373). Below `md` a toast is a full-width bar on
// the bottom edge, so exactly ONE is shown and the rest wait their turn in list
// order; from `md` up the corner stack shows them all.
//
// The queue is the LIST ITSELF plus this head selection — there is no second
// structure. That is what keeps the keyed-upsert semantics (#1315) intact for free:
// a replace still finds its slot wherever it is, upgrades the visible bar in place
// when it is the head, and edits a waiting toast without promoting it when it is
// not. And because a toast's countdown lives in the CARD, a queued toast has no
// mounted card and therefore no running timer — it cannot expire unseen.
export function visibleToasts<T extends KeyedToast>(
  list: T[],
  oneAtATime: boolean
): T[] {
  return oneAtATime ? list.slice(0, 1) : list;
}

// The dashboard "Recently resolved — reopen?" band's VIEWER-side hide (issue #1548).
//
// #1140 Part A gave each accessible profile's reopen-eligible episode a calm,
// dismissible line. That X lived in client `useState` only, so a dismissed line came
// back on the next reload for up to seven more days — the one X in the app that
// resurrects, which reads as a bug whatever the original "calm convenience" intent
// was. This module owns the persistence.
//
// WHAT IS PERSISTED, AND WHAT ISN'T. The stored thing is the READER's hide, keyed by
// login (see getRecentlyResolvedDismissed in lib/settings/display.ts for why per-login
// and why not the findings bus). Reopen ELIGIBILITY — the 7-day window computed by
// episodeReopenEligibility / reopenEligibleEpisodeForProfile — is untouched: this
// never opens, closes, extends, or shortens anything about an episode, and a caregiver
// on another login still sees the same line.
//
// WHY A STALE ID CAN'T SUPPRESS A FUTURE LINE (#203's recycling hazard does not
// apply): illness_episodes ids come from SQLite's rowid sequence and are never reused
// for a different episode within a database, so a remembered id can only ever refer to
// the episode it was stored for. Belt and braces on top of that, every write PRUNES
// the set down to the ids that are reopen-eligible RIGHT NOW, which both bounds the
// stored value at household scale and makes a resurrected-from-backup id self-clean.
//
// Auth-blind and login-id-first, per the write-core convention: the caller (the Server
// Action) has already resolved WHICH profiles this login may see and passes them in.

import { writeTx } from "./db";
import {
  getRecentlyResolvedDismissed,
  setRecentlyResolvedDismissed,
} from "./settings/display";
import { reopenEligibleEpisodeForProfile } from "./illness-episode-store";

// PURE: the lines a viewer should still be shown. Split out from the DB work so the
// page's filter and the action's validation can't drift into two different notions of
// "dismissed".
export function visibleRecentlyResolved<T extends { episodeId: number }>(
  items: T[],
  dismissedEpisodeIds: readonly number[]
): T[] {
  if (dismissedEpisodeIds.length === 0) return items;
  const hidden = new Set(dismissedEpisodeIds);
  return items.filter((i) => !hidden.has(i.episodeId));
}

// The episode ids currently inside their reopen window across a resolved profile set —
// the ONLY ids a dismissal may name, and the pruning basis for the stored set. Reuses
// reopenEligibleEpisodeForProfile (one computation, #221) rather than re-deriving the
// window, so the band, the action, and the prune can never disagree about eligibility.
export function reopenEligibleEpisodeIds(profileIds: number[]): number[] {
  const ids: number[] = [];
  for (const pid of profileIds) {
    const ep = reopenEligibleEpisodeForProfile(pid);
    if (ep) ids.push(ep.id);
  }
  return ids;
}

// Persist "hide this reopen line" for one login. Returns true when the set changed.
//
// Idempotent and self-pruning: the stored value becomes (already-dismissed ∪ {this
// id}) ∩ currently-eligible, so re-dismissing the same line is a no-op write and an
// id whose window has since closed drops out on the next dismissal. An id OUTSIDE the
// caller's eligible set is refused as a no-op — a tampered payload can neither
// suppress a line the login can't see nor grow the stored list without bound.
//
// One writeTx around the read-modify-write: two dismissals racing on the same login
// (two tabs, two lines) would otherwise be able to read the same "before" value and
// lose one of the two hides.
export function dismissRecentlyResolvedEpisode(
  loginId: number,
  profileIds: number[],
  episodeId: number
): boolean {
  if (!Number.isInteger(episodeId) || episodeId <= 0) return false;
  const eligible = new Set(reopenEligibleEpisodeIds(profileIds));
  if (!eligible.has(episodeId)) return false;
  return writeTx(() => {
    const before = getRecentlyResolvedDismissed(loginId);
    const next = [...new Set([...before, episodeId])].filter((id) =>
      eligible.has(id)
    );
    next.sort((a, b) => a - b);
    const unchanged =
      before.length === next.length && before.every((id, i) => id === next[i]);
    if (unchanged) return false;
    setRecentlyResolvedDismissed(loginId, next);
    return true;
  });
}

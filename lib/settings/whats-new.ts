// The "What's new" seen marker (issue #1421), stored per LOGIN in login_settings.
//
// Why the login tier: which release notes a person has read is a display
// preference of the login identity, not a fact about a tracked profile — an admin
// acting as three profiles has read the notes once, not three times. login_settings
// is a generic KV store, so this needs no schema change (the same shape as the
// one-time hints in ./hints.ts).
//
// Auth-blind by convention: this takes a loginId and never imports lib/auth — the
// Server Action layer owns the gate.

import { getLoginSetting, setLoginSetting } from "./kv";

export const WHATS_NEW_SEEN_KEY = "whats_new_seen_date";

/** The newest release-note date this login has seen, or null if it never has. */
export function getWhatsNewSeenDate(loginId: number): string | null {
  return getLoginSetting(loginId, WHATS_NEW_SEEN_KEY) ?? null;
}

/**
 * Advance the login's seen marker to `date` (an ISO `YYYY-MM-DD`). MONOTONIC: a
 * date at or before the stored one is a no-op, so a stale tab (or a rolled-back
 * image whose bundled notes are older) can never un-read newer notes.
 */
export function setWhatsNewSeenDate(loginId: number, date: string): void {
  const current = getWhatsNewSeenDate(loginId);
  if (current && current >= date) return;
  setLoginSetting(loginId, WHATS_NEW_SEEN_KEY, date);
}

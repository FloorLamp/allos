import {
  serializeEmergencyPayload,
  type EmergencyCard,
} from "@/lib/emergency-card";

// Client-side offline store for the Emergency Card (issue #42). The card's offline
// copy lives in localStorage under a single well-known key: the authenticated
// /emergency page refreshes it on every visit (so a med change propagates the next
// time the card is opened online), and the /offline fallback reads it when there's
// no network. localStorage is same-origin and survives being offline, and — unlike
// stashing PHI in the service-worker HTTP cache — it's trivially clearable, which
// is how logout / profile-switch wipe it (see clearEmergencyPayload, wired into
// components/UserMenu.tsx).
//
// The payload is versioned + profile-stamped (see lib/emergency-card), so a stale
// blob from another profile or an older schema is ignored on read rather than
// mis-rendered.

export const EMERGENCY_LS_KEY = "allos:emergency-card";

// True in a browser context with a usable localStorage (SSR / private-mode guards).
function hasStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

// Persist the profile's card for offline use. Best-effort: a full/blocked quota
// throws, which we swallow — the online card still works, only the offline copy
// is skipped.
export function writeEmergencyPayload(
  profileId: number,
  card: EmergencyCard
): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      EMERGENCY_LS_KEY,
      serializeEmergencyPayload(profileId, card)
    );
  } catch {
    /* quota / disabled storage — offline copy simply isn't cached */
  }
}

// Remove the offline copy. Called when the opt-in is off, and on logout / profile
// switch so one profile's card never lingers for the next login/profile.
export function clearEmergencyPayload(): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(EMERGENCY_LS_KEY);
  } catch {
    /* ignore */
  }
}

export function readEmergencyPayloadRaw(): string | null {
  if (!hasStorage()) return null;
  try {
    return window.localStorage.getItem(EMERGENCY_LS_KEY);
  } catch {
    return null;
  }
}

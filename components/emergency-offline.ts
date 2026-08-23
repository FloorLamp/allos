import {
  serializeEmergencyPayload,
  type EmergencyCard,
} from "@/lib/emergency-card";

// Client-side offline store for the Emergency Card (issue #42). The card's offline
// copy lives in localStorage under a single well-known key: the authenticated
// Passport page (/profile#emergency since the #1042 phase-3 merge) refreshes it on
// every visit (so a med change propagates the next time the card is opened
// online), and the /offline fallback reads it when there's
// no network. localStorage is same-origin and survives being offline, and — unlike
// stashing PHI in the service-worker HTTP cache — it's trivially clearable, which
// is how logout / profile-switch wipe it (see clearEmergencyPayload, wired into
// components/SidebarContent.tsx).
//
// The payload is versioned + profile-stamped (see lib/emergency-card), so a stale
// blob from another profile or an older schema is ignored on read rather than
// mis-rendered.

export const EMERGENCY_LS_KEY = "allos:emergency-card";

// True in a browser context with a usable localStorage (SSR / private-mode guards).
//
// THE PROPERTY READ IS ITSELF THE THROWING PART, which is why the try is here and
// not around each caller's own `setItem`/`getItem`/`removeItem`. With site data
// blocked, Chrome throws `SecurityError` from the `window.localStorage` GETTER —
// before any method is reached — so every guard written one level down is a guard
// on the wrong statement. `clearEmergencyPayload` was never the culprit: it already
// wraps its own `removeItem`, and the throw happened above it in this predicate.
//
// That mattered most on the logout path. `wipeDeviceForSignOut` calls
// `clearEmergencyPayload` OUTSIDE its own try (components/device-wipe.ts), so a
// throw here rejected the wipe, which rejected `logoutAfterWipe`, which is invoked
// as `void logoutAfterWipe()` — an unhandled rejection, a tap that did nothing, and
// nothing said. One try here covers all three readers/writers below at once, which
// is why it is here rather than in the one that happened to be on fire (#3605).
function hasStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !!window.localStorage;
  } catch {
    /* site data blocked — no offline copy is possible, and that is not an error */
    return false;
  }
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

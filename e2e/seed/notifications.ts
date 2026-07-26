// e2e seed fixtures — notifications domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { E2E_LOGIN_HA_NOTIFY, HA_NOTIFY_PROFILE } from "../fixture-logins";
import { seedMemberLogin, fixtureProfileId } from "./common";

// ── Home Assistant notification config ──
export function seedHaConfig(): void {
  // ── HA notification-config fixture (post-#1025 isolation) ─────────────────────
  // A dedicated adult profile for home-assistant-notify.spec.ts. The spec persists a
  // real (unreachable) HA webhook config; since #1025 the temperature write paths
  // dispatch the red-flag nudge immediately, so that config must never live on a
  // profile other specs log temperatures for (a failed real send would overwrite the
  // GLOBAL delivery-health marker seeded above for notify-delivery-error.spec.ts).
  // No health data needed — the spec reads and writes only notification settings.
  const haNotifyId = fixtureProfileId(HA_NOTIFY_PROFILE);
  seedMemberLogin(E2E_LOGIN_HA_NOTIFY, haNotifyId, "write");
  console.log(
    `e2e: seeded HA notification-config fixture — profile ${haNotifyId} (${HA_NOTIFY_PROFILE})`
  );
}

// e2e seed fixtures — notifications domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import {
  DIGEST_TUNE_PROFILE,
  E2E_LOGIN_DIGEST_TUNE,
  E2E_LOGIN_HA_NOTIFY,
  HA_NOTIFY_PROFILE,
} from "../fixture-logins";
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

// ── Morning-digest ⚙️ Tune mirror (#1714) ──
export function seedDigestTune(): void {
  // A dedicated adult profile + login for digest-tune.spec.ts. The spec toggles
  // LOGIN-scoped digest preferences that persist for the worker's whole run, so it
  // must not share a login with any other spec. No health data is needed — the mirror
  // lists every tunable category unconditionally, and what a demotion does to an
  // actual digest is pinned in the pure and DB tiers.
  const id = fixtureProfileId(DIGEST_TUNE_PROFILE);
  seedMemberLogin(E2E_LOGIN_DIGEST_TUNE, id, "write");
  console.log(
    `e2e: seeded digest-tune fixture — profile ${id} (${DIGEST_TUNE_PROFILE})`
  );
}

// e2e seed fixtures — coverage-gaps domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db } from "../../lib/db";
import { now as clockNow } from "../../lib/clock";
import { utcSqlString } from "../../lib/date";
import { upsertConnection } from "../../lib/integrations/connections";
import { syncFailureCopy } from "../../lib/integrations/auth-failure";
import {
  E2E_LOGIN_CHILD,
  E2E_LOGIN_HC,
  E2E_LOGIN_STRAVA,
  HEALTH_CONNECT_PROFILE,
  STRAVA_REAUTH_PROFILE,
} from "../fixture-logins";
import { seedMemberLogin, fixtureProfileId, ins } from "./common";

// ── E2E coverage-gap fixtures (life stage + integration-state profiles) ──
export function seedCoverageGaps(): void {
  // ── E2E coverage-gap fixtures (issue #391) ────────────────────────────────────
  // Fill the browser-coverage holes the audit flagged: share links, immunizations,
  // equipment, Strava/Health-Connect integration states, care-plan, AI-logs gate,
  // and appointments. Anything that needs a NON-profile-1 active profile is served
  // by a purpose-built member login + grant (created directly below) so the spec can
  // sign in as an isolated session in its own cookie context — never mutating the
  // shared admin storageState's active profile. All synthetic; idempotent.

  // Riley (child) is seeded by scripts/seed.ts; grant the child member to it.
  const rileyId = (
    db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get("Riley (child)") as { id: number } | undefined
  )?.id;
  if (rileyId) seedMemberLogin(E2E_LOGIN_CHILD, rileyId);

  // A dedicated profile whose Strava connection sits in the terminal `needs_reauth`
  // state (dead/revoked refresh token, #326/#352): config kept (client id/secret) but
  // NO access token, so the page reads !connected + needsReauth → the reconnect CTA.
  const stravaReauthId = fixtureProfileId(STRAVA_REAUTH_PROFILE);
  upsertConnection(stravaReauthId, "strava", {
    status: "needs_reauth",
    config: {
      clientId: "e2e-reauth-client",
      clientSecret: "e2e-reauth-secret",
    },
  });
  db.prepare(
    `DELETE FROM integration_sync_events
      WHERE profile_id = ? AND source_id = 'strava'`
  ).run(stravaReauthId);
  ins.run(
    stravaReauthId,
    "strava",
    utcSqlString(new Date(clockNow().getTime() - 60 * 60 * 1000)),
    0,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    syncFailureCopy("Strava", "reconnect")
  );
  seedMemberLogin(E2E_LOGIN_STRAVA, stravaReauthId);

  // A dedicated, connection-less profile for the Health Connect generate→rotate flow.
  const healthConnectId = fixtureProfileId(HEALTH_CONNECT_PROFILE);
  seedMemberLogin(E2E_LOGIN_HC, healthConnectId);

  console.log(
    `e2e: seeded member logins for the child (${rileyId}), Strava-reauth (${stravaReauthId}), and Health-Connect (${healthConnectId}) fixture profiles (#391)`
  );
}

// e2e seed fixtures — coverage-gaps domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db } from "../../lib/db";
import { now as clockNow } from "../../lib/clock";
import { utcSqlString } from "../../lib/date";
import { upsertConnection } from "../../lib/integrations/connections";
import { hashShareToken } from "../../lib/share-token";
import { setMinTrainingAge } from "../../lib/age-gate";
import {
  E2E_LOGIN_CHILD,
  E2E_LOGIN_HC,
  E2E_LOGIN_MOBILE_HC,
  MOBILE_HC_PROFILE,
  E2E_LOGIN_STRAVA,
  HEALTH_CONNECT_PROFILE,
  STRAVA_REAUTH_PROFILE,
} from "../fixture-logins";
import { seedMemberLogin, fixtureProfileId } from "./common";

// ── E2E coverage-gap fixtures (age gate + integration-state profiles) ──
export function seedCoverageGaps(): void {
  // ── E2E coverage-gap fixtures (issue #391) ────────────────────────────────────
  // Fill the browser-coverage holes the audit flagged: share links, immunizations,
  // equipment, Strava/Health-Connect integration states, care-plan, AI-logs gate,
  // and appointments. Anything that needs a NON-profile-1 active profile is served
  // by a purpose-built member login + grant (created directly below) so the spec can
  // sign in as an isolated session in its own cookie context — never mutating the
  // shared admin storageState's active profile. All synthetic; idempotent.

  // The instance-wide age gate, ON at 13 whole years. This is deliberately global,
  // but SAFE for every existing spec: it restricts ONLY a profile whose known age is
  // under 13, and the sole such profile is the ~18-month-old "Riley (child)". Profile
  // 1 (the admin's active profile, ~40y) is never restricted, so the training /
  // equipment specs that run as profile 1 are untouched; Test Child / Sam Rivers have
  // no birthdate → unknown age → never restricted; and the demo webServer boots from
  // scripts/seed.ts ONLY (no seed-events), so its DB never sees this setting. The two
  // child-profile specs (kids-growth, pediatric-ranges) only visit Trends / Settings /
  // Biomarkers as Riley — none of which the gate touches. The equipment-manager spec
  // uses it to prove /equipment bounces a restricted profile to the dashboard.
  setMinTrainingAge(13);

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
  seedMemberLogin(E2E_LOGIN_STRAVA, stravaReauthId);

  // A dedicated, connection-less profile for the Health Connect generate→rotate flow.
  const healthConnectId = fixtureProfileId(HEALTH_CONNECT_PROFILE);
  seedMemberLogin(E2E_LOGIN_HC, healthConnectId);

  // #1063 — a dedicated Health Connect profile seeded already CONNECTED so the
  // mobile-overflow spec renders the endpoint card read-only (never generating or
  // rotating — those mutations belong to the E2E_LOGIN_HC spec above and would race a
  // concurrent reader). Since #1209 the token is HASHED at rest, so we seed only its
  // SHA-256 (`tokenHash`), not a plaintext — `connected` gates on `hasToken`, which
  // reads `tokenHash`. The plaintext is never re-shown (reveal-once), so the wide
  // element under test at phone width is the endpoint-URL row, not the token.
  const mobileHcId = fixtureProfileId(MOBILE_HC_PROFILE);
  upsertConnection(mobileHcId, "health-connect", {
    status: "connected",
    config: {
      // The stored hash of a synthetic value (a real generate stores the same shape:
      // sha256 hex). Deliberately derived from a LOW-entropy input so no random-looking
      // literal appears — the value here is a 64-char hex HASH computed at seed time.
      tokenHash: hashShareToken("e2e0".repeat(16)),
      tokenCreatedAt: utcSqlString(
        new Date(clockNow().getTime() - 24 * 3600 * 1000)
      ),
    },
  });
  seedMemberLogin(E2E_LOGIN_MOBILE_HC, mobileHcId);

  console.log(
    `e2e: enabled age gate (13) + seeded member logins for the child (${rileyId}), Strava-reauth (${stravaReauthId}), and Health-Connect (${healthConnectId}) fixture profiles (#391)`
  );
}

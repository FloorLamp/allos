// Travel fixtures (#3263) — see e2e/logins/travel.ts for the shape and why it needs
// two logins.

import "../../scripts/load-env";

import { db } from "../../lib/db";
import {
  E2E_LOGIN_TRAVEL,
  E2E_LOGIN_TRAVEL_CARER,
  TRAVELLER_PROFILE,
  TRAVEL_COMPANION_PROFILE,
} from "../fixture-logins";
import { adultFixtureProfileId, seedMemberLogin, grantProfile } from "./common";

export function seedTravel(): void {
  // ORDER MATTERS. The companion is created first so it holds the lower id, which
  // makes it the carer login's ACTING profile on sign-in — the "acting for somebody
  // who is not you" case the banner must stay silent through.
  const companionId = adultFixtureProfileId(TRAVEL_COMPANION_PROFILE);
  const travellerId = adultFixtureProfileId(TRAVELLER_PROFILE);

  // Idempotent for a reused dev server: the spec MOVES this profile's zone, so a
  // second run must start from the run's pinned instance timezone again rather than
  // from wherever the last run's traveller landed.
  for (const key of [
    "timezone",
    "timezone_home",
    "timezone_switches",
    "timezone_travel_dismissed",
    // Retired by #3684. Clearing the fixture's legacy residue makes the E2E
    // assertion below prove that no current path writes it.
    "timezone_travel_tell",
  ]) {
    db.prepare(
      "DELETE FROM profile_settings WHERE profile_id = ? AND key = ?"
    ).run(travellerId, key);
  }

  const travellerLoginId = seedMemberLogin(
    E2E_LOGIN_TRAVEL,
    travellerId,
    "write"
  );
  db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
    travellerId,
    travellerLoginId
  );

  const carerLoginId = seedMemberLogin(
    E2E_LOGIN_TRAVEL_CARER,
    companionId,
    "write"
  );
  grantProfile(carerLoginId, travellerId, "write");
  // The carer's declared self is the TRAVELLER, and it is still acting as the
  // companion — so "own profile" and "acting profile" genuinely disagree here,
  // which is the only shape that can prove the gate rather than assume it.
  db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
    travellerId,
    carerLoginId
  );

  console.log(
    `e2e: seeded travel fixture — ${E2E_LOGIN_TRAVEL} own=${TRAVELLER_PROFILE} (${travellerId}), ` +
      `${E2E_LOGIN_TRAVEL_CARER} acting=${TRAVEL_COMPANION_PROFILE} (${companionId}) (#3263)`
  );
}

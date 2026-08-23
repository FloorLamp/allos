// e2e seed fixtures — Data → Trash domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db } from "../../lib/db";
import {
  E2E_LOGIN_TRASH_EAST,
  E2E_LOGIN_TRASH_WEST,
  TRASH_EAST_PROFILE,
  TRASH_EAST_TZ,
  TRASH_WEST_PROFILE,
  TRASH_WEST_TZ,
} from "../fixture-logins";
import { setFixtureTimezone } from "../fixture-timezones";
import { adultFixtureProfileId, seedMemberLogin } from "./common";

// ── Trash on its own calendar, and on its own bin (#3546 / #3547) ────────────
//
// Two adult profiles ~25 hours apart, one login each. See e2e/logins/trash.ts for why
// the zones are these two and why the logins are separate.
//
// NOTHING IS SEEDED INTO `deleted_rows` HERE, deliberately. The spec plants its own
// captures at the instant it needs and sweeps them (e2e/trash-probe.ts) — a seeded
// capture would have to survive the "Empty trash" test in the same file, which is the
// exact coupling #3547 exists to remove. What the seed owns is the ZONES and the
// EMPTINESS: a profile no other spec writes to, so an emptied Trash is a fact about
// this spec's rows and nobody else's.
export function seedTrashZones(): void {
  const eastId = adultFixtureProfileId(TRASH_EAST_PROFILE);
  const westId = adultFixtureProfileId(TRASH_WEST_PROFILE);
  setFixtureTimezone(db, eastId, "trash-east", TRASH_EAST_TZ);
  setFixtureTimezone(db, westId, "trash-west", TRASH_WEST_TZ);
  seedMemberLogin(E2E_LOGIN_TRASH_EAST, eastId, "write");
  seedMemberLogin(E2E_LOGIN_TRASH_WEST, westId, "write");
  console.log(
    `e2e: seeded trash timezone fixture — ${E2E_LOGIN_TRASH_EAST} → ${TRASH_EAST_PROFILE} (${eastId}, ${TRASH_EAST_TZ}), ` +
      `${E2E_LOGIN_TRASH_WEST} → ${TRASH_WEST_PROFILE} (${westId}, ${TRASH_WEST_TZ})`
  );
}

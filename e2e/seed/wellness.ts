// Wellness-domain e2e fixtures (#3066). See e2e/seed-events.ts for the rules these
// seeders live under.

import "../../scripts/load-env";

import { db } from "../../lib/db";
import {
  E2E_LOGIN_PRACTICE_ZERO,
  PRACTICE_ZERO_PROFILE,
} from "../fixture-logins";
import { adultFixtureProfileId, seedMemberLogin } from "./common";

// The practice zero state: a profile that tracks nothing and has logged nothing.
// Hard-cleared rather than merely not-seeded, so a reused server (or a previous
// run's spec that created the first practice and lost its cleanup) still starts
// this fixture in the state its name promises.
export function seedPracticeZero(): void {
  const id = adultFixtureProfileId(PRACTICE_ZERO_PROFILE);
  db.prepare(
    `DELETE FROM frequency_targets WHERE profile_id = ? AND scope_kind = 'practice'`
  ).run(id);
  db.prepare(`DELETE FROM practice_logs WHERE profile_id = ?`).run(id);
  seedMemberLogin(E2E_LOGIN_PRACTICE_ZERO, id, "write");
  console.log(
    `e2e: seeded practice zero-state fixture — profile ${id} (${PRACTICE_ZERO_PROFILE}) (#3066)`
  );
}

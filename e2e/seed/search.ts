// Global-search e2e fixtures (#5006). See e2e/seed-events.ts for the rules these
// seeders live under.

import "../../scripts/load-env";

import { db } from "../../lib/db";
import {
  E2E_LOGIN_SEARCH_RECORD,
  SEARCH_RECORD_PROFILE,
  SEARCH_RECORD_PRACTICE,
  SEARCH_RECORD_PRACTICE_DAY,
  SEARCH_RECORD_FOOD_GROUP,
  SEARCH_RECORD_FOOD_DAY,
  SEARCH_RECORD_SYMPTOM,
  SEARCH_RECORD_SYMPTOM_DAY,
} from "../fixture-logins";
import { adultFixtureProfileId, seedMemberLogin } from "./common";

// One profile, three rows: the practice session, the serving and the symptom the
// spec searches for. Idempotent — each kind's own rows are cleared and rewritten, so
// a reused dev server never accumulates them and never leaves a second row on a day
// the spec asserts the contents of.
export function seedSearchRecord(): void {
  const id = adultFixtureProfileId(SEARCH_RECORD_PROFILE);

  db.prepare("DELETE FROM practice_logs WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM food_log_events WHERE profile_id = ?").run(id);
  db.prepare("DELETE FROM symptom_logs WHERE profile_id = ?").run(id);

  db.prepare(
    `INSERT INTO practice_logs (profile_id, date, practice, duration_min, source)
     VALUES (?, ?, ?, 22, 'manual')`
  ).run(id, SEARCH_RECORD_PRACTICE_DAY, SEARCH_RECORD_PRACTICE);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, date, group_key, meal_slot)
     VALUES (?, ?, ?, 'Midday')`
  ).run(id, SEARCH_RECORD_FOOD_DAY, SEARCH_RECORD_FOOD_GROUP);
  db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
     VALUES (?, ?, ?, 2)`
  ).run(id, SEARCH_RECORD_SYMPTOM_DAY, SEARCH_RECORD_SYMPTOM);

  seedMemberLogin(E2E_LOGIN_SEARCH_RECORD, id, "write");
  console.log(
    `e2e: seeded search-into-the-record fixture — profile ${id} (${SEARCH_RECORD_PROFILE}); ` +
      `practice ${SEARCH_RECORD_PRACTICE_DAY}, food ${SEARCH_RECORD_FOOD_DAY}, ` +
      `symptom ${SEARCH_RECORD_SYMPTOM_DAY} (#5006)`
  );
}

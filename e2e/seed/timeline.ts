// e2e seed fixtures — timeline domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import { db } from "../../lib/db";
import {
  E2E_LOGIN_TL_CHROME,
  TL_CHROME_WELL_PROFILE,
  TL_CHROME_SICK_PROFILE,
  TL_CHROME_BUSY_DAY,
  TL_CHROME_SYMPTOM_DAY,
  TL_CHROME_QUIET_DAY,
  TL_CHROME_ACTIVITY,
} from "../fixture-logins";
import { seedMemberLogin, fixtureProfileId, grantProfile } from "./common";

// ── Timeline mobile chrome budget (#1517) ───────────────────────────────────
// One login over two profiles — see e2e/logins/timeline.ts for why the states have
// to live on separate profiles. Idempotent: each profile's own fixture rows are
// cleared and rewritten, so a reused dev server never accumulates them.
export function seedTimelineChrome(): void {
  // Created FIRST so it is the lowest accessible id and therefore the acting
  // profile on sign-in; the spec switches to the sick one explicitly.
  const wellId = fixtureProfileId(TL_CHROME_WELL_PROFILE);
  const sickId = fixtureProfileId(TL_CHROME_SICK_PROFILE);

  for (const id of [wellId, sickId]) {
    db.prepare(
      `DELETE FROM exercise_sets WHERE activity_id IN
         (SELECT id FROM activities WHERE profile_id = ?)`
    ).run(id);
    db.prepare(`DELETE FROM activities WHERE profile_id = ?`).run(id);
    db.prepare(`DELETE FROM symptom_logs WHERE profile_id = ?`).run(id);
  }

  // A single day with enough event cards to scroll past at 390px — without real
  // scroll range "the day nav is still there mid-page" is vacuously true.
  const insActivity = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, intensity, components, source)
     VALUES (?, ?, 'cardio', ?, ?, 5, 'easy', NULL, 'manual')`
  );
  for (let i = 1; i <= 20; i++) {
    insActivity.run(
      wellId,
      TL_CHROME_BUSY_DAY,
      `${TL_CHROME_ACTIVITY} ${i}`,
      20 + i
    );
  }

  // The well profile's ONE day with symptoms (worst-severity upsert, like the
  // runtime write core). TL_CHROME_QUIET_DAY deliberately gets nothing.
  const insSymptom = db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (profile_id, date, symptom)
     DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity)`
  );
  insSymptom.run(wellId, TL_CHROME_SYMPTOM_DAY, "cough", 2);
  insSymptom.run(wellId, TL_CHROME_SYMPTOM_DAY, "headache", 1);

  // The sick profile carries an ACTIVE illness-type situation and NO symptom rows,
  // so its quiet day isolates the situation branch of the auto-expand.
  const existing = db
    .prepare("SELECT id FROM situations WHERE profile_id = ? AND name = ?")
    .get(sickId, "Illness") as { id: number } | undefined;
  const sitId =
    existing?.id ??
    Number(
      db
        .prepare(
          "INSERT INTO situations (profile_id, name, active, illness_type) VALUES (?, 'Illness', 1, 1)"
        )
        .run(sickId).lastInsertRowid
    );
  db.prepare(
    "UPDATE situations SET active = 1, illness_type = 1 WHERE id = ?"
  ).run(sitId);

  // Write grant on both: the spec performs no writes, but a read-only session
  // renders the app's read-only chrome, which is not the surface under test.
  const loginId = seedMemberLogin(E2E_LOGIN_TL_CHROME, wellId, "write");
  grantProfile(loginId, sickId, "write");

  console.log(
    `e2e: seeded Timeline chrome fixture — profiles ${wellId} (${TL_CHROME_WELL_PROFILE}) ` +
      `+ ${sickId} (${TL_CHROME_SICK_PROFILE}); quiet day ${TL_CHROME_QUIET_DAY} (#1517)`
  );
}

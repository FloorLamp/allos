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
  TL_CHROME_TICK_DOC,
  TL_CHROME_TICK_TIME,
  E2E_LOGIN_TL_EMPTY,
  TL_EMPTY_PROFILE,
} from "../fixture-logins";
import { seedMemberLogin, fixtureProfileId, grantProfile } from "./common";
import { getTimezone } from "../../lib/settings";
import { zonedWallTimeToUtc, utcSqlString } from "../../lib/date";

// ── Timeline mobile chrome budget (#1517) ───────────────────────────────────
// One login over two profiles — see e2e/logins/history.ts for why the states have
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
    db.prepare(`DELETE FROM medical_documents WHERE profile_id = ?`).run(id);
  }

  // A single day with enough event cards to scroll past at 390px — without real
  // scroll range "the day nav is still there mid-page" is vacuously true.
  //
  // THE SESSIONS CARRY CLOCK TIMES (#4974). They were day-granular, and a
  // day-granular event sorts to the BOTTOM of its day (`sortTimelineEvents` reads a
  // missing time as ""), so the day's one marked event — the document below — landed
  // at the TOP of the feed with nothing above it and its tick tap scrolled 97px, too
  // little to carry the rail up to its own pinned inset. Timed, they sort above the
  // document, which puts its row at the foot of a twenty-one row day and the jump
  // past the pin. 06:30 onwards at half-hour spacing, which is also simply what a
  // busy day looks like.
  const insActivity = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, intensity, components, source, start_time)
     VALUES (?, ?, 'cardio', ?, ?, 5, 'easy', NULL, 'manual', ?)`
  );
  for (let i = 1; i <= 20; i++) {
    const minutes = 6 * 60 + i * 30;
    const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
      minutes % 60
    ).padStart(2, "0")}`;
    insActivity.run(
      wellId,
      TL_CHROME_BUSY_DAY,
      `${TL_CHROME_ACTIVITY} ${i}`,
      20 + i,
      hhmm
    );
  }

  // The busy day's ONE TICK (#4974). The sessions above are drawn as windowed
  // BLOCKS — a session with a start and a length is never double-drawn as a mark —
  // so the day's tick rail is this document and nothing else, and the tap has one
  // unambiguous subject. A document's timeline event takes its clock time from
  // `uploaded_at` in the profile's zone, so the instant is built through the same
  // helper every other fixture instant is. Earliest thing on the day, which is what
  // sorts its row to the foot of the feed. This is the only fixture day both long
  // enough for the rail to have somewhere to stick and marked for the tap to land.
  db.prepare(
    `INSERT INTO medical_documents
       (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
        extraction_status, extracted_count, uploaded_at)
     VALUES (?, ?, '', 'application/pdf', 2048, 'Lab report', 'done', 1, ?)`
  ).run(
    wellId,
    TL_CHROME_TICK_DOC,
    utcSqlString(
      zonedWallTimeToUtc(
        getTimezone(wellId),
        TL_CHROME_BUSY_DAY,
        TL_CHROME_TICK_TIME
      )!
    )
  );

  // The well profile's ONE seeded day with symptoms (worst-severity upsert, like the
  // runtime write core). It is also what earns the profile its Symptoms chip, since
  // the Add past row offers the kinds a profile has rows for. TL_CHROME_QUIET_DAY
  // deliberately gets nothing — it is where the spec's own two writing tests
  // (the add door, and the ⋯ correction) plant and clear their rows.
  const insSymptom = db.prepare(
    `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (profile_id, date, symptom)
     DO UPDATE SET severity = MAX(symptom_logs.severity, excluded.severity)`
  );
  insSymptom.run(wellId, TL_CHROME_SYMPTOM_DAY, "cough", 2);
  insSymptom.run(wellId, TL_CHROME_SYMPTOM_DAY, "headache", 1);

  // The sick profile carries an ACTIVE illness-type situation and NO symptom rows,
  // so its quiet day isolates the branch that used to auto-open the retired card
  // (#4851 item 3) and now must draw no symptom surface at all.
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

  // Write grant on both: the add door only draws for a login that may write, and a
  // read-only session renders the app's read-only chrome, which is not the surface
  // under test.
  const loginId = seedMemberLogin(E2E_LOGIN_TL_CHROME, wellId, "write");
  grantProfile(loginId, sickId, "write");

  console.log(
    `e2e: seeded Timeline chrome fixture — profiles ${wellId} (${TL_CHROME_WELL_PROFILE}) ` +
      `+ ${sickId} (${TL_CHROME_SICK_PROFILE}); quiet day ${TL_CHROME_QUIET_DAY} (#1517)`
  );
}

// ── Timeline base empty state (#1410) ───────────────────────────────────────
// A login over ONE profile with NOTHING on it. There is deliberately no data to
// write: `fixtureProfileId` creates the profile exactly the way production creates
// one (standard metric SAVES only, which are chart membership — not timeline
// events), so the profile arrives genuinely empty and stays that way under
// --repeat-each because its spec only reads. Idempotent like every fixture here.
export function seedTimelineEmpty(): void {
  const emptyId = fixtureProfileId(TL_EMPTY_PROFILE);
  seedMemberLogin(E2E_LOGIN_TL_EMPTY, emptyId, "write");
  console.log(
    `e2e: seeded Timeline empty-state fixture — profile ${emptyId} (${TL_EMPTY_PROFILE}), no events (#1410)`
  );
}

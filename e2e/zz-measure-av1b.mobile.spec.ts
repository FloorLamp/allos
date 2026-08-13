import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import { utcInstant, zonedWallTimeToUtc } from "../lib/date";

// TEMPORARY. Prints the #2612 before/after page height on the census's own shape:
// 10 routine supplement doses a day against 2-5 illness rows (the issue's words),
// on a spec-owned episode so the numbers do not depend on the shared seed.
const P = 1;
const SIT = "E2e Measure Illness";
const SYMS = ["e2e-measure-ache", "e2e-measure-cough"];
const NOTE = "e2e-measure-fixture";
const STACK = Array.from({ length: 10 }, (_, i) => `E2e Measure Supp ${i}`);
const MED = "E2e Measure Ibuprofen";

function openDb() {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}
function day(tz: string, off: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(
    new Date(frozenNow().getTime() + off * 86_400_000)
  );
}
function clean(db: Database.Database) {
  const all = [...STACK, MED];
  const q = all.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ? AND name IN (${q}))`
  ).run(P, ...all);
  db.prepare(
    `DELETE FROM intake_items WHERE profile_id = ? AND name IN (${q})`
  ).run(P, ...all);
  db.prepare(
    `DELETE FROM symptom_logs WHERE profile_id = ? AND symptom IN (?, ?)`
  ).run(P, ...SYMS);
  db.prepare(`DELETE FROM medical_records WHERE profile_id = ? AND notes = ?`).run(P, NOTE);
  db.prepare(`DELETE FROM illness_episodes WHERE profile_id = ? AND situation = ?`).run(P, SIT);
}

test("MEASURE2612", async ({ page }) => {
  test.slow();
  const db = openDb();
  clean(db);
  const tz =
    (
      db
        .prepare(
          `SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'`
        )
        .get(P) as { value: string } | undefined
    )?.value || "UTC";
  const days = [-224, -223, -222, -221].map((o) => day(tz, o));
  const epId = Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date) VALUES (?,?,?,?)`
      )
      .run(P, SIT, days[0], days.at(-1)!).lastInsertRowid
  );
  for (const d of days) {
    for (const s of SYMS)
      db.prepare(
        `INSERT INTO symptom_logs (profile_id, date, symptom, severity, episode_id) VALUES (?,?,?,2,?)`
      ).run(P, d, s, epId);
    db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, value, value_num, unit, canonical_name, source, occurred_at, notes)
       VALUES (?,?,'vitals','Body Temperature','101.2',101.2,'degF','Body Temperature','manual',?,?)`
    ).run(P, d, utcInstant(zonedWallTimeToUtc(tz, d, "08:00")!), NOTE);
  }
  let supp = 0;
  const mk = (name: string, kind: string, amount: string, hour: number) => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation) VALUES (?,?,1,?,'daily','may')`
        )
        .run(P, name, kind).lastInsertRowid
    );
    const dose = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort) VALUES (?,?,'anytime','any',0)`
        )
        .run(id, amount).lastInsertRowid
    );
    for (const d of days)
      db.prepare(
        `INSERT INTO intake_item_logs (dose_id,item_id,date,occurred_at,status,amount) VALUES (?,?,?,?, 'taken', ?)`
      ).run(dose, id, d, utcInstant(zonedWallTimeToUtc(tz, d, `${`0${hour}`.slice(-2)}:05`)!), amount);
  };
  STACK.forEach((n, i) => {
    mk(n, "supplement", "1 serving", 6 + (i % 12));
    supp += days.length;
  });
  mk(MED, "medication", "200 mg", 19);
  db.close();

  await page.goto(`/medical/episodes/${epId}`);
  await expect(page.getByTestId("episode-illness-timeline")).toBeVisible();
  const m = await page.evaluate(() => ({
    h: document.documentElement.scrollHeight,
    cap:
      document.querySelector('[data-testid="fever-chart-doses"]')?.getBoundingClientRect()
        .height ?? -1,
    rows: [
      ...document.querySelectorAll('[data-testid="episode-illness-timeline"] tbody tr'),
    ].filter((r) => (r as HTMLElement).offsetParent !== null).length,
  }));
  console.log(
    `MEASURE2612 supplementDoses=${supp} medicineDoses=${days.length} docHeight=${m.h} captionH=${Math.round(m.cap)} laidOutRows=${m.rows}`
  );
  const c = openDb();
  clean(c);
  c.close();
});

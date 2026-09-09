import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { db, rawDb, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { doseScheduleAsOf } from "@/lib/intake-cadence";
import { runMigrations } from "@/lib/migrations/runner";
import { MIGRATIONS, migrationsBefore } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/20260907-dose-schedule-amount";
import { logHistoricalDose } from "@/lib/queries/intake/adherence";
import { getDoseScheduleVersions } from "@/lib/queries/intake/schedule";
import { setTimezone } from "@/lib/settings";
import { captureDelete, restoreDeletedRow } from "@/lib/undo-delete-db";
import type { SqlPrepare } from "@/lib/write-revision";

const MIGRATION = "20260907-dose-schedule-amount";

type DbHandle = SqlPrepare;

function insertItem(handle: DbHandle, profileId: number, name: string): number {
  return Number(
    handle
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, obligation)
         VALUES (?, ?, 'supplement', 'should')`
      )
      .run(profileId, name).lastInsertRowid
  );
}

function insertDose(
  handle: DbHandle,
  itemId: number,
  amount: string,
  time = "Morning"
): number {
  return Number(
    handle
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing)
         VALUES (?, ?, ?, 'any')`
      )
      .run(itemId, amount, time).lastInsertRowid
  );
}

function payloadOf<T>(handle: DbHandle, id: number): T {
  const row = handle
    .prepare("SELECT payload FROM deleted_rows WHERE id = ?")
    .get(id) as { payload: string };
  return JSON.parse(row.payload) as T;
}

it("backfills live versions and legacy Trash snapshots without changing known facts", () => {
  const mem = new Database(":memory:");
  runMigrations(mem, migrationsBefore(MIGRATION));
  mem.prepare("INSERT INTO profiles(id, name) VALUES (1, 'History')").run();
  const itemId = insertItem(mem, 1, "Migration dose");
  const amount = " 1 cap (500 mg) ";
  const doseId = insertDose(mem, itemId, amount);
  mem
    .prepare(
      `INSERT INTO intake_dose_schedule_versions
       (dose_id, effective_from, time_of_day)
     VALUES (?, '2026-08-01', 'Morning')`
    )
    .run(doseId);
  mem
    .prepare(
      `INSERT INTO intake_item_logs
       (dose_id, item_id, date, amount, status, recorded_at)
     VALUES (?, ?, '2026-08-02', 'existing 250 mg', 'taken', '2026-08-02T08:00:00Z')`
    )
    .run(doseId, itemId);
  const logBefore = mem
    .prepare("SELECT amount, hex(amount) AS bytes FROM intake_item_logs")
    .get();
  // A live row reusing a captured old id is deliberately the wrong authority for
  // historical payloads. The captured dose below says something else.
  mem
    .prepare(
      `INSERT INTO intake_item_doses
       (id, item_id, amount, time_of_day, food_timing)
     VALUES (73, ?, 'live 1000 mg', 'Evening', 'any')`
    )
    .run(itemId);

  const legacy = {
    v: 1,
    kind: "intake-item",
    rows: {
      item: [{ id: 60, name: "captured" }],
      doses: [
        { id: 71, amount: null },
        { id: 72, amount: "" },
        { id: 73, amount: "captured 500 mg" },
      ],
      doseVersions: [
        { id: 81, dose_id: 71, effective_from: "2026-01-01" },
        { id: 82, dose_id: 72, effective_from: "2026-01-02" },
        {
          id: 83,
          dose_id: 73,
          effective_from: "2026-01-03",
          amount: "known 500 mg",
          amount_captured: 1,
        },
        {
          id: 84,
          dose_id: 73,
          effective_from: "2026-01-04",
          amount: "already inferred 750 mg",
        },
        { id: 85, dose_id: 999, effective_from: "2026-01-05" },
        { id: 86, dose_id: 73, effective_from: "2026-01-06" },
      ],
      neighbor: [{ id: 91, note: "leave me" }],
    },
  };
  const malformed = "{not-json";
  const wrongShape = JSON.stringify({
    v: 1,
    kind: "intake-item",
    rows: { doses: "not-an-array", doseVersions: [] },
  });
  const unrelated = JSON.stringify({
    v: 1,
    kind: "activity",
    rows: {
      doses: [{ id: 71, amount: "wrong authority" }],
      doseVersions: [{ id: 81, dose_id: 71 }],
    },
  });
  const insertCapture = mem.prepare(
    `INSERT INTO deleted_rows (id, profile_id, kind, label, payload)
     VALUES (?, 1, ?, 'capture', ?)`
  );
  insertCapture.run(9001, "intake-item", JSON.stringify(legacy));
  insertCapture.run(9002, "intake-item", malformed);
  insertCapture.run(9003, "intake-item", wrongShape);
  insertCapture.run(9004, "activity", unrelated);

  runMigrations(mem, MIGRATIONS);

  expect(
    mem
      .prepare(
        "SELECT amount, amount_captured FROM intake_dose_schedule_versions"
      )
      .get()
  ).toEqual({ amount, amount_captured: 0 });
  expect(
    mem
      .prepare("SELECT amount, hex(amount) AS bytes FROM intake_item_logs")
      .get()
  ).toEqual(logBefore);

  const expected = structuredClone(legacy) as typeof legacy & {
    rows: { doseVersions: Record<string, unknown>[] };
  };
  Object.assign(expected.rows.doseVersions[0], {
    amount: null,
    amount_captured: 0,
  });
  Object.assign(expected.rows.doseVersions[1], {
    amount: "",
    amount_captured: 0,
  });
  Object.assign(expected.rows.doseVersions[5], {
    amount: "captured 500 mg",
    amount_captured: 0,
  });
  expect(payloadOf(mem, 9001)).toEqual(expected);
  expect(
    mem
      .prepare(
        "SELECT id, payload FROM deleted_rows WHERE id > 9001 ORDER BY id"
      )
      .all()
  ).toEqual([
    { id: 9002, payload: malformed },
    { id: 9003, payload: wrongShape },
    { id: 9004, payload: unrelated },
  ]);

  const rowsBeforeReplay = mem
    .prepare("SELECT id, payload FROM deleted_rows ORDER BY id")
    .all();
  const versionsBeforeReplay = mem
    .prepare(
      "SELECT id, amount, amount_captured FROM intake_dose_schedule_versions"
    )
    .all();
  up(mem);
  expect(
    mem.prepare("SELECT id, payload FROM deleted_rows ORDER BY id").all()
  ).toEqual(rowsBeforeReplay);
  expect(
    mem
      .prepare(
        "SELECT id, amount, amount_captured FROM intake_dose_schedule_versions"
      )
      .all()
  ).toEqual(versionsBeforeReplay);
  mem.close();
});

it("restores and writes from the captured historical amount after upgrading a real delete", () => {
  const profileId = Number(
    db.prepare("INSERT INTO profiles(name) VALUES ('Legacy Trash')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  const itemId = insertItem(db, profileId, "Legacy captured dose");
  const doseId = insertDose(db, itemId, "500 mg");
  const versionId = Number(
    db
      .prepare(
        `INSERT INTO intake_dose_schedule_versions
           (dose_id, effective_from, amount, amount_captured, time_of_day)
         VALUES (?, '2020-01-01', '500 mg', 0, 'Morning')`
      )
      .run(doseId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_logs
       (dose_id, item_id, date, amount, status, recorded_at)
     VALUES (?, ?, '2019-12-20', 'recorded 250 mg', 'taken', '2019-12-20T08:00:00Z')`
  ).run(doseId, itemId);

  const neighborItemId = insertItem(db, profileId, "Neighbor dose");
  const neighborDoseId = insertDose(db, neighborItemId, "25 mg", "Evening");
  db.prepare(
    `INSERT INTO intake_dose_schedule_versions
       (dose_id, effective_from, amount, amount_captured, time_of_day)
     VALUES (?, '2020-01-01', '25 mg', 1, 'Evening')`
  ).run(neighborDoseId);
  db.prepare(
    `INSERT INTO intake_item_logs
       (dose_id, item_id, date, amount, status, recorded_at)
     VALUES (?, ?, '2020-02-01', '25 mg', 'taken', '2020-02-01T20:00:00Z')`
  ).run(neighborDoseId, neighborItemId);
  const neighborRows = () => ({
    dose: db
      .prepare("SELECT * FROM intake_item_doses WHERE id = ?")
      .get(neighborDoseId),
    versions: db
      .prepare("SELECT * FROM intake_dose_schedule_versions WHERE dose_id = ?")
      .all(neighborDoseId),
    logs: db
      .prepare("SELECT * FROM intake_item_logs WHERE item_id = ?")
      .all(neighborItemId),
  });
  const neighborBefore = neighborRows();

  const undoId = captureDelete("intake-item", profileId, itemId)!;
  const captured = payloadOf<{
    rows: {
      doses: Record<string, unknown>[];
      doseVersions: Record<string, unknown>[];
    };
  }>(db, undoId);
  expect(captured.rows.doses[0]).toMatchObject({
    id: doseId,
    amount: "500 mg",
  });
  expect(captured.rows.doseVersions[0]).toMatchObject({
    id: versionId,
    dose_id: doseId,
  });
  delete captured.rows.doseVersions[0].amount;
  delete captured.rows.doseVersions[0].amount_captured;
  db.prepare("UPDATE deleted_rows SET payload = ? WHERE id = ?").run(
    JSON.stringify(captured),
    undoId
  );

  up(rawDb);
  const upgradedPayload = db
    .prepare("SELECT payload FROM deleted_rows WHERE id = ?")
    .pluck()
    .get(undoId) as string;
  const upgraded = payloadOf<typeof captured>(db, undoId);
  expect(upgraded.rows.doseVersions[0]).toMatchObject({
    id: versionId,
    dose_id: doseId,
    amount: "500 mg",
    amount_captured: 0,
  });
  up(rawDb);
  expect(
    (
      db
        .prepare("SELECT payload FROM deleted_rows WHERE id = ?")
        .get(undoId) as {
        payload: string;
      }
    ).payload
  ).toBe(upgradedPayload);

  expect(restoreDeletedRow(profileId, undoId)).toBe(true);
  const restored = db
    .prepare(
      `SELECT i.id AS itemId, d.id AS doseId, d.amount AS doseAmount,
              v.id AS versionId, v.dose_id AS versionDoseId,
              v.amount AS versionAmount, v.amount_captured AS amountCaptured
         FROM intake_items i
         JOIN intake_item_doses d ON d.item_id = i.id
         JOIN intake_dose_schedule_versions v ON v.dose_id = d.id
        WHERE i.profile_id = ? AND i.name = 'Legacy captured dose'`
    )
    .get(profileId) as {
    itemId: number;
    doseId: number;
    doseAmount: string;
    versionId: number;
    versionDoseId: number;
    versionAmount: string;
    amountCaptured: number;
  };
  expect(restored.itemId).not.toBe(itemId);
  expect(restored.doseId).not.toBe(doseId);
  expect(restored.versionId).not.toBe(versionId);
  expect(restored).toMatchObject({
    doseAmount: "500 mg",
    versionDoseId: restored.doseId,
    versionAmount: "500 mg",
    amountCaptured: 0,
  });
  expect(
    db
      .prepare(
        `SELECT item_id AS itemId, dose_id AS doseId, amount
           FROM intake_item_logs WHERE item_id = ? AND date = '2019-12-20'`
      )
      .get(restored.itemId)
  ).toEqual({
    itemId: restored.itemId,
    doseId: restored.doseId,
    amount: "recorded 250 mg",
  });
  expect(neighborRows()).toEqual(neighborBefore);

  const liveDose = db
    .prepare(
      `SELECT amount, time_of_day, weekdays, start_date, end_date
         FROM intake_item_doses WHERE id = ?`
    )
    .get(restored.doseId) as {
    amount: string | null;
    time_of_day: string | null;
    weekdays: string | null;
    start_date: string | null;
    end_date: string | null;
  };
  const versions = getDoseScheduleVersions(profileId).get(restored.doseId);
  expect(
    doseScheduleAsOf({ ...liveDose, versions }, "2019-01-01")
  ).toMatchObject({ amount: "500 mg", amountAssumed: true });

  const writeDate = shiftDateStr(today(profileId), -10);
  expect(
    logHistoricalDose(
      profileId,
      restored.itemId,
      restored.doseId,
      new Date(`${writeDate}T08:00:00.000Z`),
      null,
      false,
      "page"
    )
  ).toEqual({ kind: "logged", date: writeDate });
  expect(
    db
      .prepare(
        "SELECT amount FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(restored.doseId, writeDate)
  ).toEqual({ amount: "500 mg" });
});

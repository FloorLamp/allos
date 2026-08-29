// AUDIT PROBE (audit-0829) — not a shipped guard. Two catch-up surfaces asked what a
// PAST day owed, and compared. Delete with the audit.
import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { collectWindowDoses } from "@/lib/notifications/intake";
import { pendingDayDoses } from "@/lib/queries/usual-routine";

let seq = 0;
function newProfile(): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Audit Probe ${seq++}`).lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

function seedItem(profileId: number, name: string, condition: string): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, condition, obligation, active)
         VALUES (?, ?, 'medication', ?, 'must', 1)`
      )
      .run(profileId, name, condition).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 tab', 'Morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  const born = `${shiftDateStr(today(profileId), -30)}T00:00:00Z`;
  db.prepare("UPDATE intake_items SET created_at = ? WHERE id = ?").run(
    born,
    itemId
  );
  db.prepare("UPDATE intake_item_doses SET created_at = ? WHERE id = ?").run(
    born,
    doseId
  );
}

// A DRAFT HUSK (#3189): create-at-start row, never ended, nothing logged on it.
function seedHusk(profileId: number, date: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, start_time)
     VALUES (?, ?, 'strength', 'Session', ?)`
  ).run(profileId, date, `${date}T09:00:00Z`);
}

describe("PROBE: past-day workout context, reminder gather vs quick-log sheet", () => {
  it("a draft husk on yesterday", () => {
    const p = newProfile();
    const yesterday = shiftDateStr(today(p), -1);
    seedItem(p, "Rest day med", "rest_day");
    seedItem(p, "Pre workout med", "pre_workout");
    seedHusk(p, yesterday);

    const reminder = collectWindowDoses(p, "Morning", yesterday)
      .map((e) => e.item.name)
      .sort();
    const sheet = pendingDayDoses(p, yesterday)
      .map((d) => d.name)
      .sort();
    console.log(
      "  reminder gather (collectWindowDoses):",
      JSON.stringify(reminder)
    );
    console.log(
      "  quick-log sheet  (pendingDayDoses)  :",
      JSON.stringify(sheet)
    );
    // AUDIT PIN — asserts the DEFECT as it stands at fb8e79d83, so this branch is
    // green and re-runnable. INVERT to `toEqual(sheet)` when gatherWindowDoses takes
    // the husk-free reader on a past day.
    expect(reminder).toEqual(["Pre workout med"]);
    expect(sheet).toEqual(["Rest day med"]);
  });
});

// A REAL logged session (not a husk): it has a duration.
function seedSession(profileId: number, date: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, start_time, duration_min)
     VALUES (?, ?, 'strength', 'Session', ?, 45)`
  ).run(profileId, date, `${date}T09:00:00Z`);
}

describe("PROBE: past-day workout PREDICTION overriding the record", () => {
  it("a rhythm inferred today overrules yesterday's logged session", () => {
    const p = newProfile();
    const td = today(p);
    const yesterday = shiftDateStr(td, -1);
    seedItem(p, "Rest day med", "rest_day");
    seedItem(p, "Pre workout med", "pre_workout");
    // A habitual weekday: four distinct dates sharing TODAY's weekday, inside the
    // 8-week window. Yesterday's weekday is therefore NOT predicted.
    for (const back of [7, 14, 21, 28]) seedSession(p, shiftDateStr(td, -back));
    // ...and yesterday they actually trained. On the record, not a guess.
    seedSession(p, yesterday);

    const reminder = collectWindowDoses(p, "Morning", yesterday)
      .map((e) => e.item.name)
      .sort();
    const sheet = pendingDayDoses(p, yesterday)
      .map((d) => d.name)
      .sort();
    console.log(
      "  reminder gather (collectWindowDoses):",
      JSON.stringify(reminder)
    );
    console.log(
      "  quick-log sheet  (pendingDayDoses)  :",
      JSON.stringify(sheet)
    );
    // AUDIT PIN — the DEFECT as it stands at fb8e79d83. INVERT when gatherWindowDoses
    // stops applying today's rhythm prediction to a closed day.
    expect(reminder).toEqual(["Rest day med"]);
    expect(sheet).toEqual(["Pre workout med"]);
  });
});

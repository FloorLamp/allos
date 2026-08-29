// AUDIT PROBE (audit-0829) — not a shipped guard. `resolveDayDoses`'s day bound is
// `doseLogDays(today)`, which INCLUDES today; the sheet's switcher offers
// `doseLogDays(today).slice(1)`, which does not. So a forged POST naming TODAY reaches
// `pendingDayDoses(profile, today)` — the whole-day set, with no arrived-slot filter
// and no suppression filter — instead of the `collectDueDosesNow` slice the sheet
// renders for today. Delete with the audit.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { doseLogDays } from "@/lib/dose-log-window";
import { loadQuickEntry } from "@/app/(app)/quick-entry-actions";
import { resolveDayDoses } from "@/app/(app)/nutrition/intake-actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

// 08:30 local for a UTC profile — the bedtime dose has not arrived.
const NOW_ISO = "2026-08-28T08:30:00Z";
let priorNow: string | undefined;
beforeAll(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = NOW_ISO;
});
afterAll(() => {
  if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

function seedDose(profileId: number, name: string, timeOfDay: string): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition)
         VALUES (?, ?, 'supplement', 1, 'should', 'daily')`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 scoop', ?, 'any', 0)`
      )
      .run(itemId, timeOfDay).lastInsertRowid
  );
  const born = `${shiftDateStr(today(profileId), -30)} 09:00:00`;
  db.prepare(`UPDATE intake_items SET created_at = ? WHERE id = ?`).run(born, itemId);
  db.prepare(`UPDATE intake_item_doses SET created_at = ? WHERE id = ?`).run(born, doseId);
  return doseId;
}

function logsOn(profileId: number, date: string) {
  return db
    .prepare(
      `SELECT l.dose_id, l.status FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ? ORDER BY l.dose_id`
    )
    .all(profileId, date) as { dose_id: number; status: string }[];
}

describe("PROBE: resolveDayDoses admits TODAY, which the switcher never offers", () => {
  it("writes an evening dose at 08:30, outside today's due-now offer", async () => {
    const login = createLogin();
    const profile = createProfile("probe", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const melatonin = seedDose(profile.id, "Melatonin probe", "before sleep");
    const td = today(profile.id);

    const data = await loadQuickEntry("dose");
    if (data.form !== "dose") throw new Error("expected the dose form");
    console.log("  today's due-now offer :", JSON.stringify(data.doses.map((d) => d.doseId)));
    console.log("  switcher's pastDays   :", JSON.stringify(data.pastDays.map((d) => d.date)));
    console.log("  action's accepted days:", JSON.stringify(doseLogDays(td)));

    const r = await resolveDayDoses(fd({ date: td, status: "taken", dose_ids: String(melatonin) }));
    console.log("  resolveDayDoses(today):", JSON.stringify(r));
    console.log("  rows written on today :", JSON.stringify(logsOn(profile.id, td)));

    // The claim under probe: the sheet does not offer today as a switchable day,
    // and does not offer this dose today either — but the action writes it.
    expect(data.pastDays.map((d) => d.date)).not.toContain(td);
    expect(data.doses.map((d) => d.doseId)).not.toContain(melatonin);
    expect(logsOn(profile.id, td)).toEqual([]);
  });
});

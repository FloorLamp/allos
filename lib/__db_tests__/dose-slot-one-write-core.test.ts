// ONE WRITE CORE FOR A SLOT'S DOSES (#5063).
//
// The dashboard now seats a bucket's due doses as ONE row with a take-all, which is a
// second surface making the promise the quick-log sheet's whole-stack row already
// makes. The failure this file exists to catch is silent and expensive: the two
// surfaces agreeing on the WORDS while naming different doses, so "Take all 3" on the
// dashboard writes two of them and the sheet's stack writes three.
//
// So the claim is asserted as an EQUALITY between the two id sets, and then the write
// is run through the action both of them post — `resolveDayDoses`, via
// `useDoseDayResolution`, the one dated-dose bulk owner (#4316). Nothing here mocks a
// write: the ledger rows are read back out of the database afterwards.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { getDoseSlotClocks } from "@/lib/queries/intake/dose-slot-clock";
import { collectAttentionModel } from "@/lib/queries/attention";
import { attentionEntries } from "@/lib/dashboard-candidates";
import { pendingDayDoses } from "@/lib/queries/usual-routine";
import { resolveDayDoses } from "@/app/(app)/nutrition/intake-actions";
import {
  createLogin,
  createProfile,
  actAs,
  fd,
} from "@/lib/__action_tests__/harness";

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
  // Aged well behind the dose-lifetime bound (#430/#1442) so `pendingDayDoses` is
  // answering about an item that existed on the day this asserts about.
  const born = `${shiftDateStr(today(profileId), -30)} 09:00:00`;
  db.prepare(`UPDATE intake_items SET created_at = ? WHERE id = ?`).run(
    born,
    itemId
  );
  db.prepare(`UPDATE intake_item_doses SET created_at = ? WHERE id = ?`).run(
    born,
    doseId
  );
  return doseId;
}

function takenOn(profileId: number, date: string): number[] {
  return (
    db
      .prepare(
        `SELECT l.dose_id FROM intake_item_logs l
           JOIN intake_item_doses d ON d.id = l.dose_id
           JOIN intake_items i ON i.id = d.item_id
          WHERE i.profile_id = ? AND l.date = ? AND l.status = 'taken'
          ORDER BY l.dose_id`
      )
      .all(profileId, date) as { dose_id: number }[]
  ).map((row) => row.dose_id);
}

describe("a slot row and the quick sheet's stack write the same doses (#5063)", () => {
  it("names one set, and taking it logs exactly that set", async () => {
    const login = createLogin();
    const profile = createProfile("Slot core", login.id);
    actAs(login, profile);
    const day = today(profile.id);
    const morning = [
      seedDose(profile.id, "Beta-Glucan", "morning"),
      seedDose(profile.id, "Ground Flaxseed", "morning"),
      seedDose(profile.id, "Psyllium Husk", "morning"),
    ].sort((a, b) => a - b);
    // A bucket of one, seeded beside it: the slot row must not reach across into a
    // bucket that is still its own dose row, and an equality over the Morning set
    // alone could not tell the difference.
    const bedtime = seedDose(profile.id, "Magnesium", "before sleep");

    // What the DASHBOARD's slot row names — the entry the candidate builder emits.
    const slot = attentionEntries(collectAttentionModel(profile.id, day)).find(
      (entry) => entry.kind === "dose-slot"
    );
    expect(slot?.kind === "dose-slot" && slot.bucket).toBe("Morning");
    const slotIds =
      slot?.kind === "dose-slot"
        ? slot.items.map((item) => item.doseId!).sort((a, b) => a - b)
        : [];

    // What the QUICK SHEET's whole-stack row names — `groupDosesByBucket` over
    // exactly this read (app/(app)/quick-entry-actions.ts).
    const stackIds = pendingDayDoses(profile.id, day)
      .filter((dose) => dose.bucket === "Morning")
      .map((dose) => dose.doseId)
      .sort((a, b) => a - b);

    expect(slotIds).toEqual(morning);
    expect(stackIds).toEqual(slotIds);
    expect(slotIds).not.toContain(bedtime);

    // …and the tap, through the action both surfaces post.
    const result = await resolveDayDoses(
      fd({ date: day, status: "taken", dose_ids: slotIds.join(",") })
    );
    expect(result.ok).toBe(true);
    expect(takenOn(profile.id, day)).toEqual(morning);
  });
});

// #5813: a past-day slot states ONE time for the whole act. The chip reads the
// profile's own usual clock for the slot (`USUAL_KINDS.doseSlotClock`), and Take all
// writes that instant on every row it logs, under one bundle.
describe("a past-day slot's one time (#5813)", () => {
  function logTakenAt(doseId: number, date: string, hhmm: string | null) {
    const profileId = (
      db
        .prepare(
          `SELECT i.profile_id AS id FROM intake_item_doses d
             JOIN intake_items i ON i.id = d.item_id WHERE d.id = ?`
        )
        .get(doseId) as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, occurred_at, status)
       SELECT id, item_id, ?, ?, 'taken' FROM intake_item_doses WHERE id = ?`
    ).run(
      date,
      hhmm
        ? zonedWallTimeToUtc(getTimezone(profileId), date, hhmm)!.toISOString()
        : null,
      doseId
    );
  }

  function slotLogs(profileId: number, date: string) {
    return db
      .prepare(
        `SELECT l.occurred_at AS occurredAt, l.bundle_id AS bundleId
           FROM intake_item_logs l JOIN intake_items i ON i.id = l.item_id
          WHERE i.profile_id = ? AND l.date = ? AND l.status = 'taken'`
      )
      .all(profileId, date) as {
      occurredAt: string | null;
      bundleId: string | null;
    }[];
  }

  it("reads the usual clock from the profile's own evening logs, else the slot's opening", () => {
    const login = createLogin();
    const profile = createProfile("Slot clock", login.id);
    const day = today(profile.id);
    const evening = seedDose(profile.id, "Omega-3", "evening");
    const bedtime = seedDose(profile.id, "Magnesium", "before sleep");
    // Median 18:49 over three stated evenings. The untimed one and the one outside
    // the 14-day window are not evidence of a clock.
    logTakenAt(evening, shiftDateStr(day, -2), "18:40");
    logTakenAt(evening, shiftDateStr(day, -3), "18:49");
    logTakenAt(evening, shiftDateStr(day, -4), "19:30");
    logTakenAt(evening, shiftDateStr(day, -5), null);
    logTakenAt(evening, shiftDateStr(day, -20), "08:00");
    // Two bedtime clocks, one after midnight: under the floor of three.
    logTakenAt(bedtime, shiftDateStr(day, -2), "23:50");
    logTakenAt(bedtime, shiftDateStr(day, -3), "00:30");

    const clocks = getDoseSlotClocks(profile.id, day, getTimezone(profile.id));
    expect(clocks.Evening).toEqual({
      minute: 18 * 60 + 49,
      source: "recorded",
    });
    expect(clocks["Before sleep"]).toEqual({
      minute: 21 * 60,
      source: "declared",
    });
    expect(clocks.Anytime).toBeUndefined();

    // A clock past midnight still centres on its slot.
    logTakenAt(bedtime, shiftDateStr(day, -4), "00:10");
    expect(
      getDoseSlotClocks(profile.id, day, getTimezone(profile.id))[
        "Before sleep"
      ]
    ).toEqual({ minute: 10, source: "recorded" });
  });

  it.each([
    ["the stated time", "18:49"],
    ["Don't know", null],
  ])(
    "Take all with %s writes every row at it, under one bundle",
    async (_, at) => {
      const login = createLogin();
      const profile = createProfile("Slot take all", login.id);
      actAs(login, profile);
      const yesterday = shiftDateStr(today(profile.id), -1);
      const ids = [
        seedDose(profile.id, "Omega-3", "evening"),
        seedDose(profile.id, "Vitamin D", "evening"),
        seedDose(profile.id, "Zinc", "evening"),
      ];

      const result = await resolveDayDoses(
        fd({
          date: yesterday,
          status: "taken",
          dose_ids: ids.join(","),
          ...(at ? { at } : {}),
        })
      );
      expect(result.ok).toBe(true);

      const logs = slotLogs(profile.id, yesterday);
      expect(logs).toHaveLength(3);
      expect(new Set(logs.map((log) => log.bundleId)).size).toBe(1);
      expect(logs[0]!.bundleId).not.toBeNull();
      const instant = at
        ? zonedWallTimeToUtc(
            getTimezone(profile.id),
            yesterday,
            at
          )!.toISOString()
        : null;
      expect(
        logs.map(
          (log) => log.occurredAt && new Date(log.occurredAt).toISOString()
        )
      ).toEqual([instant, instant, instant]);
    }
  );
});

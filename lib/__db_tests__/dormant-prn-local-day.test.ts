import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";

const FROZEN_NOW = "2026-08-04T11:30:00.000Z";
let previousNow: string | undefined;

beforeEach(() => {
  previousNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = FROZEN_NOW;
});

afterEach(() => {
  if (previousNow === undefined) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = previousNow;
});

function profile(timezone: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('PRN boundary')").run()
      .lastInsertRowid
  );
  setTimezone(id, timezone);
  return id;
}

function prn(profileId: number, createdAt: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, created_at)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'may', ?)`
      )
      .run(profileId, createdAt).lastInsertRowid
  );
}

describe("dormant PRN local-day boundary (#3572)", () => {
  it("does not retire an east-of-UTC med that is 89 local days old", () => {
    const profileId = profile("Etc/GMT-13");
    prn(profileId, "2026-05-07 22:30:00"); // May 8 local; May 7 UTC

    expect(today(profileId)).toBe("2026-08-05");
    expect(loadMedicationsData(profileId).dormantPrn).toEqual([]);
  });

  it("retires a west-of-UTC med that is 90 local days old without leaking profiles", () => {
    const profileId = profile("Etc/GMT+12");
    const itemId = prn(profileId, "2026-05-06 06:00:00"); // May 5 local
    const otherProfileId = profile("UTC");
    prn(otherProfileId, "2020-01-01 00:00:00");

    expect(today(profileId)).toBe("2026-08-03");
    expect(
      loadMedicationsData(profileId).dormantPrn.map((item) => [
        item.itemId,
        item.daysSince,
      ])
    ).toEqual([[itemId, 90]]);
  });
});

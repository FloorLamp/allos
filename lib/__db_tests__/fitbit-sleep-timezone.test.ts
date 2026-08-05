import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { ZipBuilder } from "@/lib/zip-write";
import { importTakeoutArchive } from "@/lib/integrations/fitbit-takeout-import";
import { typicalWakeTime } from "@/lib/queries/sleep";
import { up as up155 } from "@/lib/migrations/versions/155-fitbit-sleep-instants";

// DB INTEGRATION TIER — #2096: a Fitbit Takeout night means the same moment
// whatever the SERVER's timezone is, both for a fresh import and for the rows that
// were already stored wrong.
//
// The bug was invisible at the parser boundary because the stored string LOOKED
// like a timestamp; it only became a wrong number several layers downstream, in
// typicalWakeTime — which seeds the auto-derived Morning intake hour, the digest
// hour, the Now strip's wake window and the Settings → Notifications display. So the
// end-to-end assertion is the one that matters, and it is made by flipping
// `process.env.TZ` around the SAME rows: production is Docker (UTC), a developer's
// laptop is not, and before the fix those two disagreed by four hours.

const TZ = "America/New_York";
const ROOT = "Takeout/Google Health";
const SEP = String.fromCharCode(0x1f);

// Fourteen consecutive nights, the minimum typicalWakeTime accepts. Every night is
// bed at 23:14:30 LOCAL and wake at 06:11:30 LOCAL — a mid-July New York window, so
// the correct instants are 04:14:30Z and 10:11:30Z and the correct typical wake
// CLOCK is 06:11 whatever machine reads it.
const WAKE_MINUTE = 6 * 60 + 11;

function sleepJson(): string {
  const logs = [];
  for (let d = 0; d < 14; d++) {
    const day = 10 + d; // 2026-07-10 … 2026-07-23 are the wake days
    const prev = String(day - 1).padStart(2, "0");
    const wake = String(day).padStart(2, "0");
    logs.push({
      logId: 900000 + d,
      dateOfSleep: `2026-07-${wake}`,
      startTime: `2026-07-${prev}T23:14:30.000`,
      endTime: `2026-07-${wake}T06:11:30.000`,
      duration: 417 * 60000,
      type: "stages",
      mainSleep: true,
      levels: {
        summary: {
          deep: { minutes: 58 },
          wake: { minutes: 91 },
          light: { minutes: 245 },
          rem: { minutes: 23 },
        },
      },
    });
  }
  return JSON.stringify(logs);
}

let profileId: number;
let archive: string;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('TZSLEEP')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, TZ);

  const zb = new ZipBuilder();
  const parts = [
    zb.file(
      `${ROOT}/Global Export Data/sleep-2026-07-01.json`,
      Buffer.from(sleepJson())
    ),
    zb.end(),
  ];
  archive = path.join(os.tmpdir(), `allos-takeout-sleep-tz-${process.pid}.zip`);
  fs.writeFileSync(archive, Buffer.concat(parts));
});

const serverTz = process.env.TZ;
afterEach(() => {
  if (serverTz === undefined) delete process.env.TZ;
  else process.env.TZ = serverTz;
});

function sleepRows(pid: number) {
  return db
    .prepare(
      `SELECT metric, date, start_time, end_time FROM metric_samples
        WHERE profile_id = ? AND source = 'fitbit-takeout' AND metric = 'sleep_min'
        ORDER BY date`
    )
    .all(pid) as {
    metric: string;
    date: string;
    start_time: string;
    end_time: string;
  }[];
}

describe("Fitbit Takeout sleep — the stored instant is not the server's opinion", () => {
  it("imports a zoneless vendor wall clock as the instant it denotes", () => {
    // Import under the zone production actually runs in.
    process.env.TZ = "UTC";
    const r = importTakeoutArchive(profileId, archive);
    expect(r.counts.inserted).toBeGreaterThan(0);

    const rows = sleepRows(profileId);
    expect(rows).toHaveLength(14);
    // The wake day is `dateOfSleep`, stated by the vendor — never zone-derived, and
    // it must not start moving now that the boundaries do.
    expect(rows[0].date).toBe("2026-07-10");
    expect(rows[0].start_time).toBe("2026-07-10T03:14:30.000Z");
    expect(rows[0].end_time).toBe("2026-07-10T10:11:30.000Z");
    // The stage rows carry the SAME instant under their `#stage` discriminator, so
    // one night's total and breakdown stay on one window.
    const deep = db
      .prepare(
        `SELECT start_time FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_deep_min' AND date = '2026-07-10'`
      )
      .get(profileId) as { start_time: string };
    expect(deep.start_time).toBe("2026-07-10T03:14:30.000Z#deep");
  });

  it("derives the same typical wake time under any server TZ", () => {
    // The four-hour swing this issue was filed for. Same rows, same profile zone,
    // different container.
    process.env.TZ = "UTC";
    expect(typicalWakeTime(profileId)).toBe(WAKE_MINUTE);
    process.env.TZ = "America/New_York";
    expect(typicalWakeTime(profileId)).toBe(WAKE_MINUTE);
    process.env.TZ = "Asia/Tokyo";
    expect(typicalWakeTime(profileId)).toBe(WAKE_MINUTE);
  });

  it("re-imports idempotently — no second copy of a night", () => {
    process.env.TZ = "Asia/Tokyo";
    const r = importTakeoutArchive(profileId, archive);
    expect(r.counts.inserted).toBe(0);
    expect(r.counts.unchanged).toBeGreaterThan(0);
    expect(sleepRows(profileId)).toHaveLength(14);
  });
});

// ---- migration 155: the rows that are already stored wrong ----
//
// Written against the CURRENT schema rather than a hand-built old one: nothing about
// the table changed, only the values in it, and the migration's own guard is that a
// converted row no longer looks like a wall clock. That is also what makes the replay
// assertion below meaningful.
describe("migration 155 — reinterpreting already-stored zoneless rows", () => {
  let legacyId: number;

  const insert = (
    pid: number,
    metric: string,
    date: string,
    start: string,
    end: string,
    edited = 0
  ) =>
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, start_time, end_time, value, edited)
         VALUES (?, 'fitbit-takeout', NULL, ?, ?, ?, ?, 417, ?)`
      )
      .run(pid, metric, date, start, end, edited);

  beforeAll(() => {
    legacyId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('TZLEGACY')").run()
        .lastInsertRowid
    );
    setTimezone(legacyId, TZ);
    // A plain night, its stage row, an EDIT-LOCKED night, and a night from another
    // source that this migration must not touch.
    insert(
      legacyId,
      "sleep_min",
      "2026-07-26",
      "2026-07-25T23:14:30.000",
      "2026-07-26T06:11:30.000"
    );
    insert(
      legacyId,
      "sleep_deep_min",
      "2026-07-26",
      "2026-07-25T23:14:30.000#deep",
      "2026-07-26T06:11:30.000"
    );
    insert(
      legacyId,
      "sleep_min",
      "2026-07-27",
      "2026-07-26T22:00:00.000",
      "2026-07-27T05:30:00.000",
      1
    );
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, start_time, end_time, value, edited)
       VALUES (?, 'health-connect', NULL, 'sleep_min', '2026-07-28', ?, ?, 400, 0)`
    ).run(legacyId, "2026-07-27T23:00:00Z", "2026-07-28T06:00:00Z");
    // A tombstone for a night the user DELETED. Its natural key embeds start_time;
    // if it doesn't move with the rows, the next import resurrects the night.
    db.prepare(
      `INSERT INTO import_tombstones (profile_id, target_table, natural_key)
       VALUES (?, 'metric_samples', ?)`
    ).run(
      legacyId,
      ["sleep_min", "fitbit-takeout", "", "2026-07-20T23:45:00.000"].join(SEP)
    );
  });

  const startOf = (metric: string, date: string) =>
    (
      db
        .prepare(
          `SELECT start_time, end_time FROM metric_samples
            WHERE profile_id = ? AND metric = ? AND date = ?`
        )
        .get(legacyId, metric, date) as {
        start_time: string;
        end_time: string;
      }
    ).start_time;

  it("converts the stored wall clock against the PROFILE's timezone", () => {
    up155(db);
    expect(startOf("sleep_min", "2026-07-26")).toBe("2026-07-26T03:14:30.000Z");
    expect(startOf("sleep_deep_min", "2026-07-26")).toBe(
      "2026-07-26T03:14:30.000Z#deep"
    );
    const row = db
      .prepare(
        `SELECT end_time FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min' AND date = '2026-07-26'`
      )
      .get(legacyId) as { end_time: string };
    expect(row.end_time).toBe("2026-07-26T10:11:30.000Z");
  });

  it("never touches an EDIT-LOCKED row", () => {
    // The user's own statement about when they slept. Rewriting it under them is
    // exactly the overwrite the #133 lock exists to forbid — the row keeps its
    // zoneless value, and a later re-import skips it for the same reason.
    expect(startOf("sleep_min", "2026-07-27")).toBe("2026-07-26T22:00:00.000");
  });

  it("leaves another source's already-absolute rows alone", () => {
    expect(startOf("sleep_min", "2026-07-28")).toBe("2026-07-27T23:00:00Z");
  });

  it("moves the DELETE tombstone with the row it suppresses", () => {
    const keys = (
      db
        .prepare(
          `SELECT natural_key FROM import_tombstones
            WHERE profile_id = ? AND target_table = 'metric_samples'`
        )
        .all(legacyId) as { natural_key: string }[]
    ).map((r) => r.natural_key);
    expect(keys).toEqual([
      ["sleep_min", "fitbit-takeout", "", "2026-07-21T03:45:00.000Z"].join(SEP),
    ]);
  });

  it("is a no-op on replay", () => {
    // The DB tier replays migrations over an at-rest database, and a converted value
    // no longer looks like a wall clock — so a second run must find nothing to do
    // rather than shift every night by the offset a second time.
    const before = db
      .prepare(
        `SELECT id, start_time, end_time FROM metric_samples
          WHERE profile_id = ? ORDER BY id`
      )
      .all(legacyId);
    up155(db);
    up155(db);
    expect(
      db
        .prepare(
          `SELECT id, start_time, end_time FROM metric_samples
            WHERE profile_id = ? ORDER BY id`
        )
        .all(legacyId)
    ).toEqual(before);
  });
});

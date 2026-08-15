import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { ZipBuilder } from "@/lib/zip-write";
import { importTakeoutArchive } from "@/lib/integrations/fitbit-takeout-import";
import { typicalWakeTime } from "@/lib/queries/sleep";

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
      `SELECT metric, date, started_at, ended_at FROM metric_samples
        WHERE profile_id = ? AND source = 'fitbit-takeout' AND metric = 'sleep_min'
        ORDER BY date`
    )
    .all(pid) as {
    metric: string;
    date: string;
    started_at: string;
    ended_at: string;
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
    expect(rows[0].started_at).toBe("2026-07-10T03:14:30.000Z");
    expect(rows[0].ended_at).toBe("2026-07-10T10:11:30.000Z");
    // The stage rows carry the SAME instant under their `#stage` discriminator, so
    // one night's total and breakdown stay on one window.
    const deep = db
      .prepare(
        `SELECT started_at FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_deep_min' AND date = '2026-07-10'`
      )
      .get(profileId) as { started_at: string };
    expect(deep.started_at).toBe("2026-07-10T03:14:30.000Z#deep");
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

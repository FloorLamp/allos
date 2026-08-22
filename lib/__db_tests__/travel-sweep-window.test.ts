// DB INTEGRATION TIER — what the timezone sweep is allowed to delete (#3524).
//
// `sweepIngestWindowForTimezoneChange` deletes Health Connect `body_metrics` rows so
// the next push cannot leave a re-keyed row standing beside its stale twin (#608).
// Its bound used to be three days back, justified by a comment ("a rolling ~48h
// window") that the prod payload census falsifies: Health Connect is a PUSH source
// (registry.ts, no `pull` facet), Allos never fetches from the phone, and every
// retained push carries ONE `resting_heart_rate` record — today's. So a three-day
// sweep destroyed two days that nothing would ever send back, four days of a real
// profile's resting HR across two travel switches.
//
// These tests pin the bound from BOTH sides, because both sides are load-bearing:
//   1. Days the exporter cannot re-send SURVIVE a switch (restore SWEEP_DAYS to 3 and
//      this one goes red naming them).
//   2. #608's eastward evening re-key still ends with ONE row (set SWEEP_DAYS to 0 and
//      this one goes red with two).
//   3. Moving WEST leaves the stale row on a day that is still in the FUTURE in the new
//      zone, and the sweep reaches it — the reason the DELETE has no upper bound.
//   4. Every timezone-change path still goes through the one shared rule.
//
// Every instant is frozen through the clock seam (ALLOS_TEST_NOW, lib/clock.ts): the
// whole subject is which local day a fixed instant reads on, in two zones at once.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { POST } from "@/app/api/integrations/health-connect/ingest/route";
import { generateHealthConnectToken } from "@/lib/integrations/connections";
import { sweepIngestWindowForTimezoneChange } from "@/lib/integrations/ingest-timezone-sweep";

const LA = "America/Los_Angeles"; // UTC−7 in May
const NY = "America/New_York"; // UTC−4 in May, UTC−4 in August
const HONOLULU = "Pacific/Honolulu"; // UTC−10, no DST

let profileId: number;
let token: string;

function freeze(instant: string): void {
  process.env.ALLOS_TEST_NOW = instant;
}

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Sweep Window')").run()
      .lastInsertRowid
  );
  token = generateHealthConnectToken(profileId, "never");
});

afterEach(() => {
  delete process.env.ALLOS_TEST_NOW;
});

function seedRestingHr(date: string, bpm: number): void {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
     VALUES (?, ?, ?, 'health-connect')`
  ).run(profileId, date, bpm);
}

function hcRows(): { date: string; resting_hr: number | null }[] {
  return db
    .prepare(
      `SELECT date, resting_hr FROM body_metrics
        WHERE profile_id = ? AND source = 'health-connect' ORDER BY date`
    )
    .all(profileId) as { date: string; resting_hr: number | null }[];
}

// A payload shaped like the real exporter: a `timestamp` and ONE record. 49 of the 50
// retained prod pushes looked exactly like this for resting HR.
async function push(body: object): Promise<number> {
  const res = await POST(
    new Request("http://x/api/integrations/health-connect/ingest", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );
  return res.status;
}

describe("the timezone sweep deletes only what the exporter can re-send (#3524)", () => {
  it("keeps the days a push will never carry, and the push restores today", async () => {
    // 14:00 in New York, 11:00 in Los Angeles — the same local date in both zones, so
    // the switch below moves the KEY without moving "today" underneath the assertion.
    freeze("2026-05-02T18:00:00Z");
    setTimezone(profileId, LA);
    const anchor = today(profileId);
    expect(anchor).toBe("2026-05-02");

    const d3 = shiftDateStr(anchor, -3); // 04-29
    const d2 = shiftDateStr(anchor, -2); // 04-30
    const d1 = shiftDateStr(anchor, -1); // 05-01
    seedRestingHr(d3, 58);
    seedRestingHr(d2, 59);
    seedRestingHr(d1, 60);
    seedRestingHr(anchor, 61);

    // The switch path: the zone is written first, then the one shared sweep runs.
    setTimezone(profileId, NY);
    sweepIngestWindowForTimezoneChange(profileId);

    // The exporter can only ever re-send today (and, at a rollover, yesterday), so
    // today − 2 and today − 3 must still be here. With SWEEP_DAYS = 3 they are not,
    // and that is the four-day production loss #3524 was filed for.
    expect(hcRows().map((r) => r.date)).toEqual([d3, d2]);

    // Now the real exporter's next push: ONE resting_heart_rate record, today's.
    expect(
      await push({
        timestamp: "2026-05-02T13:35:00Z",
        app_version: "1.9.14-test",
        resting_heart_rate: [{ time: "2026-05-02T13:30:00Z", bpm: 61 }],
      })
    ).toBe(200);

    // Today comes back under the new zone's key. today − 1 does NOT — a push does not
    // carry it — which is the one day this sweep still spends, and it spends it
    // because #608's eastward re-key puts the stale row exactly there (next test).
    expect(hcRows()).toEqual([
      { date: d3, resting_hr: 58 },
      { date: d2, resting_hr: 59 },
      { date: anchor, resting_hr: 61 },
    ]);
  });

  it("still collapses #608's eastward evening re-key to ONE row", async () => {
    // 21:30 in Los Angeles on the 1st IS 00:30 in New York on the 2nd. This single
    // instant is the whole bug: it is stored on the 1st before the flight and re-filed
    // on the 2nd after it.
    const EVENING = "2026-05-02T04:30:00Z";
    freeze(EVENING);
    setTimezone(profileId, LA);
    expect(
      await push({
        timestamp: EVENING,
        app_version: "1.9.14-test",
        weight: [{ time: EVENING, kilograms: 80.4 }],
      })
    ).toBe(200);
    expect(hcRows().map((r) => r.date)).toEqual(["2026-05-01"]);

    // Half an hour later, in New York: local 01:00 on the 2nd, so today is the 2nd and
    // the stale row sits on today − 1.
    freeze("2026-05-02T05:00:00Z");
    setTimezone(profileId, NY);
    expect(today(profileId)).toBe("2026-05-02");
    sweepIngestWindowForTimezoneChange(profileId);

    // The re-push files the same instant on the 2nd. If the sweep had started at today
    // instead of today − 1, the 05-01 row would still be here and this would be TWO.
    expect(
      await push({
        timestamp: "2026-05-02T05:05:00Z",
        app_version: "1.9.14-test",
        weight: [{ time: EVENING, kilograms: 80.4 }],
      })
    ).toBe(200);
    expect(hcRows().map((r) => r.date)).toEqual(["2026-05-02"]);
  });

  it("moving WEST sweeps the stale row that is now in the FUTURE", async () => {
    // 01:00 on the 22nd in New York is 19:00 on the 21st in Honolulu. So a reading
    // stored minutes ago under New York sits on the 22nd, while today in the new zone
    // is the 21st: the stale row is AHEAD of today, not behind it. This is why the
    // DELETE is `date >= cutoff` with no upper bound — a `BETWEEN cutoff AND today`
    // would leave this row and reopen the westward half of #608.
    freeze("2026-08-22T05:00:00Z");
    setTimezone(profileId, NY);
    expect(today(profileId)).toBe("2026-08-22");
    seedRestingHr("2026-08-19", 57);
    seedRestingHr("2026-08-20", 58);
    seedRestingHr("2026-08-22", 62);

    setTimezone(profileId, HONOLULU);
    expect(today(profileId)).toBe("2026-08-21");
    sweepIngestWindowForTimezoneChange(profileId);

    // 08-20 is today − 1 and goes; 08-22 is today + 1 and goes; 08-19 is today − 2,
    // which no push will re-send, and stays.
    expect(hcRows().map((r) => r.date)).toEqual(["2026-08-19"]);
  });
});

// ---------------------------------------------------------------------------
// One rule, every path (#3524 AC 2). A source scan, not a behaviour test: the risk is
// a FOURTH place learning to delete body_metrics because the timezone moved, or one of
// the three known paths growing its own cutoff.
// ---------------------------------------------------------------------------

const TZ_CHANGE_CALL_SITES = [
  "app/(app)/travel-actions.ts", // the travel one-tap accept + revert
  "app/(app)/settings/profile/actions.ts", // the Settings profile form
  "app/(app)/onboarding/actions.ts", // onboarding's timezone step
];

// Every non-test source allowed to delete from body_metrics, and why it is not a
// timezone sweep. The guard must stay SILENT on these or it gets deleted within a week.
const BODY_METRIC_DELETERS: Record<string, string> = {
  "lib/integrations/ingest-timezone-sweep.ts":
    "the sweep itself — the one place a timezone change may delete these rows",
  "app/(app)/data/review-actions.ts":
    "a user deleting ONE reviewed row by id; nothing to do with the timezone",
};

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "migrations") continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk("app");
  walk("lib");
  return out;
}

// Matches a deletion of body_metrics however it is spelled here — `db.prepare("DELETE
// FROM body_metrics ...")` on one line or wrapped across several, and `db.exec` the
// same. The repo writes these as template literals as often as plain strings, so the
// pattern must not depend on quoting or on the WHERE clause landing on one line.
const DELETES_BODY_METRICS = /DELETE\s+FROM\s+body_metrics/i;

describe("one timezone-sweep rule, every path (#3524)", () => {
  it("routes all three timezone-change paths through the shared sweep", () => {
    for (const file of TZ_CHANGE_CALL_SITES) {
      const src = fs.readFileSync(file, "utf8");
      expect(
        src.includes("sweepIngestWindowForTimezoneChange"),
        `${file} changes a profile's timezone and must call the shared sweep`
      ).toBe(true);
      // …and must not carry its own cutoff: the bound lives in one place.
      expect(src).not.toMatch(/SWEEP_DAYS/);
    }
  });

  it("finds no fourth place deleting body_metrics", () => {
    const found = sourceFiles().filter((f) =>
      DELETES_BODY_METRICS.test(fs.readFileSync(f, "utf8"))
    );
    expect(found.sort()).toEqual(Object.keys(BODY_METRIC_DELETERS).sort());
  });

  it("can see a hand-rolled sweep — proved against sources written to break it", () => {
    // A green sweep over a complying tree says nothing about what the sweep can SEE.
    const wouldSlipPast = [
      `db.prepare("DELETE FROM body_metrics WHERE profile_id = ? AND date >= ?")`,
      "db.exec(`DELETE\n  FROM body_metrics\n  WHERE source = 'health-connect'`)",
      `db.prepare(\`delete from body_metrics where date >= ?\`)`,
    ];
    for (const src of wouldSlipPast) {
      expect(DELETES_BODY_METRICS.test(src), src).toBe(true);
    }
    // And it stays quiet on the neighbours that merely READ or WRITE the table.
    for (const src of [
      "SELECT date FROM body_metrics WHERE profile_id = ?",
      "INSERT INTO body_metrics (profile_id, date) VALUES (?, ?)",
      "UPDATE body_metrics SET edited = 1 WHERE id = ?",
    ]) {
      expect(DELETES_BODY_METRICS.test(src), src).toBe(false);
    }
  });
});

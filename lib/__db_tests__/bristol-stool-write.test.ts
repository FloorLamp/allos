// DB INTEGRATION TIER — the Bristol stool-form write core (issue #2785).
//
// The pure tier pins the vocabulary and the panel shape. What only the real schema can
// prove is the GRAIN, which is the whole placement decision:
//
//   • two movements at different times of one day are TWO rows, because the natural
//     key `(profile_id, metric, source, origin, started_at)` carries the instant. The
//     shared point-measure writer files at the day's midnight, so a Bristol row written
//     through it would have CORRECTED the morning's reading with the evening's — and
//     nothing downstream could tell, because the surviving row looks perfectly normal.
//   • a re-tap inside the same minute settles on ONE row, so a double-tap is a
//     correction rather than a phantom second movement.
//   • a value the scale does not name never reaches the table at all, from any door.
//
// The db singleton is redirected at a per-file temp DB by setup.ts before import.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { logBristolStool } from "@/lib/offline/writes";
import {
  getBristolPanel,
  getBristolReadings,
} from "@/lib/queries/bristol-stool";
import { BRISTOL_STOOL_METRIC } from "@/lib/bristol-stool";

let profileId: number;

function rows(): { date: string; started_at: string; value: number }[] {
  return db
    .prepare(
      `SELECT date, started_at, value FROM metric_samples
        WHERE profile_id = ? AND metric = ? ORDER BY started_at`
    )
    .all(profileId, BRISTOL_STOOL_METRIC) as {
    date: string;
    started_at: string;
    value: number;
  }[];
}

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Bristol')").run()
      .lastInsertRowid
  );
});

describe("logBristolStool — instant grain", () => {
  it("keeps two movements on one day as two rows", () => {
    const date = today(profileId);
    expect(logBristolStool(profileId, date, 2, "08:12")).toBe(true);
    expect(logBristolStool(profileId, date, 6, "19:40")).toBe(true);

    const stored = rows();
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.value)).toEqual([2, 6]);
    expect(stored.map((r) => r.started_at)).toEqual([
      `${date}T08:12:00`,
      `${date}T19:40:00`,
    ]);
    // And the reader hands both over — a day is not collapsed on the way out either.
    const day = getBristolPanel(profileId, date).days.at(-1)!;
    expect(day.types).toEqual([2, 6]);
  });

  it("settles a re-log of the SAME STATED time onto one row (a correction)", () => {
    // A stated wall time is a claim about WHEN, so restating it corrects that
    // reading rather than inventing a second movement at the same minute.
    const date = today(profileId);
    expect(logBristolStool(profileId, date, 5, "09:00")).toBe(true);
    expect(logBristolStool(profileId, date, 4, "09:00")).toBe(true);
    expect(rows()).toEqual([
      { date, started_at: `${date}T09:00:00`, value: 4 },
    ]);
  });

  it("resolves to the SECOND, so a deliberate second reading is its own row", () => {
    // The resolution is the whole design. `stool-form` is declared `additive` and its
    // accidental double-tap is absorbed by the ledger's two-second cooldown, so a tap
    // the ledger would absorb and a tap this key would collapse are the same tap —
    // any deliberate second movement lands on a later second and survives. At MINUTE
    // resolution they would not line up, and a genuine second reading forty seconds
    // after the first would vanish with the surviving row looking perfectly normal.
    //
    // Asserted through the stated-time door, because the clock seam is frozen in the
    // test tiers (ALLOS_TEST_NOW) and cannot advance to demonstrate it.
    const date = today(profileId);
    expect(logBristolStool(profileId, date, 3, "09:00")).toBe(true);
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
         VALUES (?, 'manual', ?, ?, ?, ?, 6)`
    ).run(
      profileId,
      BRISTOL_STOOL_METRIC,
      date,
      `${date}T09:00:40`,
      `${date}T09:00:40`
    );
    expect(rows().map((r) => r.value)).toEqual([3, 6]);
  });

  it("stamps the profile-local clock when no time is given", () => {
    const date = today(profileId);
    expect(logBristolStool(profileId, date, 3)).toBe(true);
    const stored = rows();
    expect(stored).toHaveLength(1);
    // Not midnight: a one-tap log records WHEN, which is what makes a second tap a
    // second observation rather than an overwrite of the first.
    expect(stored[0].started_at.startsWith(`${date}T`)).toBe(true);
    expect(stored[0].started_at).not.toBe(`${date}T00:00:00`);
  });
});

describe("logBristolStool — the vocabulary reaches the table", () => {
  it("refuses every non-type and writes nothing", () => {
    const date = today(profileId);
    for (const bad of [0, 8, 3.5, -1, NaN, "four", null, undefined]) {
      expect(logBristolStool(profileId, date, bad), String(bad)).toBe(false);
    }
    expect(rows()).toEqual([]);
  });

  it("refuses an impossible date", () => {
    expect(logBristolStool(profileId, "2026-02-30", 4)).toBe(false);
    expect(logBristolStool(profileId, "not-a-date", 4)).toBe(false);
    expect(rows()).toEqual([]);
  });
});

describe("the reader is profile-scoped and metric-scoped", () => {
  it("never returns another profile's readings", () => {
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Other')").run()
        .lastInsertRowid
    );
    const date = today(profileId);
    logBristolStool(profileId, date, 4, "07:00");
    logBristolStool(other, date, 7, "07:00");

    expect(getBristolReadings(profileId, date, date)).toEqual([
      { date, type: 4 },
    ]);
    expect(getBristolReadings(other, date, date)).toEqual([{ date, type: 7 }]);
  });

  it("never picks up another metric's samples on the same day", () => {
    const date = today(profileId);
    logBristolStool(profileId, date, 4, "07:00");
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
         VALUES (?, 'manual', 'waist_circumference_cm', ?, ?, ?, 82)`
    ).run(profileId, date, `${date}T07:00:00`, `${date}T07:00:00`);
    expect(getBristolReadings(profileId, date, date)).toEqual([
      { date, type: 4 },
    ]);
  });
});

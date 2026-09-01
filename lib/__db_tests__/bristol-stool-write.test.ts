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
//
// AND THE CLOCK IS FROZEN, tier-wide, by lib/__db_tests__/frozen-clock.ts (#4509) —
// which is what a comment here used to claim before it was true. It matters because
// the stated time is JUDGED rather than shape-checked (#4425): a fixture stating 19:40
// is in the past when the suite runs in the evening and in the FUTURE when it runs at
// lunchtime, so an unpinned clock would make this file green for part of the day and
// red for the rest — the #3260 shape. The freeze sits late on its own UTC day, so every
// wall time below has already happened.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { zonedWallIsoToUtc } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { logBristolStool } from "@/lib/offline/writes";
import {
  getBristolPanel,
  getBristolReadings,
} from "@/lib/queries/bristol-stool";
import { BRISTOL_STOOL_METRIC } from "@/lib/bristol-stool";

// Profiles here take the instance-default timezone, so profile-local is UTC.
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
    expect(logBristolStool(profileId, date, 2, "08:12")).toEqual({
      wrote: true,
    });
    expect(logBristolStool(profileId, date, 6, "19:40")).toEqual({
      wrote: true,
    });

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
    expect(logBristolStool(profileId, date, 5, "09:00")).toEqual({
      wrote: true,
    });
    expect(logBristolStool(profileId, date, 4, "09:00")).toEqual({
      wrote: true,
    });
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
    // Asserted through the stated-time door, because this file pins the clock seam
    // (ALLOS_TEST_NOW, above) and it cannot advance to demonstrate it.
    const date = today(profileId);
    expect(logBristolStool(profileId, date, 3, "09:00")).toEqual({
      wrote: true,
    });
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
    // BRACKETED, not "not midnight" (#3214). A one-tap log records WHEN, which is
    // what makes a second tap a second observation rather than an overwrite of the
    // first — and the property that says so is "stamped during this operation", so
    // the write is bracketed between two readings of the app's own clock seam and
    // the stamp has to land between them. The old check inferred the clock from a
    // single value the stamp was unlikely to equal (`${date}T00:00:00`), which is
    // wrong the moment the real value IS the marker: it reds for the first second
    // after local midnight, and it would go on passing if the fallback were ever
    // changed to any other fixed time.
    //
    // The stored stamp is DECODED back to an instant rather than compared against a
    // rebuilt string — rebuilding it would restate the writer's own arithmetic and
    // could not see a mutant in it.
    const zone = getTimezone(profileId);
    const before = clockNow().getTime();
    expect(logBristolStool(profileId, date, 3)).toEqual({ wrote: true });
    const after = clockNow().getTime();

    const stored = rows();
    expect(stored).toHaveLength(1);
    const stampedAt = zonedWallIsoToUtc(zone, stored[0].started_at);
    expect(stampedAt).not.toBeNull();
    // Whole seconds, so the lower bound is `before` floored to its own second; the
    // upper bound needs no slack.
    expect(stampedAt!.getTime()).toBeGreaterThanOrEqual(
      Math.floor(before / 1000) * 1000
    );
    expect(stampedAt!.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("logBristolStool — the vocabulary reaches the table", () => {
  it("refuses every non-type and writes nothing", () => {
    const date = today(profileId);
    for (const bad of [0, 8, 3.5, -1, NaN, "four", null, undefined]) {
      expect(logBristolStool(profileId, date, bad), String(bad)).toEqual({
        wrote: false,
      });
    }
    expect(rows()).toEqual([]);
  });

  it("refuses an impossible date", () => {
    expect(logBristolStool(profileId, "2026-02-30", 4)).toEqual({
      wrote: false,
    });
    expect(logBristolStool(profileId, "not-a-date", 4)).toEqual({
      wrote: false,
    });
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

// THE STATED TIME IS JUDGED, NOT SHAPE-CHECKED (#4425). This core ran
// `normalizeClockTime` alone, so "Happened earlier?" took a wall time the day had not
// reached and filed the movement there — on a row whose natural key IS that instant,
// which means the forgery also decides what a later reading collides with.
//
// PARITY WITH BODY METRICS is the ruling and it is asserted as a comparison rather
// than against a constant: `applyBodyMetricIntent` is the shipped shape (the row lands,
// the statement is dropped, `statedTimeRefused` carries the reason), and this answers
// with the same three properties.
describe("logBristolStool — a stated time is judged (#4425)", () => {
  const PINNED_HHMM = "23:45";

  it.each([
    // Before "now" on the pinned day — the ordinary backfill, kept as stated.
    ["08:12", undefined, "08:12"],
    // Ten minutes after it — past the five-minute skew `judgeStatedAt` tolerates.
    // The filed defect is "23:50 typed at 09:00"; the clock sits at 23:45 here
    // because the file's other fixtures state evening times on the same day.
    ["23:55", "future", PINNED_HHMM],
  ])("%s → refused=%s, filed at %s", (at, refusal, filedAt) => {
    const date = today(profileId);
    expect(logBristolStool(profileId, date, 4, at)).toEqual(
      refusal ? { wrote: true, statedTimeRefused: refusal } : { wrote: true }
    );
    const stored = rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].started_at.slice(0, 16)).toBe(`${date}T${filedAt}`);
  });

  // The refusal costs the STATEMENT, never the observation — the whole point of the
  // body-metric contract. A future time must not behave like a bad Bristol type.
  it("a refused time still files the movement", () => {
    const date = today(profileId);
    logBristolStool(profileId, date, 6, "23:55");
    expect(getBristolReadings(profileId, date, date)).toEqual([
      { date, type: 6 },
    ]);
  });
});

// DB INTEGRATION TIER — the stool write core (issues #2785, #5872).
//
// The pure tier pins the vocabulary and the panel shape. What only the real schema can
// prove is the GRAIN, and #5872 CHANGED THE ANSWER:
//
//   • two movements are TWO ROWS, unconditionally. The ledger is append-only and has no
//     natural key, so the day, the minute and the second are all irrelevant to whether
//     a second log makes a second row.
//   • a second movement STATED AT THE SAME MINUTE is a second row, where the samples
//     table's `(profile_id, metric, source, origin, started_at)` key made it an UPSERT
//     that silently replaced the first. That is the defect the ledger exists to close,
//     and the case below is the one whose expectation inverted.
//   • a movement nobody timed writes `occurred_at` NULL, where the old store stamped
//     the wall clock and left the row unable to say which it was.
//   • a value the scale does not name never reaches the table at all, from any door —
//     and NULL is not such a value: it is a movement nobody saw the form of.
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
import { zonedDateParts } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { logBristolStool } from "@/lib/offline/writes";
import {
  getBristolPanel,
  getBristolReadings,
} from "@/lib/queries/bristol-stool";
import {
  correctStoolEventCore,
  deleteStoolEventCore,
  logStoolCore,
} from "@/lib/stool-log-write";
import { restoreDeletedRow } from "@/lib/undo-delete-db";
import { STATED_FUTURE_SKEW_MS } from "@/lib/stated-time";
import { FROZEN_WALL_TIME_UTC } from "./frozen-clock";

// Profiles here take the instance-default timezone, so profile-local is UTC.
let profileId: number;

interface Row {
  date: string;
  occurred_at: string | null;
  time_source: string | null;
  type: number | null;
}

function rows(): Row[] {
  return db
    .prepare(
      `SELECT date, occurred_at, time_source, type FROM stool_events
        WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as Row[];
}

/** The profile-local "HH:MM" a stored canonical instant renders at. */
function hhmm(at: string | null): string | null {
  return at === null ? null : zonedDateParts(getTimezone(profileId), new Date(at)).hhmm;
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
    expect(stored.map((r) => r.type)).toEqual([2, 6]);
    expect(stored.map((r) => hhmm(r.occurred_at))).toEqual(["08:12", "19:40"]);
    expect(stored.map((r) => r.time_source)).toEqual(["stated", "stated"]);
    // And the reader hands both over — a day is not collapsed on the way out either.
    const day = getBristolPanel(profileId, date).days.at(-1)!;
    expect(day.types).toEqual([2, 6]);
  });

  // THE MERGE DEFECT, AND THE CASE WHOSE EXPECTATION INVERTED (#5872 defect 1).
  //
  // This test used to assert the opposite, and its comment argued for it: "a stated
  // wall time is a claim about WHEN, so restating it corrects that reading rather than
  // inventing a second movement at the same minute." The argument is coherent and the
  // consequence is data loss — two movements a minute apart, both stated to the minute,
  // and the first one is gone with the surviving row looking perfectly normal. Nobody
  // with an active gut condition finds that hypothetical.
  //
  // FALSIFIED against the unfixed tree: run this case with `logBristolStool` still
  // writing `metric_samples` and it fails with one row where two are expected.
  it("keeps two movements stated at the SAME minute as two rows", () => {
    const date = today(profileId);
    expect(logBristolStool(profileId, date, 5, "09:00")).toEqual({
      wrote: true,
    });
    expect(logBristolStool(profileId, date, 4, "09:00")).toEqual({
      wrote: true,
    });
    const stored = rows();
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.type)).toEqual([5, 4]);
    expect(stored.map((r) => hhmm(r.occurred_at))).toEqual(["09:00", "09:00"]);
  });

  // THE INVENTED INSTANT (#5872 defect 2). FALSIFIED against the unfixed tree: the old
  // core stamped `sampleTime`'s reading of the wall clock, so `occurred_at`'s
  // equivalent was always present and the row could not say nobody had timed it.
  it("writes no instant at all when no time is given", () => {
    const date = today(profileId);
    const before = clockNow().getTime();
    expect(logBristolStool(profileId, date, 3)).toEqual({ wrote: true });
    const after = clockNow().getTime();

    const stored = rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].occurred_at).toBeNull();
    expect(stored[0].time_source).toBeNull();

    // The TAP instant is still recorded, and it is the only clock read on this path —
    // bracketed between two readings of the app's own clock seam (#3214) rather than
    // compared against a rebuilt string, which would restate the writer's arithmetic
    // and could not see a mutant in it.
    const recordedAt = db
      .prepare("SELECT recorded_at FROM stool_events WHERE profile_id = ?")
      .get(profileId) as { recorded_at: string };
    const at = new Date(recordedAt.recorded_at).getTime();
    expect(at).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(at).toBeLessThanOrEqual(after);
  });

  // REGRESSION GUARD for the invariant the optional type exists to serve. Nothing in
  // slice 1 calls this from a surface — slice 2's `Didn't see` tile does — so this is
  // the core's own contract, pinned before the tile that depends on it is built.
  it("records an occurrence with no type at all", () => {
    const date = today(profileId);
    const outcome = logStoolCore(profileId, date, null);
    expect(outcome.kind).toBe("logged");
    expect(rows()).toEqual([
      { date, occurred_at: null, time_source: null, type: null },
    ]);
    // And it is not a reading: the panel counts typed rows and never sees this one.
    expect(getBristolReadings(profileId, date, date)).toEqual([]);
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
  // Derived from the tier's own constant rather than retyped: if the freeze ever
  // moves, this table should move with it instead of going quietly wrong.
  const PINNED_HHMM = FROZEN_WALL_TIME_UTC.slice(0, 5);
  // The future half is derived too, and for the same reason the line above is: it has
  // to sit past `judgeStatedAt`'s skew AND still on the frozen day, which a retyped
  // literal stops doing the moment the freeze moves. It used to read "23:55" against a
  // 23:45 freeze; at 23:50 that is inside the skew and the row would be ACCEPTED, so
  // the table would have gone on passing while testing the opposite verdict (#4837).
  const FUTURE_HHMM = new Date(
    Date.parse(`1970-01-01T${FROZEN_WALL_TIME_UTC}`) +
      STATED_FUTURE_SKEW_MS +
      120_000
  )
    .toISOString()
    .slice(11, 16);

  it.each([
    // Before "now" on the pinned day — the ordinary backfill, kept as stated.
    ["08:12", undefined, "08:12"],
    // Past the five-minute skew `judgeStatedAt` tolerates, derived from the freeze so
    // it stays past it. The filed defect is "23:50 typed at 09:00".
    [FUTURE_HHMM, "future", PINNED_HHMM],
  ])("%s → refused=%s, filed at %s", (at, refusal, filedAt) => {
    const date = today(profileId);
    expect(logBristolStool(profileId, date, 4, at)).toEqual(
      refusal ? { wrote: true, statedTimeRefused: refusal } : { wrote: true }
    );
    const stored = rows();
    expect(stored).toHaveLength(1);
    // A REFUSED statement no longer falls back onto a stamped minute — it falls back to
    // NO stated instant, which is the honest state the ledger can now hold. The row is
    // still filed on the day it named.
    expect(stored[0].date).toBe(date);
    expect(hhmm(stored[0].occurred_at)).toBe(refusal ? null : filedAt);
    expect(stored[0].time_source).toBe(refusal ? null : "stated");
  });

  // The refusal costs the STATEMENT, never the observation — the whole point of the
  // body-metric contract. A future time must not behave like a bad Bristol type.
  it("a refused time still files the movement", () => {
    const date = today(profileId);
    logBristolStool(profileId, date, 6, FUTURE_HHMM);
    expect(getBristolReadings(profileId, date, date)).toEqual([
      { date, type: 6 },
    ]);
  });
});

// THE SHARED DATE INVARIANT (#4425 / #4433). "Windows bind offers, not domains": the
// core takes ANY REAL PAST DAY and never the future, and the sheet's tap is bounded
// where the OFFER is (`TAP_REACH["stool-form"]` is `today`), not here. What only the
// real schema can prove is that the accepted backfill actually lands on the day it
// names rather than on the day it was written.
describe("logBristolStool — any real past day, never the future", () => {
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  it.each([
    ["a week back", -7, true],
    ["yesterday", -1, true],
    ["today", 0, true],
    ["tomorrow", 1, false],
  ])("%s (%s days out) → wrote=%s", (_label, offset, wrote) => {
    const date = day(offset);
    expect(logBristolStool(profileId, date, 4)).toEqual({ wrote });
    expect(rows().map((r) => r.date)).toEqual(wrote ? [date] : []);
  });
});

// THE RECORD'S CORRECTION AND DELETE (#4433), on the ledger's own cores since #5872.
//
// Stool used to take no write core of its own for either: a reading WAS a
// `metric_samples` row, so the actions addressed it through the shared reading contract.
// A movement is its own event now, so the cores here are what the actions call — and the
// correction gained the two moves the old store could not express, because it had
// nowhere to hold an absent type.
describe("a logged movement is correctable and deletable (#4433)", () => {
  const onlyRow = () =>
    db
      .prepare("SELECT id, type FROM stool_events WHERE profile_id = ? ORDER BY id")
      .all(profileId) as { id: number; type: number | null }[];

  // REGRESSION GUARD — this worked through `updateMetricRow` before and must go on
  // working through the new core.
  it("corrects the mis-tapped type in place, leaving the instant and day alone", () => {
    const date = today(profileId);
    logBristolStool(profileId, date, 3, "08:12");
    const [row] = onlyRow();

    expect(correctStoolEventCore(profileId, row.id, { type: 4 })).toEqual({
      kind: "updated",
      eventId: row.id,
      date,
    });
    expect(rows()).toEqual([
      { date, occurred_at: rows()[0].occurred_at, time_source: "stated", type: 4 },
    ]);
    expect(hhmm(rows()[0].occurred_at)).toBe("08:12");
  });

  // FALSIFIED against the unfixed tree in the strongest sense available: there is no
  // unfixed tree in which this CAN pass. `metric_samples.value` is REAL NOT NULL, so
  // "clear the type" had no representation at all and `updateMetricRow` took a number.
  it("sets a type on an untyped row and clears one back off", () => {
    const date = today(profileId);
    logStoolCore(profileId, date, null);
    const [untyped] = onlyRow();

    expect(correctStoolEventCore(profileId, untyped.id, { type: 6 })).toMatchObject({
      kind: "updated",
    });
    expect(onlyRow().map((r) => r.type)).toEqual([6]);

    expect(correctStoolEventCore(profileId, untyped.id, { type: null })).toMatchObject({
      kind: "updated",
    });
    expect(onlyRow().map((r) => r.type)).toEqual([null]);
  });

  // REGRESSION GUARD: an ABSENT field leaves the row alone, which is the house patch
  // convention and the thing that keeps "clear the type" from being what an untouched
  // form posts.
  it("leaves the type alone when the patch does not name it", () => {
    const date = today(profileId);
    logBristolStool(profileId, date, 5, "10:00");
    const [row] = onlyRow();
    expect(correctStoolEventCore(profileId, row.id, {})).toMatchObject({
      kind: "updated",
    });
    expect(onlyRow().map((r) => r.type)).toEqual([5]);
  });

  // REGRESSION GUARD — the #2642 shape the record's ⋯ → Delete depends on.
  it("deletes with an undo token, and the undo puts the movement back", () => {
    const date = today(profileId);
    logBristolStool(profileId, date, 6, "19:40");
    const [row] = onlyRow();

    const outcome = deleteStoolEventCore(profileId, row.id);
    expect(outcome.undoId).toBeTypeOf("number");
    expect(rows()).toEqual([]);

    expect(restoreDeletedRow(profileId, outcome.undoId!)).toBe(true);
    const back = rows();
    expect(back).toHaveLength(1);
    expect(back[0].type).toBe(6);
    expect(hhmm(back[0].occurred_at)).toBe("19:40");
  });

  // REGRESSION GUARD on the profile boundary — the invariant every read and write here
  // is scoped by. It used to be bought by the metric in the target; it is bought by the
  // core's own WHERE clause now, and the outcome must be the same refusal.
  it("refuses another profile's row from both doors", () => {
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Neighbour')").run()
        .lastInsertRowid
    );
    const date = today(profileId);
    logBristolStool(other, date, 4, "07:00");
    const theirs = db
      .prepare("SELECT id FROM stool_events WHERE profile_id = ?")
      .get(other) as { id: number };

    expect(correctStoolEventCore(profileId, theirs.id, { type: 1 })).toEqual({
      kind: "not-found",
    });
    expect(deleteStoolEventCore(profileId, theirs.id)).toEqual({ undoId: null });
    expect(
      db
        .prepare("SELECT type FROM stool_events WHERE id = ?")
        .get(theirs.id)
    ).toEqual({ type: 4 });
  });
});

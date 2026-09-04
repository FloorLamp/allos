import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setProfileSetting, setTimezone } from "@/lib/settings";
import { serializeTimezoneSwitches } from "@/lib/travel-timezone";
import { shiftDateStr, utcInstant } from "@/lib/date";
import {
  retimeSleepSessionCore,
  restoreSleepRetime,
} from "@/lib/sleep-retime-db";
import { SLEEP_RETIME_KIND } from "@/lib/sleep-retime-kind";
import { metricSampleTombstoneKey } from "@/lib/integrations/tombstone-keys";
import { getSuspectSleepWakeDays } from "@/lib/queries/sleep-clock-skew";
import { countTrash, listTrash } from "@/lib/queries/trash";
import { getOverlappingSleepSessions } from "@/lib/queries/sleep";

// DB INTEGRATION TIER — re-timing a hedged sleep session (#5021).
//
// The whole point of this door is that a person who KNOWS when they slept keeps the
// night instead of deleting it to keep the record honest. So what is pinned here is the
// MOVE — session and stage rows together, by one delta, with the wake day re-derived —
// and the refusals that keep it from becoming a general sleep editor.

const PROVIDER = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";
const ASLEEP = 58;
const AWAKE = 74;
const MIN_MS = 60_000;

let profileId: number;
let T: string;
let day: string;

function sample(
  metric: string,
  wakeDay: string,
  startUtc: string,
  endUtc: string,
  value: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, started_at, ended_at, value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        PROVIDER,
        ORIGIN,
        metric,
        wakeDay,
        startUtc,
        endUtc,
        value
      ).lastInsertRowid
  );
}

/** A per-minute HR trace, at trough level inside `trough`. */
function trace(
  from: string,
  to: string,
  trough: { from: string; to: string }
): void {
  const stmt = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, source, bpm, bpm_min, bpm_max, n)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );
  const lo = Date.parse(trough.from);
  const hi = Date.parse(trough.to);
  for (let at = Date.parse(from); at < Date.parse(to); at += MIN_MS) {
    const bpm = at >= lo && at < hi ? ASLEEP : AWAKE;
    stmt.run(profileId, utcInstant(new Date(at)), PROVIDER, bpm, bpm, bpm);
  }
}

/** The sighting: a night stamped +6h, its stage row filed under the same wake day. */
function hedgedNight(): { sessionId: number; stageId: number } {
  const sessionId = sample(
    "sleep_min",
    day,
    `${day}T09:39:00Z`,
    `${day}T14:37:00Z`,
    298
  );
  const stageId = sample(
    "sleep_deep_min",
    day,
    `${day}T10:00:00Z`,
    `${day}T11:00:00Z`,
    60
  );
  trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${day}T22:00:00Z`, {
    from: `${day}T03:39:00Z`,
    to: `${day}T08:37:00Z`,
  });
  return { sessionId, stageId };
}

const rowOf = (id: number) =>
  db
    .prepare(
      `SELECT date, started_at, ended_at, edited FROM metric_samples
        WHERE id = ? AND profile_id = ?`
    )
    .get(id, profileId) as
    | { date: string; started_at: string; ended_at: string; edited: number }
    | undefined;

const tombstones = (): string[] =>
  (
    db
      .prepare(
        `SELECT natural_key FROM import_tombstones
          WHERE profile_id = ? AND target_table = 'metric_samples'`
      )
      .all(profileId) as { natural_key: string }[]
  ).map((r) => r.natural_key);

const sleepRowCount = (): number =>
  (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min'`
      )
      .get(profileId) as { c: number }
  ).c;

beforeEach(() => {
  db.exec("DELETE FROM metric_samples");
  db.exec("DELETE FROM hr_minutes");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('RETIME')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  T = today(profileId);
  day = shiftDateStr(T, -1);
});

describe("retimeSleepSessionCore", () => {
  it("moves the session and its stage rows by ONE delta and locks them", () => {
    const { sessionId, stageId } = hedgedNight();
    expect(getSuspectSleepWakeDays(profileId, shiftDateStr(T, -30))).toEqual(
      new Set([day])
    );

    const outcome = retimeSleepSessionCore(profileId, sessionId, {
      date: day,
      bed: "03:39",
      wake: "08:37",
    });
    expect(outcome.kind).toBe("retimed");

    // The session landed on the stated window...
    expect(rowOf(sessionId)).toMatchObject({
      started_at: `${day}T03:39:00Z`,
      ended_at: `${day}T08:37:00Z`,
      edited: 1,
    });
    // ...and the stage moved with it, by the SAME six hours. A breakdown left behind
    // would belong to a night that is no longer at those hours.
    expect(rowOf(stageId)).toMatchObject({
      started_at: `${day}T04:00:00Z`,
      ended_at: `${day}T05:00:00Z`,
      edited: 1,
    });
    // The old natural key is dead, so the exporter's 48-hour re-send cannot put the
    // mis-stamped copy back beside the corrected one.
    expect(tombstones()).toContain(
      metricSampleTombstoneKey(
        "sleep_min",
        PROVIDER,
        ORIGIN,
        `${day}T09:39:00Z`
      )
    );
  });

  it("re-derives the wake day from the new wake", () => {
    // Stamped as waking on `day`; corrected, the night wakes across local midnight and
    // so belongs to the NEXT day — the row has to be filed there rather than left where
    // the wrong instants put it. Only a two-hour correction, which keeps the real
    // trough inside the detector's own 12-hour reach.
    const sessionId = sample(
      "sleep_min",
      day,
      `${day}T20:00:00Z`,
      `${day}T23:00:00Z`,
      180
    );
    trace(`${day}T10:00:00Z`, `${T}T06:00:00Z`, {
      from: `${day}T22:00:00Z`,
      to: `${T}T01:00:00Z`,
    });
    // The stated wake day is `T`; a bed clock at or after noon belongs to the evening
    // before it, which is the shared fold's rule for every stated sleep window.
    const outcome = retimeSleepSessionCore(profileId, sessionId, {
      date: T,
      bed: "22:00",
      wake: "01:00",
    });
    expect(outcome.kind).toBe("retimed");
    expect(rowOf(sessionId)).toMatchObject({
      date: T,
      started_at: `${day}T22:00:00Z`,
      ended_at: `${T}T01:00:00Z`,
    });
  });

  it("refuses a session the detector has not contradicted", () => {
    // The same clocks, and the heart rate AGREES with them — so the night is not
    // hedged and the edit lock stays (#5021's out-of-scope line).
    const id = sample(
      "sleep_min",
      day,
      `${day}T09:39:00Z`,
      `${day}T14:37:00Z`,
      298
    );
    trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${day}T22:00:00Z`, {
      from: `${day}T09:39:00Z`,
      to: `${day}T14:37:00Z`,
    });
    expect(
      retimeSleepSessionCore(profileId, id, {
        date: day,
        bed: "03:39",
        wake: "08:37",
      }).kind
    ).toBe("not-hedged");
    expect(rowOf(id)?.started_at).toBe(`${day}T09:39:00Z`);
  });

  it("refuses a window of a different length, and says how long the night was", () => {
    // The defect is a wrong INSTANT with a right duration. A stated window of another
    // length has no single delta, and the alternatives — scaling a scored breakdown,
    // or dropping the stages that fall outside — are both fabrication.
    const { sessionId, stageId } = hedgedNight();
    const before = rowOf(stageId);
    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        date: day,
        bed: "03:39",
        wake: "09:37",
      })
    ).toEqual({ kind: "length-changed", storedMinutes: 298 });
    // Refused BEFORE anything moved, which is what makes a refusal safe.
    expect(rowOf(stageId)).toEqual(before);
    expect(tombstones()).toEqual([]);
  });

  it("refuses an inverted window and one that has not happened", () => {
    const { sessionId } = hedgedNight();
    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        date: day,
        bed: "08:37",
        wake: "03:39",
      }).kind
    ).toBe("invalid-window");
    const ahead = shiftDateStr(T, 90);
    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        date: ahead,
        bed: "03:39",
        wake: "08:37",
      }).kind
    ).toBe("invalid-window");
  });
});

// ── #5125: three defects a falsifying pass found on the merged feature ────────
//
// Every one was a coverage gap rather than a regression — both tiers were green on the
// head that shipped them — so each case below is written from the state it forbids
// rather than from the branch that now forbids it.
describe("the lock reads the SESSION, not the wake day (#5125 item 1)", () => {
  // The detector judges the day's MAIN session only (#5019's nap exclusion) and never
  // looks at a `source='manual'` row. Keying the lock on the wake DAY therefore let
  // every other row on a hedged day through a lock whose own comment says the opposite.
  function unjudgedRowOnAHedgedDay(kind: "nap" | "manual"): number {
    hedgedNight();
    if (kind === "nap") {
      return sample(
        "sleep_min",
        day,
        `${day}T16:00:00Z`,
        `${day}T17:00:00Z`,
        60
      );
    }
    return Number(
      db
        .prepare(
          `INSERT INTO metric_samples
             (profile_id, source, origin, metric, date, started_at, ended_at, value)
           VALUES (?, 'manual', NULL, 'sleep_min', ?, ?, ?, 60)`
        )
        .run(profileId, day, `${day}T16:00:00Z`, `${day}T17:00:00Z`)
        .lastInsertRowid
    );
  }

  for (const kind of ["nap", "manual"] as const) {
    it(`refuses a ${kind} row sharing a hedged day, and writes NOTHING`, () => {
      const id = unjudgedRowOnAHedgedDay(kind);
      const before = rowOf(id);

      expect(
        retimeSleepSessionCore(profileId, id, {
          date: day,
          bed: "11:00",
          wake: "12:00",
        }).kind
      ).toBe("not-hedged");

      expect(rowOf(id)).toEqual(before);
      // THE TAIL THAT MATTERS. The write tombstones the moved row's natural key
      // unconditionally, so a refusal that reached it would stop the source ever
      // re-sending this row — invisible until someone went looking. Asserted as the
      // TABLE's state, not as a branch that was not taken.
      expect(tombstones()).toEqual([]);
      expect(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM deleted_rows
                WHERE profile_id = ? AND kind = ?`
            )
            .get(profileId, SLEEP_RETIME_KIND) as { c: number }
        ).c
      ).toBe(0);
    });
  }

  it("still moves the session the detector DID judge", () => {
    // The other side of the same lock: narrowing it must not close the door it exists
    // to open.
    const { sessionId } = hedgedNight();
    sample("sleep_min", day, `${day}T16:00:00Z`, `${day}T17:00:00Z`, 60);
    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        date: day,
        bed: "03:39",
        wake: "08:37",
      }).kind
    ).toBe("retimed");
  });
});

describe("a night stored twice is refused, not stranded (#5125 item 2)", () => {
  it("refuses rather than moving a session whose stages another row also covers", () => {
    // `stagesOwnedBy` vetoes every stage a second same-day session also covers, so this
    // row would have moved and left its whole breakdown behind — the orphaned breakdown
    // `length-changed` exists to prevent, arriving through the path it allows.
    const { sessionId, stageId } = hedgedNight();
    // The SAME night stored twice, at instants that overlap but are not the same key.
    const twin = sample(
      "sleep_min",
      day,
      `${day}T09:45:00Z`,
      `${day}T14:43:00Z`,
      298
    );
    const before = { session: rowOf(sessionId), stage: rowOf(stageId) };

    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        date: day,
        bed: "03:39",
        wake: "08:37",
      }).kind
    ).toBe("stored-twice");

    expect(rowOf(sessionId)).toEqual(before.session);
    expect(rowOf(stageId)).toEqual(before.stage);
    expect(tombstones()).toEqual([]);
    // And the pair really is the one Review lists, which is the door the refusal names.
    expect(getOverlappingSleepSessions(profileId)).toHaveLength(1);
    expect(twin).toBeGreaterThan(0);
  });

  it("moves again once the pair is settled", () => {
    // The refusal is a redirection, not a dead end: delete the duplicate — which is
    // what Review's "Keep this one" does — and the door opens.
    const { sessionId, stageId } = hedgedNight();
    const twin = sample(
      "sleep_min",
      day,
      `${day}T09:45:00Z`,
      `${day}T14:43:00Z`,
      298
    );
    db.prepare(`DELETE FROM metric_samples WHERE id = ?`).run(twin);

    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        date: day,
        bed: "03:39",
        wake: "08:37",
      }).kind
    ).toBe("retimed");
    expect(rowOf(stageId)?.started_at).toBe(`${day}T04:00:00Z`);
  });
});

describe("one zone displays and interprets the window (#5125 item 3)", () => {
  it("nudges a night by an hour on a profile that has since moved zones", () => {
    // The surface projects the stored window through the zone in force AT those
    // instants; the fold used to read the profile's CURRENT zone. On a Tokyo→London
    // move that made a one-hour nudge a NINE-hour move, with every refusal silent
    // because the fold preserves elapsed length.
    //
    // Stored 13:00Z–18:00Z is 22:00 → 03:00 in Tokyo, a night that crosses midnight.
    const sessionId = sample(
      "sleep_min",
      day,
      `${day}T13:00:00Z`,
      `${day}T18:00:00Z`,
      300
    );
    trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${T}T04:00:00Z`, {
      from: `${day}T05:00:00Z`,
      to: `${day}T10:00:00Z`,
    });

    // The move happened AFTER the night: the profile stands in London now and lived
    // that night in Tokyo. Written through the setting the switch path writes, because
    // there is no test-only door to it.
    setTimezone(profileId, "Europe/London");
    setProfileSetting(
      profileId,
      "timezone_switches",
      serializeTimezoneSwitches([
        { at: `${T}T09:00:00Z`, from: "Asia/Tokyo", to: "Europe/London" },
      ])
    );

    // One hour earlier on the clock the person actually kept: 21:00 → 02:00 Tokyo.
    const outcome = retimeSleepSessionCore(profileId, sessionId, {
      date: T,
      bed: "21:00",
      wake: "02:00",
    });

    expect(outcome.kind).toBe("retimed");
    expect(rowOf(sessionId)).toMatchObject({
      started_at: `${day}T12:00:00Z`,
      ended_at: `${day}T17:00:00Z`,
    });
  });
});

describe("the undo, which MOVES rather than re-inserts", () => {
  it("puts every row back, withdraws the tombstone, and adds no second night", () => {
    const { sessionId, stageId } = hedgedNight();
    const before = { session: rowOf(sessionId), stage: rowOf(stageId) };
    const outcome = retimeSleepSessionCore(profileId, sessionId, {
      date: day,
      bed: "03:39",
      wake: "08:37",
    });
    expect(outcome.kind).toBe("retimed");
    const undoId = outcome.kind === "retimed" ? outcome.undoId : 0;

    expect(restoreSleepRetime(profileId, undoId)).toBe(true);
    expect(rowOf(sessionId)).toEqual(before.session);
    expect(rowOf(stageId)).toEqual(before.stage);
    // ONE night, not two. A generic capture-and-restore would have inserted a second
    // session at the old instants beside the moved one, because a re-time moves the
    // natural key its live-row adoption looks for.
    expect(sleepRowCount()).toBe(1);
    // With the key free again the exporter's next re-send refreshes the restored row
    // rather than being dropped, which is what makes the undo complete.
    expect(tombstones()).toEqual([]);
  });

  it("is not offered in the Trash, because nothing was deleted", () => {
    const { sessionId } = hedgedNight();
    retimeSleepSessionCore(profileId, sessionId, {
      date: day,
      bed: "03:39",
      wake: "08:37",
    });
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM deleted_rows
              WHERE profile_id = ? AND kind = ?`
          )
          .get(profileId, SLEEP_RETIME_KIND) as { c: number }
      ).c
    ).toBe(1);
    // The holding row exists and the Trash does not list it: "Recently deleted" would
    // misname a session that is standing, at different hours.
    expect(listTrash(profileId, 30)).toEqual([]);
    expect(countTrash(profileId)).toBe(0);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { shiftDateStr, utcInstant } from "@/lib/date";
import {
  retimeSleepSessionCore,
  restoreSleepRetime,
} from "@/lib/sleep-retime-db";
import { SLEEP_RETIME_KIND } from "@/lib/sleep-retime-kind";
import { metricSampleTombstoneKey } from "@/lib/integrations/tombstone-keys";
import { getSuspectSleepWakeDays } from "@/lib/queries/sleep-clock-skew";
import { countTrash, listTrash } from "@/lib/queries/trash";

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
  value: number,
  source = PROVIDER
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
        source,
        source === "manual" ? null : ORIGIN,
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
      bedAt: `${day}T03:39:00Z`,
      wakeAt: `${day}T08:37:00Z`,
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
    // Stamped as waking on `day`; corrected, the night wakes the day BEFORE — so the
    // row has to be filed there rather than left where the wrong instants put it.
    // A five-hour night stamped eleven hours late keeps the real trough inside the
    // detector's own reach, which is what makes it hedged in the first place.
    const before = shiftDateStr(day, -1);
    const sessionId = sample(
      "sleep_min",
      day,
      `${day}T05:00:00Z`,
      `${day}T10:00:00Z`,
      300
    );
    trace(`${before}T12:00:00Z`, `${day}T22:00:00Z`, {
      from: `${before}T18:00:00Z`,
      to: `${before}T23:00:00Z`,
    });
    const outcome = retimeSleepSessionCore(profileId, sessionId, {
      bedAt: `${before}T18:00:00Z`,
      wakeAt: `${before}T23:00:00Z`,
    });
    expect(outcome.kind).toBe("retimed");
    expect(rowOf(sessionId)?.date).toBe(before);
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
        bedAt: `${day}T03:39:00Z`,
        wakeAt: `${day}T08:37:00Z`,
      }).kind
    ).toBe("not-hedged");
    expect(rowOf(id)?.started_at).toBe(`${day}T09:39:00Z`);
    expect(tombstones()).toEqual([]);
  });

  it("refuses a window of a different length, and says how long the night was", () => {
    // The defect is a wrong INSTANT with a right duration. A stated window of another
    // length has no single delta, and the alternatives — scaling a scored breakdown,
    // or dropping the stages that fall outside — are both fabrication.
    const { sessionId, stageId } = hedgedNight();
    const before = rowOf(stageId);
    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        bedAt: `${day}T03:39:00Z`,
        wakeAt: `${day}T09:37:00Z`,
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
        bedAt: `${day}T08:37:00Z`,
        wakeAt: `${day}T03:39:00Z`,
      }).kind
    ).toBe("invalid-window");
    const ahead = shiftDateStr(T, 90);
    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        bedAt: `${ahead}T03:39:00Z`,
        wakeAt: `${ahead}T08:37:00Z`,
      }).kind
    ).toBe("invalid-window");
    // NO REFUSAL WRITES A TOMBSTONE (#5125). Asserted on the table rather than read
    // off the branch: the write kills the moved row's natural key, and a refusal that
    // wrote one would silently stop the source re-sending a row it never moved.
    expect(tombstones()).toEqual([]);
  });
});

describe("the lock is on the SESSION, not on its wake day (#5125)", () => {
  // The detector's population is NARROWER than the day it reports. It judges the wake
  // day's MAIN session only (#5019 — a nap always reads as a contradiction against its
  // own overnight trough, so judging naps flagged good nights) and it never sees a
  // `source = 'manual'` row at all. Both rows below therefore sit on a hedged day
  // having been contradicted by nothing, which is exactly what the lock's own sentence
  // says must not pass.
  //
  // The tombstone assertion is the half with the longest tail: the write kills the
  // moved row's natural key, so a nap carried through this lock could never be
  // re-sent by its source, and nobody would go looking.
  it.each([
    ["a nap the detector never judged", PROVIDER],
    ["a hand-logged row the detector cannot see", "manual"],
  ])("refuses %s on a hedged day", (_case, source) => {
    hedgedNight();
    const id = sample(
      "sleep_min",
      day,
      `${day}T16:00:00Z`,
      `${day}T17:00:00Z`,
      60,
      source
    );
    // The DAY is hedged — which is what used to carry these rows through.
    expect(getSuspectSleepWakeDays(profileId, shiftDateStr(T, -30))).toEqual(
      new Set([day])
    );

    expect(
      retimeSleepSessionCore(profileId, id, {
        bedAt: `${day}T11:00:00Z`,
        wakeAt: `${day}T12:00:00Z`,
      }).kind
    ).toBe("not-hedged");
    expect(rowOf(id)?.started_at).toBe(`${day}T16:00:00Z`);
    expect(tombstones()).toEqual([]);
  });

  it("still moves the night the detector DID contradict", () => {
    // The converse, in the same fixture the refusals use: adding a nap beside the
    // night must not close the door on the night itself.
    const { sessionId } = hedgedNight();
    sample("sleep_min", day, `${day}T16:00:00Z`, `${day}T17:00:00Z`, 60);
    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        bedAt: `${day}T03:39:00Z`,
        wakeAt: `${day}T08:37:00Z`,
      }).kind
    ).toBe("retimed");
    expect(rowOf(sessionId)?.started_at).toBe(`${day}T03:39:00Z`);
  });
});

describe("a night stored twice, whose stages have two owners (#5125)", () => {
  /** The same night filed a second time — the state Review's "Keep this one" is for. */
  const twinOf = () =>
    sample("sleep_min", day, `${day}T09:41:00Z`, `${day}T14:35:00Z`, 294);

  it("refuses rather than move a session away from its breakdown", () => {
    const { sessionId, stageId } = hedgedNight();
    const twin = twinOf();
    const before = { session: rowOf(sessionId), stage: rowOf(stageId) };

    // `stagesOwnedBy` vetoes every stage the twin also covers, so the move would have
    // taken the session six hours away and left the breakdown at the old hours — the
    // orphaned breakdown `length-changed` exists to prevent, through the path it
    // allows. The dialog's "The sleep stages move with the session." stays true
    // because the move does not happen.
    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        bedAt: `${day}T03:39:00Z`,
        wakeAt: `${day}T08:37:00Z`,
      })
    ).toEqual({ kind: "stages-shared" });
    expect(rowOf(sessionId)).toEqual(before.session);
    expect(rowOf(stageId)).toEqual(before.stage);
    expect(rowOf(twin)?.started_at).toBe(`${day}T09:41:00Z`);
    expect(tombstones()).toEqual([]);
  });

  it("moves a twinned night that has no breakdown to strand", () => {
    // The refusal is about STAGES, not about the duplicate: with nothing in the band
    // to leave behind, the door stays open on a night Review is also offering to fix.
    const sessionId = sample(
      "sleep_min",
      day,
      `${day}T09:39:00Z`,
      `${day}T14:37:00Z`,
      298
    );
    twinOf();
    trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${day}T22:00:00Z`, {
      from: `${day}T03:39:00Z`,
      to: `${day}T08:37:00Z`,
    });
    expect(
      retimeSleepSessionCore(profileId, sessionId, {
        bedAt: `${day}T03:39:00Z`,
        wakeAt: `${day}T08:37:00Z`,
      }).kind
    ).toBe("retimed");
    expect(rowOf(sessionId)?.started_at).toBe(`${day}T03:39:00Z`);
  });
});

describe("the undo, which MOVES rather than re-inserts", () => {
  it("puts every row back, withdraws the tombstone, and adds no second night", () => {
    const { sessionId, stageId } = hedgedNight();
    const before = { session: rowOf(sessionId), stage: rowOf(stageId) };
    const outcome = retimeSleepSessionCore(profileId, sessionId, {
      bedAt: `${day}T03:39:00Z`,
      wakeAt: `${day}T08:37:00Z`,
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
      bedAt: `${day}T03:39:00Z`,
      wakeAt: `${day}T08:37:00Z`,
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

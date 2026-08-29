// DB INTEGRATION TIER — #3628, the prod pair and everything the rule must NOT touch.
//
// THE SCENARIO, measured on prod 2026-08-23 and repaired by hand once. After a device
// zone change Health Connect held the same Fitbit night twice: a first write whose
// instants came from the wall clock under the old zone (New York), and a corrected
// write a day later under the new one (Honolulu). Exactly 6 h apart, overlapping by
// 17 minutes, same 377-minute duration, re-scored stages. `sleep_min` keys on
// `started_at`, so the re-timed session was a NEW natural key rather than a
// correction — and `mainSleepSession` picks the longest per wake-day, so the phantom
// became the only "night" of its own wake-day while the real one sat on the next.
//
// THE TWO ROWS LAND ON DIFFERENT `date`s, and that is why this is not #3424's rule:
// under Honolulu the first ends 20:15 on 08-21 and the second 02:15 on 08-22. The
// day-bucket supersede decides WITHIN one date by construction ("cover the day"), so it
// could never see this pair. The rule under test collapses across dates and is bounded
// instead by same-origin + overlap + arrival order.
//
// THIS RULE DELETES A PERSON'S HEALTH RECORD, so the refusals below are the point of
// the file rather than an appendix, and each is a night the rule must leave alone.
//
// SYNTHETIC ONLY: an invented traveller, invented stage minutes, no PHI.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { getTimezone, setTimezone } from "@/lib/settings";
import { metricSampleTombstoneKey } from "@/lib/integrations/tombstone-keys";

const HONOLULU = "Pacific/Honolulu";
const FITBIT = "com.fitbit.FitbitMobile";
const HC = "health-connect";

// The prod pair. MIS_ZONED ends 2026-08-21 20:15 Honolulu (wake-day 08-21); CORRECTED
// ends 2026-08-22 02:15 Honolulu (wake-day 08-22). 377 minutes each, 17 min of overlap.
const MIS_ZONED = {
  start: "2026-08-21T23:58:00Z",
  end: "2026-08-22T06:15:00Z",
};
const CORRECTED = {
  start: "2026-08-22T05:58:00Z",
  end: "2026-08-22T12:15:00Z",
};

// Four stages tiling a session exactly, as FRACTIONS of its length — so a short nap
// gets four stages inside its own hour and a deleted session's whole breakdown stays
// checkable by count whatever the session's length.
const STAGE_PLAN: [string, number, number][] = [
  ["deep", 0, 0.16],
  ["light", 0.16, 0.64],
  ["rem", 0.64, 0.8],
  ["awake", 0.8, 1],
];

const STAGE_METRICS = STAGE_PLAN.map(([stage]) => `sleep_${stage}_min`);

function minutes(window: { start: string; end: string }): number {
  return (
    (new Date(window.end).getTime() - new Date(window.start).getTime()) / 60_000
  );
}

function at(window: { start: string; end: string }, fraction: number): string {
  const span = minutes(window);
  return new Date(
    new Date(window.start).getTime() + Math.round(span * fraction) * 60_000
  ).toISOString();
}

function session(
  window: { start: string; end: string },
  origin: string | null = FITBIT
) {
  return {
    start_time: window.start,
    end_time: window.end,
    duration_seconds: minutes(window) * 60,
    ...(origin ? { metadata: { data_origin: origin } } : {}),
    stages: STAGE_PLAN.map(([stage, from, to]) => ({
      stage,
      start_time: at(window, from),
      end_time: at(window, to),
    })),
  };
}

function push(
  profileId: number,
  timestamp: string,
  sleep: Record<string, unknown>[]
) {
  return ingestHealthConnectPayload(
    profileId,
    parseHealthConnectPayload({ timestamp, sleep }, getTimezone(profileId))
  );
}

function sessions(profileId: number): { started_at: string; date: string }[] {
  return db
    .prepare(
      `SELECT started_at, date FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' ORDER BY started_at`
    )
    .all(profileId) as { started_at: string; date: string }[];
}

function stageCount(profileId: number, date: string): number {
  const placeholders = STAGE_METRICS.map(() => "?").join(",");
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM metric_samples
          WHERE profile_id = ? AND date = ? AND metric IN (${placeholders})`
      )
      .get(profileId, date, ...STAGE_METRICS) as { n: number }
  ).n;
}

function tombstones(profileId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT natural_key FROM import_tombstones
        WHERE profile_id = ? AND target_table = 'metric_samples'`
    )
    .all(profileId) as { natural_key: string }[];
  return new Set(rows.map((r) => r.natural_key));
}

let profileId: number;

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("HC Sleeper")
      .lastInsertRowid
  );
  setTimezone(profileId, HONOLULU);
});

describe("a re-timed Fitbit sleep session collapses to the later write", () => {
  it("leaves one night, its stages, tombstones for the loser, and refuses the re-send", () => {
    push(profileId, "2026-08-22T13:40:00Z", [session(MIS_ZONED)]);
    expect(sessions(profileId)).toEqual([
      { started_at: MIS_ZONED.start, date: "2026-08-21" },
    ]);
    expect(stageCount(profileId, "2026-08-21")).toBe(4);

    // The corrected write, a day later. The rolling 48 h window re-sends the first one
    // too — which is exactly why arrival order cannot be read off `pushed_at`: this
    // push moves the stored row's stamp to its own.
    const second = push(profileId, "2026-08-23T14:42:00Z", [
      session(CORRECTED),
      session(MIS_ZONED),
    ]);

    expect(sessions(profileId)).toEqual([
      { started_at: CORRECTED.start, date: "2026-08-22" },
    ]);
    expect(stageCount(profileId, "2026-08-21")).toBe(0);
    expect(stageCount(profileId, "2026-08-22")).toBe(4);
    // Review's split reports the collapse rather than calling the push `unchanged`.
    expect(second.split.superseded).toBeGreaterThan(0);

    // A tombstone per deleted key — the session and every one of its stages — because
    // Health Connect never withdraws the first write and the exporter keeps sending it.
    const stones = tombstones(profileId);
    expect(
      stones.has(
        metricSampleTombstoneKey("sleep_min", HC, FITBIT, MIS_ZONED.start)
      )
    ).toBe(true);
    for (const [stage, from] of STAGE_PLAN) {
      expect(
        stones.has(
          metricSampleTombstoneKey(
            `sleep_${stage}_min`,
            HC,
            FITBIT,
            at(MIS_ZONED, from)
          )
        )
      ).toBe(true);
    }

    // A third push still carrying the withdrawn record inserts nothing.
    const third = push(profileId, "2026-08-24T14:40:00Z", [session(MIS_ZONED)]);
    expect(third.split.inserted).toBe(0);
    expect(sessions(profileId)).toEqual([
      { started_at: CORRECTED.start, date: "2026-08-22" },
    ]);
  });
});

// EVERY REFUSAL, AS ONE TABLE. Each row is a second session pushed a day after the
// first; `survives` is how many `sleep_min` rows must remain. The rule may only ever
// collapse an overlap it can attribute to ONE named origin — everything else is a
// question it is not entitled to answer, and a wrong answer deletes a night.
describe("what the collapse refuses to touch", () => {
  const NAP = { start: "2026-08-22T20:00:00Z", end: "2026-08-22T21:00:00Z" };
  // #1191's fragmented night: two pieces of one night separated by an awake gap, so
  // NON-overlapping by construction and untouched without the rule knowing about it.
  const FRAGMENT = {
    start: "2026-08-22T12:45:00Z",
    end: "2026-08-22T14:00:00Z",
  };

  it.each([
    // A nap on the same wake-day as the night: overlaps nothing.
    ["a later non-overlapping nap", NAP, FITBIT, 2],
    ["a #1191 night fragment after the gap", FRAGMENT, FITBIT, 2],
    // Overlapping, but the origins differ — two devices reporting one person's sleep
    // is a different question and not this rule's to answer.
    [
      "an overlapping session from another device",
      CORRECTED,
      "com.oura.oura",
      2,
    ],
    // An unattributed exporter. NULL is an UNKNOWN origin, not a shared one.
    ["an overlapping session with no stated origin", CORRECTED, null, 2],
    // The control: same origin, overlapping, later push. This one collapses.
    ["an overlapping session from the same origin", CORRECTED, FITBIT, 1],
  ] as const)("keeps both for %s", (_label, window, origin, survives) => {
    push(profileId, "2026-08-22T13:40:00Z", [session(MIS_ZONED)]);
    push(profileId, "2026-08-23T14:42:00Z", [session(window, origin)]);
    expect(sessions(profileId)).toHaveLength(survives);
  });

  it("keeps both when one push carries the pair — nothing ranks two rows of one push", () => {
    push(profileId, "2026-08-23T14:42:00Z", [
      session(MIS_ZONED),
      session(CORRECTED),
    ]);
    expect(sessions(profileId)).toHaveLength(2);
  });

  it("keeps a hand-edited night and reports it as still overlapping", () => {
    push(profileId, "2026-08-22T13:40:00Z", [session(MIS_ZONED)]);
    db.prepare(
      `UPDATE metric_samples SET edited = 1
        WHERE profile_id = ? AND metric = 'sleep_min' AND started_at = ?`
    ).run(profileId, MIS_ZONED.start);

    const second = push(profileId, "2026-08-23T14:42:00Z", [
      session(CORRECTED),
    ]);
    expect(sessions(profileId)).toHaveLength(2);
    expect(second.split.superseded).toBe(0);
    expect(tombstones(profileId).size).toBe(0);
  });

  it("never touches another source's overlapping session", () => {
    push(profileId, "2026-08-22T13:40:00Z", [session(MIS_ZONED)]);
    db.prepare(
      `UPDATE metric_samples SET source = 'oura' WHERE profile_id = ? AND started_at = ?`
    ).run(profileId, MIS_ZONED.start);

    push(profileId, "2026-08-23T14:42:00Z", [session(CORRECTED)]);
    const bySource = db
      .prepare(
        `SELECT source FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min' ORDER BY started_at`
      )
      .all(profileId) as { source: string }[];
    expect(bySource.map((r) => r.source)).toEqual(["oura", HC]);
  });

  it("leaves a same-day nap's own stages behind when the night it neighbours collapses", () => {
    // The stage sweep is bounded by CONTAINMENT in the loser's window, not by its
    // `date` — a nap filed under the same wake-day keeps every stage row it owns.
    const NAP_SAME_DAY = {
      start: "2026-08-21T18:00:00Z",
      end: "2026-08-21T19:00:00Z",
    };
    push(profileId, "2026-08-22T13:40:00Z", [
      session(MIS_ZONED),
      session(NAP_SAME_DAY),
    ]);
    expect(stageCount(profileId, "2026-08-21")).toBe(8);

    push(profileId, "2026-08-23T14:42:00Z", [session(CORRECTED)]);
    // The night's four stages went with it; the nap's four are untouched.
    expect(stageCount(profileId, "2026-08-21")).toBe(4);
    expect(sessions(profileId).map((r) => r.started_at)).toEqual([
      NAP_SAME_DAY.start,
      CORRECTED.start,
    ]);
  });
});

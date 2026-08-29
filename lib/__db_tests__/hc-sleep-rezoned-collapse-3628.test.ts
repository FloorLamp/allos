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

// THE FIXTURE HAS TO BE ABLE TO REACH THE FAILING STATES, which is what the first
// version of this file could not do: it emitted stages that tiled exactly, on one date,
// in one instant spelling, from one package. Each option below exists because a defect
// lived where the fixture could not go.
interface SessionOpts {
  origin?: string | null;
  /** Omit the stage rows entirely — a session scored by a LATER push. */
  stages?: boolean;
  /** Push the stage edges out past the session by this many seconds (scorer jitter). */
  jitterSec?: number;
  /** State only `end_time` + `duration_seconds`, so the PARSER derives `start_time`
   *  through `toISOString()` and spells the same instant `…:00.000Z`. */
  deriveStart?: boolean;
}

function session(
  window: { start: string; end: string },
  opts: SessionOpts = {}
) {
  const {
    origin = FITBIT,
    stages = true,
    jitterSec = 0,
    deriveStart = false,
  } = opts;
  const shift = (iso: string, sec: number) =>
    new Date(new Date(iso).getTime() + sec * 1000).toISOString();
  return {
    ...(deriveStart ? {} : { start_time: window.start }),
    end_time: window.end,
    duration_seconds: minutes(window) * 60,
    ...(origin ? { metadata: { data_origin: origin } } : {}),
    ...(stages
      ? {
          stages: STAGE_PLAN.map(([stage, from, to], i) => ({
            stage,
            start_time:
              i === 0 ? shift(at(window, from), -jitterSec) : at(window, from),
            end_time:
              i === STAGE_PLAN.length - 1
                ? shift(at(window, to), jitterSec)
                : at(window, to),
          })),
        }
      : {}),
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
    push(profileId, "2026-08-23T14:42:00Z", [session(window, { origin })]);
    expect(sessions(profileId)).toHaveLength(survives);
  });

  it("keeps both when one push carries the pair — nothing ranks two rows of one push", () => {
    // The REPORTING half of this sequence is asserted in the warnings block below.
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

  it("says the night is stored twice, in its own sentence and not the day-total one", () => {
    // The residue reaches Review as ONE count with the day-bucket rule's, but a
    // duplicated night does not make a day's TOTAL read high — so it gets a sentence
    // about the night, and the day-total sentence is not emitted for it at all.
    push(profileId, "2026-08-22T13:40:00Z", [session(MIS_ZONED)]);
    db.prepare(
      `UPDATE metric_samples SET edited = 1
        WHERE profile_id = ? AND metric = 'sleep_min' AND started_at = ?`
    ).run(profileId, MIS_ZONED.start);

    const parsed = parseHealthConnectPayload(
      { timestamp: "2026-08-23T14:42:00Z", sleep: [session(CORRECTED)] },
      getTimezone(profileId)
    );
    ingestHealthConnectPayload(profileId, parsed);
    expect(parsed.details.warnings).toEqual([
      "A sleep session overlaps another reading of the same night and was not replaced by this push, so that night is stored twice. Delete whichever is wrong in Data \u2192 Manage.",
    ]);
  });

  it("says so for a pair ONE push carries against itself, which nothing later collapses", () => {
    // Two rows of one push cannot rank each other, so neither is collapsed — and until
    // this was counted, that sequence left the phantom stored forever with `warnings:
    // []` and nothing anywhere to notice it. It is also why the sentence names no
    // cause: this class and the edit lock are different reasons for one symptom.
    const parsed = parseHealthConnectPayload(
      {
        timestamp: "2026-08-23T14:42:00Z",
        sleep: [session(MIS_ZONED), session(CORRECTED)],
      },
      getTimezone(profileId)
    );
    ingestHealthConnectPayload(profileId, parsed);
    expect(sessions(profileId)).toHaveLength(2);
    expect(parsed.details.warnings).toEqual([
      "A sleep session overlaps another reading of the same night and was not replaced by this push, so that night is stored twice. Delete whichever is wrong in Data \u2192 Manage.",
    ]);
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

// ─────────────────────────────────────────────────────────────────────────────
// THE FALSIFIER'S FIVE. Every one of these was invisible to the first version of
// this file — not because the assertions were weak, but because the FIXTURE could
// not reach the state: stages that tiled exactly, on one date, in one instant
// spelling, from one package. A mutation table proves a rule does what it says; it
// cannot prove the rule is the right rule. These are the shapes that decide that.
// ─────────────────────────────────────────────────────────────────────────────

const NEW_YORK = "America/New_York";

function stageRows(
  profileId: number
): { metric: string; date: string; started_at: string }[] {
  const placeholders = STAGE_METRICS.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT metric, date, started_at FROM metric_samples
        WHERE profile_id = ? AND metric IN (${placeholders})
        ORDER BY started_at`
    )
    .all(profileId, ...STAGE_METRICS) as {
    metric: string;
    date: string;
    started_at: string;
  }[];
}

describe("a stage row may not outlive the session it belongs to", () => {
  it("collapses stages filed under a DIFFERENT date from their session", () => {
    // `sleep_min.date` is frozen at first write by `resendDay`, but a stage row
    // arriving for the FIRST time in a later push takes its wake-day from the
    // profile's zone AT THAT MOMENT. For a traveller mid-switch — the population this
    // rule exists for — the two dates diverge, and a stage sweep keyed on the
    // session's `date` cannot see its own session's stages.
    push(profileId, "2026-08-22T13:40:00Z", [
      session(MIS_ZONED, { stages: false }),
    ]);
    expect(sessions(profileId)).toEqual([
      { started_at: MIS_ZONED.start, date: "2026-08-21" },
    ]);

    setTimezone(profileId, NEW_YORK);
    push(profileId, "2026-08-22T15:40:00Z", [session(MIS_ZONED)]);
    // The session keeps its frozen day; its stages land on the New York one.
    expect(new Set(stageRows(profileId).map((r) => r.date))).toEqual(
      new Set(["2026-08-22"])
    );

    push(profileId, "2026-08-23T14:42:00Z", [session(CORRECTED)]);
    // The phantom is gone, and so is every stage row that belonged to it — the
    // surviving night's breakdown is its own and nothing else's.
    expect(sessions(profileId).map((r) => r.started_at)).toEqual([
      CORRECTED.start,
    ]);
    expect(stageRows(profileId).map((r) => r.started_at)).toEqual(
      STAGE_PLAN.map(([, from]) => at(CORRECTED, from))
    );
  });

  it("collapses stages that arrive in the SAME push as the write that collapses them", () => {
    // Ordinary exporter behaviour: push 1 delivers the session unscored, push 2
    // delivers it scored alongside the corrected write. Those stage rows are NEW, so
    // an id watermark that excludes this push's own rows cannot see them — and the
    // wake-day is left holding a full stage breakdown and no session at all.
    push(profileId, "2026-08-22T13:40:00Z", [
      session(MIS_ZONED, { stages: false }),
    ]);
    push(profileId, "2026-08-23T14:42:00Z", [
      session(MIS_ZONED),
      session(CORRECTED),
    ]);
    expect(sessions(profileId).map((r) => r.started_at)).toEqual([
      CORRECTED.start,
    ]);
    expect(stageCount(profileId, "2026-08-21")).toBe(0);
  });

  it("collapses every stage of a session whose scorer overran its edges", () => {
    // Nothing clamps a stage to its session — the parser copies the payload's
    // instants. One minute of jitter at each end and a containment test closed on
    // both ends keeps the first and last stage, leaving a two-stage fragment of a
    // night that no longer exists, which reads like a real short night's breakdown.
    push(profileId, "2026-08-22T13:40:00Z", [
      session(MIS_ZONED, { jitterSec: 60 }),
    ]);
    expect(stageCount(profileId, "2026-08-21")).toBe(4);

    push(profileId, "2026-08-23T14:42:00Z", [session(CORRECTED)]);
    expect(sessions(profileId).map((r) => r.started_at)).toEqual([
      CORRECTED.start,
    ]);
    expect(stageCount(profileId, "2026-08-21")).toBe(0);
  });

  it("refuses the collapse rather than claim a nested nap's stages", () => {
    // A nap slept inside the phantom's window has its own breakdown, and geometry
    // alone cannot tell whose a stage row is. Deleting them robs a real nap; leaving
    // them inflates the night that survives. Neither is acceptable, so the collapse
    // declines and says so.
    const NAP_INSIDE = {
      start: "2026-08-22T01:00:00Z",
      end: "2026-08-22T02:00:00Z",
    };
    push(profileId, "2026-08-22T13:40:00Z", [
      session(MIS_ZONED),
      session(NAP_INSIDE),
    ]);
    const second = push(profileId, "2026-08-23T14:42:00Z", [
      session(CORRECTED),
    ]);
    expect(sessions(profileId)).toHaveLength(3);
    expect(second.split.superseded).toBe(0);
    expect(tombstones(profileId).size).toBe(0);
  });
});

describe("the rule may never delete the night it exists to protect", () => {
  it("refuses a re-send whose start the PARSER spells differently", () => {
    // `metricSampleTombstoneKey` keys on the raw `started_at` STRING, and the parser
    // itself emits two spellings of one instant: given `end_time` + `duration_seconds`
    // and no `start_time` it derives the start through `toISOString()`, spelling
    // `…:00.000Z` where the vendor field spells `…:00Z`. That re-send misses the
    // tombstone veto and enters as a NEW row above the watermark — and a rule keyed on
    // overlap alone would let it delete and tombstone the corrected night, producing
    // the exact symptom #3628 was opened to cure and making it permanent.
    push(profileId, "2026-08-22T13:40:00Z", [session(MIS_ZONED)]);
    push(profileId, "2026-08-23T14:42:00Z", [session(CORRECTED)]);
    expect(sessions(profileId).map((r) => r.started_at)).toEqual([
      CORRECTED.start,
    ]);

    push(profileId, "2026-08-24T14:40:00Z", [
      session(CORRECTED, { deriveStart: true }),
    ]);
    // The two spellings are one instant, so the displacement is ZERO — that is not a
    // re-timing, and the corrected night is still here.
    const after = sessions(profileId).map((r) => r.started_at);
    expect(after).toContain(CORRECTED.start);
    expect(
      tombstones(profileId).has(
        metricSampleTombstoneKey("sleep_min", HC, FITBIT, CORRECTED.start)
      )
    ).toBe(false);
  });

  it("refuses the re-spelled re-send even with no stage row to make it ambiguous", () => {
    // The case above is held by TWO barriers — the zero displacement, and the stage
    // rows of two identical windows owning each other ambiguously. Unscored sessions
    // remove the second, so this isolates the first: nothing but "zero is not a
    // re-timing" stands between the re-spelled row and the corrected night.
    push(profileId, "2026-08-22T13:40:00Z", [
      session(MIS_ZONED, { stages: false }),
    ]);
    push(profileId, "2026-08-23T14:42:00Z", [
      session(CORRECTED, { stages: false }),
    ]);
    expect(sessions(profileId).map((r) => r.started_at)).toEqual([
      CORRECTED.start,
    ]);

    push(profileId, "2026-08-24T14:40:00Z", [
      session(CORRECTED, { stages: false, deriveStart: true }),
    ]);
    expect(sessions(profileId).map((r) => r.started_at)).toContain(
      CORRECTED.start
    );
    expect(
      tombstones(profileId).has(
        metricSampleTombstoneKey("sleep_min", HC, FITBIT, CORRECTED.start)
      )
    ).toBe(false);
  });

  it("keeps a genuine short session overlapping a night from the same PACKAGE", () => {
    // `data_origin` is the writing APP's package name, not a device. One package
    // writes main sleep, naps, and — for an aggregator — several devices' sessions.
    // "Same origin" therefore does not mean "same sleeper", and an overlap inside one
    // package is not by itself a re-write. Deleting the night here would drop the
    // wake-day from 480 minutes to 60 and hand `mainSleepSession` the short one, which
    // is #2603's failure mode reached by deletion rather than election.
    const NIGHT = {
      start: "2026-08-21T20:00:00Z",
      end: "2026-08-22T04:00:00Z",
    };
    const EARLY = {
      start: "2026-08-21T19:00:00Z",
      end: "2026-08-21T20:01:00Z",
    };
    push(profileId, "2026-08-22T13:40:00Z", [session(NIGHT)]);
    const second = push(profileId, "2026-08-23T14:42:00Z", [session(EARLY)]);
    expect(sessions(profileId).map((r) => r.started_at)).toEqual([
      EARLY.start,
      NIGHT.start,
    ]);
    expect(second.split.superseded).toBe(0);
  });
});

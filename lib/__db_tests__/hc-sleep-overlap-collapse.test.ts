// DB INTEGRATION TIER — the same-origin overlapping sleep collapse (#3628).
//
// WHAT IS BEING GUARDED. An ingest path that DELETES a stored night and tombstones its
// natural keys, permanently: nothing withdraws a tombstone an ingest collapse wrote. So
// the cases below are written for an adversary. Every one drives the REAL parser and the
// REAL chunked ingest — a spec that seeded rows by hand would be exercising a store the
// production path cannot produce, and the heart rate that decides the verdict only
// reaches disk because `ingestHealthConnectPayload` commits it before the collapse runs.
//
// THE PAIR IS THE PROD ONE (#3628): two Fitbit sessions of one origin, 6 h apart, 17 min
// of overlap, equal duration, re-scored stages — and 78 bpm inside the phantom window
// against 58 inside the real one, with a 68 bpm awake block. Only the heart rate
// separates them; every geometric term is identical on both sides on purpose.
//
// SYNTHETIC ONLY: fictional profiles, invented heart rates, no PHI.

import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  parseHealthConnectPayload,
  HEALTH_CONNECT_ID,
} from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { upsertMetricSamples } from "@/lib/integrations/normalize";
import {
  getMainSleepNightlyMinutes,
  getOverlappingSleepSessions,
  getSleepStageComposition,
} from "@/lib/queries";
import { metricSampleTombstoneKey } from "@/lib/integrations/tombstone-keys";

const HC = HEALTH_CONNECT_ID;
const ORIGIN = "com.fitbit.FitbitMobile";
// Honolulu, so the pair lands on TWO different wake days — the defect's own signature,
// and the thing a candidate query narrowed to one `date` would miss.
const TZ = "Pacific/Honolulu";

type Rec = Record<string, unknown>;

let profileId: number;
// The two wake days, anchored to the clock so the Review read's 90-day floor cannot
// expire this fixture as real time passes.
let day0: string;
let day1: string;

const at = (day: string, hhmm: string) => `${day}T${hhmm}:00Z`;
const msOf = (iso: string) => Date.parse(iso);

/** Per-minute heart rate records across `[from, to)`, all at one bpm. */
function hrRun(from: string, to: string, bpm: number): Rec[] {
  const out: Rec[] = [];
  for (let ms = msOf(from); ms < msOf(to); ms += 60_000)
    out.push({ time: new Date(ms).toISOString(), bpm });
  return out;
}

/** A sleep session with `count` stages tiling its own window. */
function session(start: string, end: string, count: number): Rec {
  const step = (msOf(end) - msOf(start)) / count;
  const names = ["deep", "light", "rem", "awake"];
  return {
    start_time: start,
    end_time: end,
    duration_seconds: (msOf(end) - msOf(start)) / 1000,
    metadata: { data_origin: ORIGIN },
    stages: Array.from({ length: count }, (_, i) => ({
      stage: names[i % names.length],
      start_time: new Date(msOf(start) + i * step).toISOString(),
      end_time: new Date(msOf(start) + (i + 1) * step).toISOString(),
    })),
  };
}

/** Both nights stored, nothing tombstoned, and Review naming the pair for a person. */
function bothStand() {
  expect(sessionsInStore()).toHaveLength(2);
  expect(tombstones().size).toBe(0);
  const pairs = getOverlappingSleepSessions(profileId);
  expect(pairs).toHaveLength(1);
  expect(pairs[0].origin).toBe(ORIGIN);
  expect(pairs[0].sessions.map((s) => s.started_at).sort()).toEqual(
    [phantom().start, real().start].sort()
  );
}

function push(body: Rec) {
  const parsed = parseHealthConnectPayload(body, TZ);
  return ingestHealthConnectPayload(profileId, parsed, HC);
}

function sessionsInStore(): { date: string; started_at: string }[] {
  return db
    .prepare(
      `SELECT date, started_at FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' ORDER BY started_at`
    )
    .all(profileId) as { date: string; started_at: string }[];
}

function stageDates(): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT date FROM metric_samples
          WHERE profile_id = ? AND metric LIKE 'sleep_%_min'
            AND metric <> 'sleep_min' ORDER BY date`
      )
      .all(profileId) as { date: string }[]
  ).map((r) => r.date);
}

function tombstones(): Set<string> {
  return new Set(
    (
      db
        .prepare(
          `SELECT natural_key FROM import_tombstones
            WHERE profile_id = ? AND target_table = 'metric_samples'`
        )
        .all(profileId) as { natural_key: string }[]
    ).map((r) => r.natural_key)
  );
}

// ── the fixture, as three pushes ──────────────────────────────────────────────
//
// PUSH 1 carries the mis-zoned first write and the day's awake heart rate. PUSH 2, a day
// later, carries the corrected session and the heart rate inside it. Nothing else differs.
const phantom = () => ({ start: at(day0, "23:58"), end: at(day1, "06:15") });
const real = () => ({ start: at(day1, "05:58"), end: at(day1, "12:15") });

function pushOne(
  hr: Rec[] = hrRun(at(day0, "23:58"), at(day1, "06:15"), 78),
  referenceHours = 8
) {
  const w = phantom();
  return push({
    timestamp: at(day1, "13:40"),
    sleep: [session(w.start, w.end, 4)],
    heart_rate: [
      // The awake reference: a daytime block outside every recorded session.
      ...hrRun(
        at(day0, "12:00"),
        at(day0, `${String(12 + referenceHours).padStart(2, "0")}:00`),
        68
      ),
      ...hr,
    ],
  });
}

function pushTwo(hr: Rec[] = hrRun(at(day1, "05:58"), at(day1, "12:15"), 58)) {
  const w = real();
  return push({
    timestamp: at(day1, "14:42") /* a day after push 1 */,
    sleep: [session(w.start, w.end, 4)],
    heart_rate: hr,
  });
}

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("SLEEP OVERLAP")
      .lastInsertRowid
  );
  day0 = shiftDateStr(today(profileId), -6);
  day1 = shiftDateStr(today(profileId), -5);
});

describe("a re-timed Health Connect night collapses to the corroborated window", () => {
  it("keeps the real session with its stages only, tombstones every loser key, and refuses the re-send", () => {
    pushOne();
    expect(sessionsInStore()).toHaveLength(1);

    const second = pushTwo();
    // Review's split says a stored night was deleted — the session plus its four stages.
    expect(second.split.superseded).toBe(5);
    expect(sessionsInStore()).toEqual([
      { date: day1, started_at: real().start },
    ]);
    // The phantom's wake day keeps no breakdown behind it, and the readers the Sleep
    // page renders from see ONE night, on the right wake day, of the right duration.
    expect(stageDates()).toEqual([day1]);
    expect(
      getSleepStageComposition(profileId, 30).filter(
        (r) => r.deep + r.rem + r.light + r.awake > 0
      )
    ).toHaveLength(1);
    expect(getMainSleepNightlyMinutes(profileId, 30)).toEqual([
      { date: day1, value: 377 },
    ]);

    // A tombstone for the session key AND for every stage key it took with it.
    const dead = tombstones();
    expect(
      dead.has(
        metricSampleTombstoneKey("sleep_min", HC, ORIGIN, phantom().start)
      )
    ).toBe(true);
    expect(dead.size).toBe(5);

    // THE THIRD PUSH: the exporter re-sends the old record inside its 48 h window. The
    // tombstone has to hold, or the night this rule deleted comes straight back.
    const third = push({
      timestamp: at(day1, "16:00"),
      sleep: [session(phantom().start, phantom().end, 4)],
    });
    expect(third.split.inserted).toBe(0);
    expect(sessionsInStore()).toEqual([
      { date: day1, started_at: real().start },
    ]);
  });

  it("re-collapses a re-send the tombstone cannot recognise", () => {
    // THE TOMBSTONE IS STRING-KEYED, and the exporter states a session in more than one
    // spelling. Re-stated as `end_time` + `duration_seconds` with no `start_time`, the
    // parser DERIVES the same instant in a different spelling ("…:00.000Z"), which is a
    // different natural key, so the tombstone misses and the phantom is inserted again.
    // Nothing about the heart rate changed, so the rule takes it again — which is what
    // makes a missed tombstone a delay rather than the permanent wrong night an
    // arrival-ranked rule turned it into.
    pushOne();
    pushTwo();
    const w = phantom();
    const respelled = push({
      timestamp: at(day1, "16:00"),
      sleep: [
        {
          end_time: w.end,
          duration_seconds: (msOf(w.end) - msOf(w.start)) / 1000,
          metadata: { data_origin: ORIGIN },
        },
      ],
    });
    expect(respelled.split.inserted).toBe(1);
    expect(respelled.split.superseded).toBe(1);
    expect(sessionsInStore()).toEqual([
      { date: day1, started_at: real().start },
    ]);
  });

  it("keeps the same night when the two pushes arrive in the other order", () => {
    // THE REFUTATION THAT CUT THE LAST IMPLEMENTATION. A backfill delivers the corrected
    // session first and the mis-zoned one second; an arrival-order rule deletes the real
    // night here. The heart rate does not care which arrived first.
    pushTwo();
    const second = pushOne();
    expect(second.split.superseded).toBe(5);
    expect(sessionsInStore()).toEqual([
      { date: day1, started_at: real().start },
    ]);
  });
});

describe("the refusals — nothing is deleted and the pair is surfaced", () => {
  // Same two pushes every time, with only the heart rate changed. Each case asserts the
  // SAME three things — both nights stored, nothing tombstoned, and Data → Review naming
  // the pair — because the point of a refusal is that the store is untouched.
  //
  // EACH CASE WAS CHECKED, by instrumenting the verdict once, to reach the branch its
  // name claims rather than tripping an earlier refusal: `unobserved` (no minutes at all),
  // `both`, `unobserved` again by two further routes (a window the push has not delivered,
  // and a hole wider than the declared dip tolerance), and `neither`.
  const cases: {
    name: string;
    one: () => Rec[];
    two: () => Rec[];
  }[] = [
    {
      // Nothing on the wrist. Neither window says anything, so neither may delete the other.
      name: "no heart rate was worn inside either window",
      one: () => [],
      two: () => [],
    },
    {
      // The mis-zoned window landing on the PREVIOUS night: both windows read below the
      // awake reference, and nothing here says which one is this night.
      name: "the heart rate inside the phantom window reads as sleep too",
      one: () => hrRun(at(day0, "23:58"), at(day1, "06:15"), 57),
      two: () => hrRun(at(day1, "05:58"), at(day1, "12:15"), 58),
    },
    {
      // The watch batches into the phone independently of the exporter's push, so the
      // corrected night can arrive with none of its own minutes yet. An unread window is
      // not "not sleep" — it may not be deleted by the one beside it.
      name: "the corrected night's heart rate has not arrived yet",
      one: () => hrRun(at(day0, "23:58"), at(day1, "05:58"), 78),
      two: () => [],
    },
    {
      // Three of six hours arrive, leaving a hole longer than the declared 150-minute dip
      // tolerance. A mean over the half that landed is a claim about a fragment.
      name: "the corrected night is only half covered",
      one: () => hrRun(at(day0, "23:58"), at(day1, "05:58"), 78),
      two: () => hrRun(at(day1, "09:15"), at(day1, "12:15"), 58),
    },
    {
      // Both windows read, and both above the person's own awake mean. Something is wrong
      // with one of them and the heart rate does not say which.
      name: "neither window reads as sleep",
      one: () => hrRun(at(day0, "23:58"), at(day1, "06:15"), 90),
      two: () => hrRun(at(day1, "05:58"), at(day1, "12:15"), 88),
    },
  ];

  it.each(cases)("when $name", ({ one, two }) => {
    pushOne(one());
    pushTwo(two());
    bothStand();
  });

  it("when the awake reference rests on less observation than the windows it judges", () => {
    // An hour of daytime heart rate does not get to settle two six-hour windows.
    pushOne(hrRun(at(day0, "23:58"), at(day1, "06:15"), 78), 1);
    pushTwo();
    bothStand();
  });

  // THE #133 LOCK, ON THE TOTAL AND ON THE BREAKDOWN. A hand-corrected row is the
  // person's, and the breakdown is where the earlier attempt let go of it: the session
  // check and the stage sweep are two different reads and only the first had a lock.
  it.each([["sleep_min"], ["sleep_deep_min"]])(
    "when the losing night's %s row is hand-corrected (#133)",
    (metric) => {
      pushOne();
      db.prepare(
        `UPDATE metric_samples SET edited = 1
          WHERE profile_id = ? AND metric = ? AND date = ?`
      ).run(profileId, metric, day0);
      pushTwo();
      bothStand();
      expect(stageDates()).toEqual([day0, day1]);
    }
  );
});

describe("what the rule may never touch", () => {
  it("leaves a nap, a fragmented night (#1191) and other sources alone", () => {
    // A night and an afternoon nap on one wake day, non-overlapping; the #1191 fragment
    // pair, separated by an awake gap; and an Oura session sitting right on top of the
    // Health Connect one. None of them is a same-origin overlap.
    push({
      timestamp: at(day1, "20:00"),
      sleep: [
        session(at(day0, "23:00"), at(day1, "05:00"), 2), // the night
        session(at(day1, "22:00"), at(day1, "23:00"), 1), // a nap, same wake day
        session(at(day1, "06:00"), at(day1, "07:30"), 1), // #1191: a second fragment
      ],
      heart_rate: [
        ...hrRun(at(day0, "12:00"), at(day0, "20:00"), 68),
        ...hrRun(at(day0, "23:00"), at(day1, "05:00"), 55),
        ...hrRun(at(day1, "06:00"), at(day1, "07:30"), 55),
      ],
    });
    // An Oura night overlapping the Health Connect one — a different source, so it is a
    // second reading of the night and never a re-write of it.
    upsertMetricSamples(
      profileId,
      [
        {
          metric: "sleep_min",
          date: day1,
          started_at: at(day0, "23:10"),
          ended_at: at(day1, "05:05"),
          value: 355,
          origin: null,
        },
      ],
      "oura",
      [],
      {}
    );
    const before = sessionsInStore();
    // A later push re-sending the same three sessions must still change nothing.
    push({
      timestamp: at(day1, "21:00"),
      sleep: [
        session(at(day0, "23:00"), at(day1, "05:00"), 2),
        session(at(day1, "22:00"), at(day1, "23:00"), 1),
        session(at(day1, "06:00"), at(day1, "07:30"), 1),
      ],
    });
    expect(sessionsInStore()).toEqual(before);
    expect(tombstones().size).toBe(0);
    expect(getOverlappingSleepSessions(profileId)).toEqual([]);
  });
});

// ── the twin shifted further than it is long (#5020) ──────────────────────────
//
// The prod shape: Fitbit re-sent one 298-minute night stamped six hours late, and
// because the shift is longer than the night the two rows never touch. `windowsOverlap`
// is blind to that by construction, so before this the pair was not a pair — the ingest
// rule never looked at it, and Data → Review never listed it.
//
// Nothing about the DECISION changes here. These cases are about which rows reach it,
// and the second one is the point: reaching the decision is not the same as the decision
// being able to answer.
describe("a re-timed night whose shift is longer than the night", () => {
  // 03:39 → 08:37, and the same 298 minutes stamped +6h.
  const early = () => ({ start: at(day1, "03:39"), end: at(day1, "08:37") });
  const late = () => ({ start: at(day1, "09:39"), end: at(day1, "14:37") });

  /** Awake at 76 across the day, with the body's trough where it is given. */
  const dayWithTrough = (from: string, to: string) => [
    ...hrRun(at(day1, "00:00"), from, 76),
    ...hrRun(from, to, 55),
    ...hrRun(to, at(day1, "18:00"), 76),
  ];

  function pushTwin(second: { start: string; end: string }, hr: Rec[]) {
    push({
      timestamp: at(day1, "19:00"),
      sleep: [session(early().start, early().end, 4)],
      heart_rate: hr,
    });
    return push({
      timestamp: at(day1, "20:00"),
      sleep: [session(second.start, second.end, 4)],
    });
  }

  it("collapses to the window the heart rate corroborates", () => {
    // The trough ends where the late copy begins, so that copy is awake end to end and
    // exactly one window reads as sleep — the condition the rule has always required.
    pushTwin(late(), dayWithTrough(at(day1, "04:00"), at(day1, "09:39")));
    const stored = sessionsInStore();
    expect(stored).toHaveLength(1);
    expect(stored[0].started_at).toBe(early().start);
    // The loser's key is tombstoned, so a re-send cannot resurrect it.
    expect(
      tombstones().has(
        metricSampleTombstoneKey("sleep_min", HC, ORIGIN, late().start)
      )
    ).toBe(true);
    // Its stages went with it: one wake day of stage rows, the winner's.
    expect(stageDates()).toHaveLength(1);
    expect(getOverlappingSleepSessions(profileId)).toEqual([]);
  });

  it("lists the prod pair rather than deciding it, because both windows read as sleep", () => {
    // THE 08-30 SIGHTING, unretouched: trough 04:00 → 11:00 against a late copy starting
    // at 09:39. The late copy carries 81 minutes of the real trough, which drags its mean
    // under the person's own awake reference, so BOTH windows corroborate and the rule
    // refuses — correctly, by its own standard. Widening the pairing makes this pair
    // VISIBLE; it does not make it decidable, and it was worth measuring rather than
    // assuming: `mainSleepPeriod` still merges these two edges 62 minutes apart into one
    // 596-minute night, which is #5020's third mechanism and is not fixed here.
    pushTwin(late(), dayWithTrough(at(day1, "04:00"), at(day1, "11:00")));
    expect(sessionsInStore()).toHaveLength(2);
    expect(tombstones().size).toBe(0);
    const pairs = getOverlappingSleepSessions(profileId);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].origin).toBe(ORIGIN);
    expect(pairs[0].sessions.map((s) => s.started_at).sort()).toEqual(
      [early().start, late().start].sort()
    );
  });

  it("is not a pair when the shift is off the zone grid", () => {
    // 6 h 07 m. A clock error lands on a quarter-hour because every zone offset does;
    // a translation that does not is two different spans that happen to be equally long.
    pushTwin(
      { start: at(day1, "09:46"), end: at(day1, "14:44") },
      dayWithTrough(at(day1, "04:00"), at(day1, "09:39"))
    );
    expect(sessionsInStore()).toHaveLength(2);
    expect(tombstones().size).toBe(0);
    expect(getOverlappingSleepSessions(profileId)).toEqual([]);
  });

  it("is not a pair when the two windows are different lengths", () => {
    // The same six-hour shift, but a minute shorter. A re-write carries the session's
    // own duration; two spans of different length are not one span twice, which is what
    // keeps #1191's uneven fragments out of this arm.
    pushTwin(
      { start: at(day1, "09:39"), end: at(day1, "14:36") },
      dayWithTrough(at(day1, "04:00"), at(day1, "09:39"))
    );
    expect(sessionsInStore()).toHaveLength(2);
    expect(tombstones().size).toBe(0);
    expect(getOverlappingSleepSessions(profileId)).toEqual([]);
  });
});

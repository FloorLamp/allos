import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { setProfileSetting } from "@/lib/settings/kv";
import { serializeTimezoneSwitches } from "@/lib/travel-timezone";
import { shiftDateStr, utcInstant } from "@/lib/date";
import {
  getSuspectSleepSessions,
  getSuspectSleepWakeDays,
  SLEEP_SKEW_HISTORY_DAYS,
} from "@/lib/queries/sleep-clock-skew";
import { sleepClockSkewSignalKey } from "@/lib/sleep-clock-skew";
import { buildSleepClockSkewFindings } from "@/lib/rule-findings";
import { FINDING_DASHBOARD_RELEVANCE } from "@/lib/findings";
import { tierForDedupeKey } from "@/lib/rule-finding-prefixes";
import { deleteMetricRow } from "@/lib/metric-readings";
import {
  getSleepDurationTrend,
  getSleepMoodData,
  getSleepRegularity,
} from "@/lib/queries/sleep";
import {
  HEALTH_CONNECT_ID,
  parseHealthConnectPayload,
} from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";

// DB INTEGRATION TIER — the gather half of the sleep clock-skew detector (#4299).
//
// The pure discriminator has its own table in lib/__tests__/sleep-clock-skew.test.ts.
// What is pinned HERE is everything the database contributes: which rows are even
// candidates, that the HR read is raw UTC on both sides of the comparison, and that the
// timezone-switch proximity is wording carried out of a finding that already exists
// rather than an input that can produce one.

const PROVIDER = "health-connect";
const ASLEEP = 58;
const AWAKE = 74;
const MIN_MS = 60_000;

let profileId: number;
let T: string;

// One sleep session as a source stamped it. Instants are given as UTC because that is
// what the column holds and what the comparison reads.
function session(
  wakeDay: string,
  startUtc: string,
  endUtc: string,
  source = PROVIDER,
  // Provider-reported minutes asleep. The default is the sighting's own 298; a fixture
  // that puts two sessions on one wake day has to say which is the longer, because that
  // is what the shared main-sleep classifier reads.
  value = 298
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, started_at, ended_at, value)
         VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, ?)`
      )
      .run(profileId, source, wakeDay, startUtc, endUtc, value).lastInsertRowid
  );
}

// A per-minute HR trace over [from, to), at trough level inside `trough`.
function trace(
  from: string,
  to: string,
  trough: { from: string; to: string } | null
): void {
  const stmt = db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, source, bpm, bpm_min, bpm_max, n)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );
  const lo = trough ? Date.parse(trough.from) : 0;
  const hi = trough ? Date.parse(trough.to) : 0;
  for (let at = Date.parse(from); at < Date.parse(to); at += MIN_MS) {
    const bpm = trough && at >= lo && at < hi ? ASLEEP : AWAKE;
    stmt.run(profileId, utcInstant(new Date(at)), PROVIDER, bpm, bpm, bpm);
  }
}

// The sighting: a session stamped +6h, with the body's real trough six hours earlier.
// `day` is the wake-day; the claim runs 09:39→14:37 on it and the truth 03:39→08:37.
function skewedNight(day: string): number {
  const id = session(day, `${day}T09:39:00Z`, `${day}T14:37:00Z`);
  trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${day}T22:00:00Z`, {
    from: `${day}T03:39:00Z`,
    to: `${day}T08:37:00Z`,
  });
  return id;
}

// The 08-27 night in #5020: stamped THREE hours late, so the shift is shorter than the
// night is long. The real trough overlaps the claim, which is exactly what hides this
// night from the median reading — every comparable window that does not overlap the
// claim is awake time. Only the run inside the claim's own hours can speak.
function partialShiftNight(day: string): number {
  const id = session(
    day,
    `${day}T09:53:00Z`,
    `${day}T16:31:00Z`,
    PROVIDER,
    398
  );
  trace(`${shiftDateStr(day, -1)}T18:00:00Z`, `${day}T22:00:00Z`, {
    from: `${day}T07:00:00Z`,
    to: `${day}T13:30:00Z`,
  });
  return id;
}

// The same clocks, the same duration, the same schedule break — and the HR agrees.
function jetLagNight(day: string): number {
  const id = session(day, `${day}T09:39:00Z`, `${day}T14:37:00Z`);
  trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${day}T22:00:00Z`, {
    from: `${day}T09:39:00Z`,
    to: `${day}T14:37:00Z`,
  });
  return id;
}

// The travel log the profile already keeps (lib/settings/travel.ts). Written through
// the setting the switch path writes, because there is no test-only door to it — and
// the point of these two cases is that this history is real and still cannot fire.
function recordReturnEast(day: string): void {
  setProfileSetting(
    profileId,
    "timezone_switches",
    serializeTimezoneSwitches([
      {
        at: `${day}T12:00:00Z`,
        from: "Pacific/Honolulu",
        to: "America/New_York",
      },
    ])
  );
}

beforeEach(() => {
  db.exec("DELETE FROM metric_samples");
  db.exec("DELETE FROM hr_minutes");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('SKEW')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  T = today(profileId);
});

describe("getSuspectSleepSessions", () => {
  it("finds the skewed night and carries the evidence the copy quotes", () => {
    const day = shiftDateStr(T, -1);
    const id = skewedNight(day);
    const found = getSuspectSleepSessions(profileId, shiftDateStr(T, -30));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      sampleId: id,
      wakeDay: day,
      source: PROVIDER,
      nearTimezoneSwitch: false,
    });
    expect(found[0].evidence).toMatchObject({
      claimedBpm: AWAKE,
      troughBpm: ASLEEP,
      start: `${day}T09:39:00Z`,
    });
    expect(getSuspectSleepWakeDays(profileId, shiftDateStr(T, -30))).toEqual(
      new Set([day])
    );
  });

  it("finds a shift shorter than the session, which the median reading misses", () => {
    const day = shiftDateStr(T, -1);
    const id = partialShiftNight(day);
    const found = getSuspectSleepSessions(profileId, shiftDateStr(T, -30));
    expect(found).toHaveLength(1);
    expect(found[0].sampleId).toBe(id);
    // The gather hands the pure reading the SAME raw UTC minutes on both sides, and
    // the evidence that comes back is the run — the claim's own median sits at trough
    // level, below every comparable window in the day.
    expect(found[0].evidence.claimedBpm).toBe(ASLEEP);
    expect(found[0].evidence.awakeRun).toMatchObject({ bpm: AWAKE });
    expect(getSuspectSleepWakeDays(profileId, shiftDateStr(T, -30))).toEqual(
      new Set([day])
    );
  });

  // Every row here must come back empty. The first is the one that decides whether
  // this is a detector or a jet-lag false-alarm generator.
  it.each([
    ["a true jet-lag night whose HR agrees with its clocks", jetLagNight],
    [
      "a synced night with no HR trace at all",
      (day: string) => session(day, `${day}T09:39:00Z`, `${day}T14:37:00Z`),
    ],
    [
      // A hand-logged night, carrying the SAME window and the SAME contradicting
      // trace as the flagged one. It is excluded because it is the person's own
      // statement, not a source's clock — so this fixture has to be one that would
      // otherwise flag, or it proves nothing about the filter. (A duration-only
      // manual row stores `${date}T00:00:00` for both ends and is silent for a
      // second, weaker reason: a zero-width window is not a window.)
      "a manual night with clocks, even with a contradicting trace",
      (day: string) => {
        const id = session(
          day,
          `${day}T09:39:00Z`,
          `${day}T14:37:00Z`,
          "manual"
        );
        trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${day}T22:00:00Z`, {
          from: `${day}T03:39:00Z`,
          to: `${day}T08:37:00Z`,
        });
        return id;
      },
    ],
    [
      "a duration-only night, whose stored ends are one profile-local midnight",
      (day: string) => {
        const id = session(day, `${day}T00:00:00`, `${day}T00:00:00`, "manual");
        trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${day}T22:00:00Z`, {
          from: `${day}T03:39:00Z`,
          to: `${day}T08:37:00Z`,
        });
        return id;
      },
    ],
  ])("stays silent on %s", (_case, seed) => {
    seed(shiftDateStr(T, -1));
    expect(getSuspectSleepSessions(profileId, shiftDateStr(T, -30))).toEqual(
      []
    );
  });

  it("never reads another profile's sessions or another profile's heart rate", () => {
    const day = shiftDateStr(T, -1);
    const mine = profileId;
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SKEW-OTHER')").run()
        .lastInsertRowid
    );
    // The other profile owns the whole contradiction: session AND trace.
    profileId = other;
    setTimezone(other, "UTC");
    skewedNight(day);
    profileId = mine;
    expect(getSuspectSleepSessions(mine, shiftDateStr(T, -30))).toEqual([]);
    // And a session of MINE cannot borrow the other profile's trace to flag.
    session(day, `${day}T09:39:00Z`, `${day}T14:37:00Z`);
    expect(getSuspectSleepSessions(mine, shiftDateStr(T, -30))).toEqual([]);
  });

  it("bounds the read by `since`", () => {
    const old = shiftDateStr(T, -(SLEEP_SKEW_HISTORY_DAYS + 5));
    skewedNight(old);
    expect(
      getSuspectSleepSessions(
        profileId,
        shiftDateStr(T, -SLEEP_SKEW_HISTORY_DAYS)
      )
    ).toEqual([]);
    expect(getSuspectSleepSessions(profileId, old)).toHaveLength(1);
  });
});

describe("timezone-switch proximity is WORDING and never a trigger (#4299)", () => {
  it("marks a nearby switch on a session the HR already contradicted", () => {
    const day = shiftDateStr(T, -1);
    skewedNight(day);
    recordReturnEast(day);
    expect(
      getSuspectSleepSessions(profileId, shiftDateStr(T, -30))[0]
    ).toMatchObject({ nearTimezoneSwitch: true });
  });

  it("cannot make a jet-lag night suspect, which is the whole discriminator", () => {
    // The owner's Hawaii week: a REAL return east, recorded, with the night's HR
    // agreeing with its clocks. A detector that let the switch speak would flag here.
    const day = shiftDateStr(T, -1);
    jetLagNight(day);
    recordReturnEast(day);
    expect(getSuspectSleepSessions(profileId, shiftDateStr(T, -30))).toEqual(
      []
    );
  });
});

// ---- The coaching-tier finding (#4299) --------------------------------------

describe("buildSleepClockSkewFindings", () => {
  it("states ONE episode's evidence, anchored to its oldest suspect night", () => {
    const older = shiftDateStr(T, -2);
    skewedNight(older);
    skewedNight(shiftDateStr(T, -1));
    const findings = buildSleepClockSkewFindings(profileId, T);

    expect(findings).toHaveLength(1);
    // Anchored to the OLDEST night of the run, so tomorrow's mis-stamped night joins
    // this episode instead of minting a fresh row past a dismissal.
    expect(findings[0].dedupeKey).toBe(sleepClockSkewSignalKey(older));
    expect(tierForDedupeKey(findings[0].dedupeKey)).toBe("coaching");
    expect(findings[0].title).toContain("2 recorded nights'");
    // It quotes the two measurements and NOTHING that reads as an inferred offset.
    expect(findings[0].detail).toContain(`${AWAKE} bpm`);
    expect(findings[0].detail).toContain(`${ASLEEP} bpm`);
    expect(findings[0].detail).not.toMatch(/\bhours?\b/);
    expect(findings[0].dashboardRelevance).toBe(
      FINDING_DASHBOARD_RELEVANCE.review
    );
    expect(findings[0].detail).not.toContain("timezone");
  });

  it("says what a run finding measured, not what the median finding did", () => {
    // A partial shift has NO equally long window elsewhere holding the overnight low —
    // that absence is why the median reading missed it — so the copy must not claim
    // one. It quotes the run and the window instead, and it names no duration, for the
    // same reason it names no offset: nothing here measures how far off the clock is.
    const day = shiftDateStr(T, -1);
    partialShiftNight(day);
    const detail = buildSleepClockSkewFindings(profileId, T)[0].detail;
    expect(detail).toContain(`${AWAKE} bpm`);
    expect(detail).toContain(`${ASLEEP} bpm`);
    expect(detail).not.toContain("the overnight low");
    expect(detail).not.toMatch(/\bhours?\b/);
  });

  it("adds the travel sentence when a switch is recorded — wording, not a trigger", () => {
    const day = shiftDateStr(T, -1);
    skewedNight(day);
    recordReturnEast(day);
    expect(buildSleepClockSkewFindings(profileId, T)[0].detail).toContain(
      "timezone change"
    );
  });

  // The false-alarm side of the same builder. The second row is the discriminator:
  // a REAL return east, recorded, on a night whose heart rate agrees with its clocks.
  it.each([
    ["a true jet-lag night", jetLagNight, false],
    ["a true jet-lag night beside a recorded return east", jetLagNight, true],
  ])("says nothing on %s", (_case, seed, withSwitch) => {
    const day = shiftDateStr(T, -1);
    seed(day);
    if (withSwitch) recordReturnEast(day);
    expect(buildSleepClockSkewFindings(profileId, T)).toEqual([]);
  });
});

// ---- The repair (#4299 / #507 / #508 / #2032) --------------------------------
//
// Driven through the REAL Health Connect parse + ingest, because the claim being made
// is about what a re-SYNC does: a fixture that hand-inserted the second copy would be
// exercising a store the sync path never produced, and the tombstone consult lives in
// that path.

const HC = HEALTH_CONNECT_ID;
const ORIGIN = "com.fitbit.FitbitMobile";

function hcPush(body: Record<string, unknown>) {
  return ingestHealthConnectPayload(
    profileId,
    parseHealthConnectPayload(body, "UTC"),
    HC
  );
}

/** One night as the exporter sends it, with an optional per-minute heart-rate trace. */
function pushNight(
  start: string,
  end: string,
  trough: { from: string; to: string } | null = null,
  hrFrom?: string,
  hrTo?: string
) {
  const heart: { time: string; bpm: number }[] = [];
  if (hrFrom && hrTo) {
    const lo = trough ? Date.parse(trough.from) : 0;
    const hi = trough ? Date.parse(trough.to) : 0;
    for (let at = Date.parse(hrFrom); at < Date.parse(hrTo); at += MIN_MS) {
      heart.push({
        time: utcInstant(new Date(at)),
        bpm: trough && at >= lo && at < hi ? ASLEEP : AWAKE,
      });
    }
  }
  return hcPush({
    timestamp: end,
    sleep: [
      {
        start_time: start,
        end_time: end,
        duration_seconds: (Date.parse(end) - Date.parse(start)) / 1000,
        metadata: { data_origin: ORIGIN },
      },
    ],
    ...(heart.length > 0 ? { heart_rate: heart } : {}),
  });
}

function storedSessions(): { date: string; started_at: string }[] {
  return db
    .prepare(
      `SELECT date, started_at FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' ORDER BY started_at`
    )
    .all(profileId) as { date: string; started_at: string }[];
}

function sleepTarget(id: number) {
  return { store: "metric_samples", id, metric: "sleep_min" } as const;
}

describe("deleting a suspect synced session (#4299)", () => {
  it("buries the mis-stamped instants and lets the corrected night back in", () => {
    const day = shiftDateStr(T, -1);
    const claimed = { start: `${day}T09:39:00Z`, end: `${day}T14:37:00Z` };
    // What the Fitbit app itself showed for the same night — 11:39 PM → 4:37 AM
    // Eastern, which is exactly the window the body's own trough sits in. It has to
    // BE the trough: a "corrected" re-sync that still disagreed with the heart rate
    // would land and immediately flag again, and the test would be asserting the
    // tombstone while proving nothing about the correction.
    const corrected = {
      start: `${day}T03:39:00Z`,
      end: `${day}T08:37:00Z`,
    };
    pushNight(
      claimed.start,
      claimed.end,
      { from: `${day}T03:39:00Z`, to: `${day}T08:37:00Z` },
      `${shiftDateStr(day, -1)}T22:00:00Z`,
      `${day}T22:00:00Z`
    );

    const suspect = getSuspectSleepSessions(profileId, shiftDateStr(T, -30));
    expect(suspect).toHaveLength(1);
    const id = suspect[0].sampleId;

    // The Sleep log offers the delete on exactly this row, and STILL refuses the edit:
    // the mark buys a way out of a mis-stamped session, never edit rights on synced
    // sleep.
    const row = getSleepMoodData(profileId).history.find((r) => r.date === day);
    expect(row).toMatchObject({
      sleepSuspect: true,
      sleepSampleId: id,
      sleepEditable: false,
    });

    expect(deleteMetricRow(profileId, sleepTarget(id)).ok).toBe(true);
    expect(storedSessions()).toEqual([]);

    // The same instants back are refused — the tombstone doing its #507/#508 job.
    pushNight(claimed.start, claimed.end);
    expect(storedSessions()).toEqual([]);

    // And the CORRECTED re-sync of THE SAME NIGHT lands, because the tombstone is
    // keyed on (metric, source, origin, started_at) — the stamps, not the night. A
    // tombstone keyed on the wake-day would swallow this and look identical above.
    pushNight(corrected.start, corrected.end);
    expect(storedSessions()).toEqual([
      { date: day, started_at: corrected.start },
    ]);
    expect(getSuspectSleepSessions(profileId, shiftDateStr(T, -30))).toEqual(
      []
    );
  });

  it("leaves a window containing the deleted night exactly as an unrecorded one", () => {
    // Enough ordinary nights for the SRI's 14-night gate to answer at all — a
    // comparison between two nulls would pass while proving nothing.
    for (let i = 2; i <= 20; i++) {
      const d = shiftDateStr(T, -i);
      session(d, `${shiftDateStr(d, -1)}T23:00:00Z`, `${d}T07:00:00Z`);
    }
    const before = {
      trend: getSleepDurationTrend(profileId),
      sri: getSleepRegularity(profileId),
    };
    expect(before.sri).not.toBeNull();

    const day = shiftDateStr(T, -1);
    const id = skewedNight(day);
    expect(getSuspectSleepWakeDays(profileId, shiftDateStr(T, -30))).toEqual(
      new Set([day])
    );
    expect(deleteMetricRow(profileId, sleepTarget(id)).ok).toBe(true);

    // No third state: the window degrades exactly the way it did before the night
    // was ever recorded — same series, same SRI, no invented null.
    expect({
      trend: getSleepDurationTrend(profileId),
      sri: getSleepRegularity(profileId),
    }).toEqual(before);
  });
});

// ── the day's NIGHT is judged, and nothing else on it (#5019) ─────────────────
//
// The detector's comparison is the best equal-width window in the surrounding ±12 h,
// which for a daytime nap is always the overnight trough. A person napping runs above
// their own overnight trough by definition, so before this every nap of any length read
// as a contradiction — and the hedge, keyed by wake day, then landed on the night while
// the delete door beneath it pointed at the nap.
describe("naps are not judged against the night's own trough", () => {
  // The 08-31 sighting: a fine night 03:06→08:32 and a 68-minute nap at 17:41. The
  // trough IS the night, so the night agrees with its clocks and the nap cannot.
  function nightAndNap(day: string): { night: number; nap: number } {
    const night = session(
      day,
      `${day}T03:06:00Z`,
      `${day}T08:32:00Z`,
      PROVIDER,
      326
    );
    const nap = session(
      day,
      `${day}T17:41:00Z`,
      `${day}T18:49:00Z`,
      PROVIDER,
      68
    );
    trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${day}T22:00:00Z`, {
      from: `${day}T03:06:00Z`,
      to: `${day}T08:32:00Z`,
    });
    return { night, nap };
  }

  it("hedges nothing on a day whose night agrees with its clocks", () => {
    const day = shiftDateStr(T, -1);
    nightAndNap(day);
    expect(getSuspectSleepSessions(profileId, shiftDateStr(T, -30))).toEqual(
      []
    );
    expect(getSuspectSleepWakeDays(profileId, shiftDateStr(T, -30))).toEqual(
      new Set()
    );
  });

  it("names the night's own row when the night is the contradicted one", () => {
    // The same day, with the night mis-stamped instead: the nap is still there and is
    // still above the trough, so exactly one row may be reported and it must be the
    // night's — that id is what the Sleep log's delete door deletes.
    const day = shiftDateStr(T, -1);
    const night = session(
      day,
      `${day}T09:39:00Z`,
      `${day}T14:37:00Z`,
      PROVIDER,
      298
    );
    session(day, `${day}T17:41:00Z`, `${day}T18:49:00Z`, PROVIDER, 68);
    trace(`${shiftDateStr(day, -1)}T22:00:00Z`, `${day}T22:00:00Z`, {
      from: `${day}T03:39:00Z`,
      to: `${day}T08:37:00Z`,
    });
    const found = getSuspectSleepSessions(profileId, shiftDateStr(T, -30));
    expect(found).toHaveLength(1);
    expect(found[0].sampleId).toBe(night);
    expect(found[0].wakeDay).toBe(day);
  });

  it("leaves the Sleep log row unhedged, with no delete door pointed at the nap", () => {
    // What the first case is FOR. On the 08-31 shape the night was fine and only the nap
    // flagged, so the hedge — keyed by wake day — landed on the night's row while
    // `sleepSampleId` beneath it named the NAP: "these times disagree with your heart
    // rate" over a night that agreed, above a delete that removed a different session.
    const day = shiftDateStr(T, -1);
    const { nap } = nightAndNap(day);
    const row = getSleepMoodData(profileId, 30).history.find(
      (r) => r.date === day
    );
    expect(row).toBeDefined();
    expect(row!.sleepSuspect).toBe(false);
    expect(row!.sleepSampleId).not.toBe(nap);
  });
});

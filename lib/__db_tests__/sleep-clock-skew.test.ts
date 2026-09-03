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
  source = PROVIDER
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, started_at, ended_at, value)
         VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, 298)`
      )
      .run(profileId, source, wakeDay, startUtc, endUtc).lastInsertRowid
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
      getSuspectSleepSessions(profileId, shiftDateStr(T, -SLEEP_SKEW_HISTORY_DAYS))
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

// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #1118 — main overnight sleep vs naps at read time. A Health Connect
// profile ingests EVERY sleep session unlabeled, and the daily `sleep_min` total
// SUMS them (sleep_min is additive), so an overnight + a same-day nap read as one
// inflated night — masking overnight deprivation in the poor-sleep rest trigger.
// getSleepSignal now reads the MAIN overnight session per night (mainSleepSession)
// instead of that raw sum. SRI (#160) deliberately still sees every session, naps
// included. This suite pins the end-to-end pick over a realistic fixture.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed
// at a throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import {
  getSleepSignal,
  getSleepSessions,
  getDailySleepSessionsSince,
  getMainSleepNightlyMinutes,
  getLastNightSummary,
  getSleepStageComposition,
  getNapHistory,
  getSleepSummaryInRange,
  getMetricDailyTotals,
  getSleepMoodData,
  getSleepRegularity,
  gatherCoachingInput,
} from "@/lib/queries";
import { recommendCoaching, DEFAULT_COACHING_THRESHOLDS } from "@/lib/coaching";
import { measureRoughNight } from "@/lib/derived-situations";
import { setMetricSourcePriorityEntry, setTimezone } from "@/lib/settings";

let profileId: number;
// getSleepSignal answers only for a night actually just woken from (isLastNight),
// and this tier does not freeze the clock — so a wake-day-sensitive fixture is
// anchored on today() rather than a frozen literal. Night 2 IS last night.
let night1Day: string;
let night2Day: string;

// A sleep session as UTC ("Z") instants, so with the profile timezone pinned to
// UTC the wall clock equals the stored instant (hand-checkable wake-days).
const session = (
  metric: string,
  date: string,
  value: number,
  start: string,
  end: string
): NormMetricSample => ({
  metric,
  date,
  start_time: start,
  end_time: end,
  value,
});

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Sleep1118')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  night2Day = today(profileId);
  night1Day = shiftDateStr(night2Day, -1);

  // Night 1 (wake night1Day): a plain 7h overnight, no nap.
  upsertMetricSamples(
    profileId,
    [
      session(
        "sleep_min",
        night1Day,
        420,
        `${shiftDateStr(night1Day, -1)}T23:00:00Z`,
        `${night1Day}T06:00:00Z`
      ),
    ],
    "health-connect"
  );
  // Night 2 (wake night2Day — LAST night): a deficient 5h overnight PLUS a 90-min
  // afternoon nap the same wake-day. Raw sleep_min SUMS to 390; the main overnight
  // session is 300.
  upsertMetricSamples(
    profileId,
    [
      session(
        "sleep_min",
        night2Day,
        300,
        `${night1Day}T23:30:00Z`,
        `${night2Day}T04:30:00Z`
      ),
      session(
        "sleep_min",
        night2Day,
        90,
        `${night2Day}T14:00:00Z`,
        `${night2Day}T15:30:00Z`
      ),
      // Main-session stages sum to the 300-minute overnight figure.
      session(
        "sleep_deep_min",
        night2Day,
        50,
        `${night1Day}T23:30:00Z`,
        `${night2Day}T04:30:00Z`
      ),
      session(
        "sleep_rem_min",
        night2Day,
        70,
        `${night1Day}T23:30:00Z`,
        `${night2Day}T04:30:00Z`
      ),
      session(
        "sleep_light_min",
        night2Day,
        160,
        `${night1Day}T23:30:00Z`,
        `${night2Day}T04:30:00Z`
      ),
      session(
        "sleep_awake_min",
        night2Day,
        20,
        `${night1Day}T23:30:00Z`,
        `${night2Day}T04:30:00Z`
      ),
      // The same wake-day nap carries another 90 minutes of stages. These must
      // stay out of the overnight chart and hero.
      session(
        "sleep_light_min",
        night2Day,
        70,
        `${night2Day}T14:00:00Z`,
        `${night2Day}T15:30:00Z`
      ),
      session(
        "sleep_awake_min",
        night2Day,
        20,
        `${night2Day}T14:00:00Z`,
        `${night2Day}T15:30:00Z`
      ),
    ],
    "health-connect"
  );
});

describe("getSleepSignal — main overnight session, not the nap-summed total (#1118)", () => {
  it("the raw daily sleep_min total DOES sum the nap into the night (the bug)", () => {
    // Establishes the hazard getSleepSignal must avoid: the additive daily total
    // for the latest wake-day is overnight(300) + nap(90) = 390.
    const totals = getMetricDailyTotals(profileId, "sleep_min").filter(
      (r) => r.date === night2Day
    );
    expect(totals).toEqual([{ date: night2Day, value: 390 }]);
  });

  it("lastNightMin is the overnight session (300), not the nap-summed 390", () => {
    const signal = getSleepSignal(profileId);
    expect(signal).not.toBeNull();
    expect(signal!.lastNightMin).toBe(300);
    // Baseline is the prior night's main session (420), so the 5h overnight reads
    // as a deficit — which the nap-summed 390 would have masked toward 420.
    expect(signal!.baselineMin).toBe(420);
  });

  it("getMainSleepNightlyMinutes drops the nap and keeps one overnight per night", () => {
    expect(getMainSleepNightlyMinutes(profileId)).toEqual([
      { date: night1Day, value: 420 },
      { date: night2Day, value: 300 },
    ]);
  });

  // Issue #1066: the Sleep-page hero + dashboard tile share getLastNightSummary,
  // which MUST pick the main overnight (not the latest/nap session) for the latest
  // wake-day. This pins the exact defect CI caught in the #1066 branch (the hero
  // rendered the 90-min nap instead of the 300-min night).
  it("getLastNightSummary returns the main overnight (300), without folding in the nap (#1066)", () => {
    const summary = getLastNightSummary(profileId);
    expect(summary).not.toBeNull();
    expect(summary!.wakeDay).toBe(night2Day);
    // The 5h overnight — NOT the 90-min nap that ends later the same wake-day.
    expect(summary!.durationMin).toBe(300);
    // Baseline is the prior night's main session (420) → a negative delta.
    expect(summary!.baselineAvgMin).toBe(420);
    expect(summary!.deltaMin).toBe(-120);
    expect(summary!.stages).toEqual({
      deep: 50,
      rem: 70,
      light: 160,
      awake: 20,
    });
  });

  it("the stage chart matches the main duration and excludes nap stages", () => {
    expect(
      getSleepStageComposition(profileId).find((row) => row.date === night2Day)
    ).toEqual({
      date: night2Day,
      deep: 50,
      rem: 70,
      light: 160,
      awake: 20,
    });
  });

  it("attributes Fitbit aggregate stage keys to their session window", () => {
    const fitbitId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('FitbitStageKeys')").run()
        .lastInsertRowid
    );
    setTimezone(fitbitId, "UTC");
    const wakeDay = today(fitbitId);
    const start = `${shiftDateStr(wakeDay, -1)}T23:00:00.000Z`;
    const end = `${wakeDay}T06:00:00.000Z`;
    upsertMetricSamples(
      fitbitId,
      [
        session("sleep_min", wakeDay, 420, start, end),
        session("sleep_deep_min", wakeDay, 60, `${start}#deep`, end),
        session("sleep_rem_min", wakeDay, 90, `${start}#rem`, end),
        session("sleep_light_min", wakeDay, 250, `${start}#light`, end),
        session("sleep_awake_min", wakeDay, 20, `${start}#wake`, end),
      ],
      "fitbit-takeout"
    );

    expect(getSleepStageComposition(fitbitId)).toContainEqual({
      date: wakeDay,
      deep: 60,
      rem: 90,
      light: 250,
      awake: 20,
    });
  });

  it("exposes the nap as a detailed today/history row", () => {
    const naps = getNapHistory(profileId);
    const expected = {
      date: night2Day,
      startMinutes: 14 * 60,
      endMinutes: 15 * 60 + 30,
      durationMin: 90,
      source: "health-connect",
    };
    expect(naps.today).toEqual([expected]);
    expect(naps.history).toContainEqual(expected);
    expect(naps.history).not.toContainEqual(
      expect.objectContaining({ durationMin: 300 })
    );
  });

  it("keeps nap history across a provider transition", () => {
    const transitionedId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('NapProviderTransition')")
        .run().lastInsertRowid
    );
    setTimezone(transitionedId, "UTC");
    const currentDay = today(transitionedId);
    const priorDay = shiftDateStr(currentDay, -1);
    upsertMetricSamples(
      transitionedId,
      [
        session(
          "sleep_min",
          priorDay,
          420,
          `${shiftDateStr(priorDay, -1)}T23:00:00Z`,
          `${priorDay}T06:00:00Z`
        ),
        session(
          "sleep_min",
          priorDay,
          45,
          `${priorDay}T13:00:00Z`,
          `${priorDay}T13:45:00Z`
        ),
      ],
      "health-connect"
    );
    upsertMetricSamples(
      transitionedId,
      [
        session(
          "sleep_min",
          currentDay,
          450,
          `${priorDay}T22:30:00Z`,
          `${currentDay}T06:00:00Z`
        ),
        session(
          "sleep_min",
          currentDay,
          30,
          `${currentDay}T14:00:00Z`,
          `${currentDay}T14:30:00Z`
        ),
      ],
      "oura"
    );

    const naps = getNapHistory(transitionedId);
    expect(naps.history.map((nap) => [nap.date, nap.durationMin])).toEqual([
      [currentDay, 30],
      [priorDay, 45],
    ]);
  });

  it("SRI's session input KEEPS the nap (naps are never dropped at the source level)", () => {
    // getSleepSessions is the SRI input; the nap window must still be present so
    // computeSleepRegularity counts its asleep epochs (#160). Three sessions total.
    const sessions = getSleepSessions(profileId);
    expect(sessions.length).toBe(3);
    expect(
      sessions.some(
        (s) =>
          s.start === `${night2Day}T14:00:00Z` &&
          s.end === `${night2Day}T15:30:00Z`
      )
    ).toBe(true);
  });

  // Owns its fixture rather than appending a LATER night to the shared one: the
  // shared fixture's newest night is now last night, so extending it would have
  // had to plant a session in the future.
  it("uses reported asleep minutes when they are shorter than the bedtime window", () => {
    const shortId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SleepAsleepMin')").run()
        .lastInsertRowid
    );
    setTimezone(shortId, "UTC");
    const wakeDay = today(shortId);
    upsertMetricSamples(
      shortId,
      [
        session(
          "sleep_min",
          wakeDay,
          270,
          `${shiftDateStr(wakeDay, -1)}T23:00:00Z`,
          `${wakeDay}T04:00:00Z`
        ),
      ],
      "health-connect"
    );
    const summary = getLastNightSummary(shortId)!;
    expect(summary.durationMin).toBe(270); // 4h30 asleep, not the 5h window
    expect(summary.bedMinutes).toBe(23 * 60);
    expect(summary.wakeMinutes).toBe(4 * 60);
  });
});

// Two sources on ONE wake-day, describing two different things (#2552). The nap
// read used to elect one source per calendar DAY — the additive rule, right for a
// day's total and wrong for a list of events — so the day's winning source took
// every row of the losing one with it, including a whole overnight session.
//
// THE TRIGGER IS CROSS-SOURCE, NOT MANUAL. #2552 tells the story with a
// hand-logged nap, which cannot happen: the only manual sleep writer is the
// measurements quick-add (lib/offline/writes.ts), which stores a duration-only row
// at `date||'T00:00:00'` for BOTH ends, and every session read filters on
// `julianday(end_time) > julianday(start_time)`. A manual sleep row is therefore
// never a session at all. What IS reachable is two syncing sources: a ring
// reporting the night while the phone's Health Connect reports an afternoon nap.
// health-connect outranks oura in SOURCE_PREFERENCE, so the nap won the day and the
// ring's entire overnight vanished — the exact failure #2552 describes, arrived at
// by the door that is actually open.
//
// What is pinned here is the DROPPED case, not the happy path: the nap must still
// be a nap, the overnight must still be the night, and the night's stage stack must
// still be on the chart.
//
// NOT asserted here, deliberately: `getLastNightSummary` on this same fixture. It
// reads `getSleepSessions`, which elects a whole SOURCE STREAM for the profile and
// falls back to "the source of the newest session" — so the afternoon nap flips the
// entire session history onto the phone and the hero reads 45 minutes. That is a
// different election at a different grain (a stream, not a day), with its own #14
// rationale behind it, and it is reported separately rather than widened into here.
describe("one wake-day, two sources, two real sessions (#2552)", () => {
  let crossId: number;
  let wakeDay: string;
  let priorDay: string;

  beforeAll(() => {
    crossId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('NapCrossSource')").run()
        .lastInsertRowid
    );
    setTimezone(crossId, "UTC");
    wakeDay = today(crossId);
    priorDay = shiftDateStr(wakeDay, -1);

    // The ring's overnight, with its stage rows on the same window.
    upsertMetricSamples(
      crossId,
      [
        session(
          "sleep_min",
          wakeDay,
          420,
          `${priorDay}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
        session(
          "sleep_deep_min",
          wakeDay,
          60,
          `${priorDay}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
        session(
          "sleep_rem_min",
          wakeDay,
          90,
          `${priorDay}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
        session(
          "sleep_light_min",
          wakeDay,
          250,
          `${priorDay}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
        session(
          "sleep_awake_min",
          wakeDay,
          20,
          `${priorDay}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
      ],
      "oura"
    );
    // …and the phone's afternoon nap the same wake-day. Nothing about it overlaps
    // the night, so it is not a competing account of the night.
    upsertMetricSamples(
      crossId,
      [
        session(
          "sleep_min",
          wakeDay,
          45,
          `${wakeDay}T13:00:00Z`,
          `${wakeDay}T13:45:00Z`
        ),
      ],
      "health-connect"
    );
  });

  it("keeps the phone's nap AND the ring's overnight", () => {
    const naps = getNapHistory(crossId);
    expect(naps.today).toEqual([
      {
        date: wakeDay,
        startMinutes: 13 * 60,
        endMinutes: 13 * 60 + 45,
        durationMin: 45,
        source: "health-connect",
      },
    ]);
    // The 7h overnight is the NIGHT, so it must not appear as a nap either — the
    // failure ran both ways round: the night vanished, and with it the only session
    // that could have made the nap a nap.
    expect(naps.history).toHaveLength(1);
  });

  it("keeps that night's stage stack on the chart", () => {
    expect(getSleepStageComposition(crossId)).toContainEqual({
      date: wakeDay,
      deep: 60,
      rem: 90,
      light: 250,
      awake: 20,
    });
  });

  it("hands the nap read both sessions, one per source", () => {
    // The read itself, under the surfaces: two rows, because the day held two
    // events. The day-grained election returned one.
    const rows = getDailySleepSessionsSince(crossId, priorDay)
      .map((row) => ({ source: row.source, value: row.value }))
      .sort((left, right) => left.value - right.value);
    expect(rows).toEqual([
      { source: "health-connect", value: 45 },
      { source: "oura", value: 420 },
    ]);
  });

  it("still collapses two sources describing the SAME night to one", () => {
    // The de-duplication the day-grained election was there for, and the reason the
    // fix narrows the bucket instead of removing it. Two wearables reporting one
    // overnight OVERLAP, so exactly one survives — by preference, which puts
    // health-connect above oura — and no phantom "nap" is left behind.
    const dupId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('NapDupNight')").run()
        .lastInsertRowid
    );
    setTimezone(dupId, "UTC");
    const day = today(dupId);
    const before = shiftDateStr(day, -1);
    upsertMetricSamples(
      dupId,
      [
        session(
          "sleep_min",
          day,
          420,
          `${before}T23:00:00Z`,
          `${day}T06:00:00Z`
        ),
      ],
      "health-connect"
    );
    upsertMetricSamples(
      dupId,
      [
        session(
          "sleep_min",
          day,
          410,
          `${before}T22:50:00Z`,
          `${day}T05:40:00Z`
        ),
      ],
      "oura"
    );
    expect(
      getDailySleepSessionsSince(dupId, before).map((row) => row.source)
    ).toEqual(["health-connect"]);
    expect(getNapHistory(dupId).history).toEqual([]);
  });
});

// The SAME two-syncing-sources shape one grain up (#2603). `readSleepSessions` elects
// one source STREAM for the whole read and, with no profile primary source set, falls
// back to "the source of the newest session" — a probe over a single row. An afternoon
// nap is the newest session most afternoons, so the phone's 45 minutes elected the
// phone and the ring's entire session history left the read with it: the hero, the
// SRI, the consistency strip, the typical wake time and the digest's sleep line all
// then described the nap.
//
// The bucket is NOT the fix here, and that is the difference from #2552 above. Stream
// election has its own #14 rationale — SRI needs ONE continuous session stream across
// its window, which is exactly why `getDailySleepSessionsSince` exists separately for
// date-keyed display — and that rationale is untouched. What was wrong is the probe:
// recency of ANY session, so one nap outranks a hundred nights. It now asks for the
// newest OVERNIGHT, and only falls back to the newest session at all when the profile
// records no overnight anywhere.
describe("two syncing sources, one nap: the stream election (#2603)", () => {
  const NIGHTS = 10;

  // A ring reporting `NIGHTS` consecutive overnights, plus one phone nap this
  // afternoon — the newest session in the profile by end_time.
  const napFlipProfile = (name: string): { id: number; wakeDay: string } => {
    const id = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );
    setTimezone(id, "UTC");
    const wakeDay = today(id);
    const nights: NormMetricSample[] = [];
    for (let offset = NIGHTS - 1; offset >= 0; offset--) {
      const day = shiftDateStr(wakeDay, -offset);
      nights.push(
        session(
          "sleep_min",
          day,
          420,
          `${shiftDateStr(day, -1)}T23:00:00Z`,
          `${day}T06:00:00Z`
        )
      );
    }
    upsertMetricSamples(id, nights, "oura");
    upsertMetricSamples(
      id,
      [
        session(
          "sleep_min",
          wakeDay,
          45,
          `${wakeDay}T13:00:00Z`,
          `${wakeDay}T13:45:00Z`
        ),
      ],
      "health-connect"
    );
    return { id, wakeDay };
  };

  it("keeps the ring's whole history when the newest session is the phone's nap", () => {
    const { id } = napFlipProfile("SleepStreamNap");
    const sessions = getSleepSessions(id);
    expect(sessions).toHaveLength(NIGHTS);
    expect(sessions.every((row) => row.source === "oura")).toBe(true);
  });

  it("reads the hero off the night, not the nap", () => {
    const { id, wakeDay } = napFlipProfile("SleepStreamNapHero");
    expect(getLastNightSummary(id)).toMatchObject({
      wakeDay,
      durationMin: 420,
      bedMinutes: 23 * 60,
      wakeMinutes: 6 * 60,
    });
  });

  it("still lets a NEW wearable take the stream over on its first night", () => {
    // The recency the fallback is FOR, and the case a "most sessions wins" fix would
    // have broken: the ring stops, the phone starts, and last night is the phone's.
    // It must elect the phone immediately rather than pinning the read to the
    // abandoned ring until it out-counts it.
    const id = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('SleepStreamSwitch')")
        .run().lastInsertRowid
    );
    setTimezone(id, "UTC");
    const wakeDay = today(id);
    const oldNights: NormMetricSample[] = [];
    for (let offset = NIGHTS; offset >= 2; offset--) {
      const day = shiftDateStr(wakeDay, -offset);
      oldNights.push(
        session(
          "sleep_min",
          day,
          420,
          `${shiftDateStr(day, -1)}T23:00:00Z`,
          `${day}T06:00:00Z`
        )
      );
    }
    upsertMetricSamples(id, oldNights, "oura");
    upsertMetricSamples(
      id,
      [
        session(
          "sleep_min",
          wakeDay,
          400,
          `${shiftDateStr(wakeDay, -1)}T23:30:00Z`,
          `${wakeDay}T06:10:00Z`
        ),
      ],
      "health-connect"
    );

    const sessions = getSleepSessions(id);
    expect(sessions.every((row) => row.source === "health-connect")).toBe(true);
    expect(getLastNightSummary(id)).toMatchObject({
      wakeDay,
      durationMin: 400,
    });
  });

  it("still elects SOMEBODY when no session anywhere reaches an overnight", () => {
    // A nap-only profile on two sources: the overnight probe finds nothing, so the
    // read falls back to the newest session exactly as it always did rather than
    // electing nobody and returning an empty history.
    const id = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('SleepStreamNapsOnly')")
        .run().lastInsertRowid
    );
    setTimezone(id, "UTC");
    const wakeDay = today(id);
    upsertMetricSamples(
      id,
      [
        session(
          "sleep_min",
          wakeDay,
          40,
          `${wakeDay}T10:00:00Z`,
          `${wakeDay}T10:40:00Z`
        ),
      ],
      "oura"
    );
    upsertMetricSamples(
      id,
      [
        session(
          "sleep_min",
          wakeDay,
          50,
          `${wakeDay}T15:00:00Z`,
          `${wakeDay}T15:50:00Z`
        ),
      ],
      "health-connect"
    );
    expect(getSleepSessions(id).map((row) => row.source)).toEqual([
      "health-connect",
    ]);
  });

  it("leaves an explicit primary source in charge", () => {
    // The profile's own #14 pick is decided before the fallback is ever reached, so
    // nothing here can override it — including when the pick is the nap's source.
    const { id } = napFlipProfile("SleepStreamNapPicked");
    setMetricSourcePriorityEntry(id, "sleep_min", "health-connect");
    expect(getSleepSessions(id).map((row) => row.value)).toEqual([45]);
  });
});

// The newest recorded night is not automatically LAST night. Every morning before
// the tracker pushes, the newest night is the one before it — and getSleepSignal
// used to hand that over under the name `lastNightMin`, so the rest-sleep nudge
// and the derived poor-sleep situation described the wrong night's sleep as this
// morning's. The signal now refuses instead of substituting.
describe("getSleepSignal freshness — the night must BE last night", () => {
  // A profile whose sleep stopped two nights ago: a rough 3h night that WOULD trip
  // the rest-sleep floor if it were mistaken for last night.
  const staleProfile = (name: string, newestOffset: number): number => {
    const id = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );
    setTimezone(id, "UTC");
    const samples: NormMetricSample[] = [];
    for (let offset = newestOffset + 6; offset >= newestOffset; offset--) {
      const wakeDay = shiftDateStr(today(id), -offset);
      const bedDay = shiftDateStr(wakeDay, -1);
      // The newest night is the deficient one (bed 23:00 → wake 02:00, 3h); the
      // rest are healthy 8h nights (23:00 → 07:00).
      const rough = offset === newestOffset;
      samples.push(
        session(
          "sleep_min",
          wakeDay,
          rough ? 180 : 480,
          `${bedDay}T23:00:00Z`,
          `${wakeDay}T${rough ? "02" : "07"}:00:00Z`
        )
      );
    }
    upsertMetricSamples(id, samples, "health-connect");
    return id;
  };

  it("answers when the newest night IS last night", () => {
    const id = staleProfile("SleepFreshToday", 0);
    const signal = getSleepSignal(id);
    expect(signal).not.toBeNull();
    expect(signal!.lastNightMin).toBe(180);
  });

  it("refuses when the newest night is the night BEFORE last night", () => {
    const id = staleProfile("SleepStaleOneNight", 1);
    expect(getSleepSignal(id)).toBeNull();
  });

  it("refuses when sleep has not synced for days", () => {
    const id = staleProfile("SleepStaleDays", 4);
    expect(getSleepSignal(id)).toBeNull();
  });

  // The rough-night evaluation the rest-sleep nudge and the derived poor-sleep
  // situation BOTH read. Asserted as a pair so the suppression is provably the
  // freshness gate and not a fixture that could never have fired: the identical
  // 3h night fires when it is last night and cannot even be evaluated when it
  // isn't, because there is no signal to evaluate.
  it("a stale rough night cannot reach the rough-night evaluation at all", () => {
    const id = staleProfile("SleepStaleNoNudge", 1);
    expect(getSleepSignal(id)).toBeNull();
  });

  it("but the identical night dated last night reads as rough", () => {
    const id = staleProfile("SleepFreshNudge", 0);
    const signal = getSleepSignal(id)!;
    expect(measureRoughNight(signal, DEFAULT_COACHING_THRESHOLDS).fired).toBe(
      true
    );
  });
});

describe("historical sleep range summary", () => {
  it("summarizes the latest night inside the range, not the global latest night", () => {
    const rangeProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SleepRange')").run()
        .lastInsertRowid
    );
    setTimezone(rangeProfileId, "UTC");
    upsertMetricSamples(
      rangeProfileId,
      [
        session(
          "sleep_min",
          "2024-01-14",
          480,
          "2024-01-13T23:00:00Z",
          "2024-01-14T07:00:00Z"
        ),
        session(
          "sleep_min",
          "2024-01-15",
          420,
          "2024-01-14T23:30:00Z",
          "2024-01-15T06:30:00Z"
        ),
        session(
          "sleep_min",
          "2026-07-20",
          360,
          "2026-07-19T23:30:00Z",
          "2026-07-20T05:30:00Z"
        ),
      ],
      "health-connect"
    );

    expect(getLastNightSummary(rangeProfileId)?.wakeDay).toBe("2026-07-20");
    expect(
      getSleepSummaryInRange(rangeProfileId, {
        from: "2024-01-01",
        to: "2024-01-31",
      })
    ).toMatchObject({
      wakeDay: "2024-01-15",
      durationMin: 420,
      baselineAvgMin: 480,
      deltaMin: -60,
    });
  });
});

// Issue #1191 — a segmented / biphasic night (two co-equal blocks, NO single block
// reaching the 6h floor) must read as ONE merged night, not a short block + a nap.
// Otherwise getSleepSignal.lastNightMin sits below the floor and the coaching engine
// fires a daily false `rest-sleep` nudge for someone who slept a healthy 8h. This is
// the builder-input-layer test (#448): the bug lives where the pure engine can't see.
describe("segmented night merge — no false rest-sleep nudge (#1191)", () => {
  it("a 4h + 4h segmented night reports 480 and emits NO rest-sleep", () => {
    const segId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SegmentedSleep')").run()
        .lastInsertRowid
    );
    setTimezone(segId, "UTC");

    // 15 consecutive segmented nights ending with LAST night (getSleepSignal only
    // answers for a night just woken from): 23:00–03:00 (4h) + 04:00–08:00 (4h),
    // a 1h awake gap between the co-equal blocks. Both sessions END on the wake-day.
    const samples: NormMetricSample[] = [];
    for (let offset = 14; offset >= 0; offset--) {
      const wakeDay = shiftDateStr(today(segId), -offset);
      const bedDay = shiftDateStr(wakeDay, -1);
      samples.push(
        session(
          "sleep_min",
          wakeDay,
          240,
          `${bedDay}T23:00:00Z`,
          `${wakeDay}T03:00:00Z`
        ),
        session(
          "sleep_min",
          wakeDay,
          240,
          `${wakeDay}T04:00:00Z`,
          `${wakeDay}T08:00:00Z`
        )
      );
    }
    upsertMetricSamples(segId, samples, "health-connect");

    // The merged main sleep is 8h, not the longest 4h block.
    const signal = getSleepSignal(segId)!;
    expect(signal.lastNightMin).toBe(480);
    expect(Math.round(signal.baselineMin)).toBe(480);

    // getMainSleepNightlyMinutes is one merged 480 per wake-day (not 240 + a nap).
    const nights = getMainSleepNightlyMinutes(segId);
    expect(nights.every((n) => n.value === 480)).toBe(true);

    // The hero/tile summary shows the merged 8h with NO same-day nap.
    const summary = getLastNightSummary(segId)!;
    expect(summary.durationMin).toBe(480);

    // The coaching engine fires no rest-sleep signal (480 ≥ the 360 floor, and no
    // deficit vs the 480 baseline) — the daily false nudge is gone.
    const recs = recommendCoaching(gatherCoachingInput(segId, "kg", "km"));
    expect(
      recs.some((r) => (r.firingReasonIds ?? []).includes("rest-sleep"))
    ).toBe(false);
  });

  it("SRI still counts every asleep epoch for the segmented fixture (#160 unchanged)", () => {
    // Regularity is computed over ALL epochs, so a REGULAR segmented schedule reads
    // as high regularity — the merge must not have routed SRI through the classifier.
    const segId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SegmentedSri')").run()
        .lastInsertRowid
    );
    setTimezone(segId, "UTC");
    const samples: NormMetricSample[] = [];
    for (let offset = 20; offset >= 1; offset--) {
      const wakeDay = shiftDateStr("2026-03-21", -offset);
      const bedDay = shiftDateStr(wakeDay, -1);
      samples.push(
        session(
          "sleep_min",
          wakeDay,
          240,
          `${bedDay}T23:00:00Z`,
          `${wakeDay}T03:00:00Z`
        ),
        session(
          "sleep_min",
          wakeDay,
          240,
          `${wakeDay}T04:00:00Z`,
          `${wakeDay}T08:00:00Z`
        )
      );
    }
    upsertMetricSamples(segId, samples, "health-connect");
    const reg = getSleepRegularity(segId)!;
    expect(reg).not.toBeNull();
    // A perfectly reproducible segmented schedule → SRI at the top of the band.
    expect(reg.sri).toBeGreaterThan(95);
  });

  it("a deficient overnight + a genuine afternoon nap stays main-only (anti-masking, #1118)", () => {
    const napId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SegNapMask')").run()
        .lastInsertRowid
    );
    setTimezone(napId, "UTC");
    // 3h overnight (deficient) + a 1h afternoon nap 11h later, on LAST night's
    // wake-day so getSleepSignal answers at all. The nap must NOT merge, so the
    // deficit is still seen.
    const napDay = today(napId);
    upsertMetricSamples(
      napId,
      [
        session(
          "sleep_min",
          napDay,
          180,
          `${napDay}T01:00:00Z`,
          `${napDay}T04:00:00Z`
        ),
        session(
          "sleep_min",
          napDay,
          60,
          `${napDay}T15:00:00Z`,
          `${napDay}T16:00:00Z`
        ),
      ],
      "health-connect"
    );
    expect(getSleepSignal(napId)!.lastNightMin).toBe(180);
    expect(getLastNightSummary(napId)!.durationMin).toBe(180);
  });
});

describe("duration-only manual sleep", () => {
  it("surfaces a manual daily amount without inventing bed/wake clocks", () => {
    const manualProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('ManualSleep')").run()
        .lastInsertRowid
    );
    setTimezone(manualProfileId, "UTC");
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'sleep_min', '2026-02-03',
               '2026-02-03T00:00:00', '2026-02-03T00:00:00', 450)`
    ).run(manualProfileId);

    expect(getLastNightSummary(manualProfileId)).toMatchObject({
      wakeDay: "2026-02-03",
      durationMin: 450,
      bedMinutes: null,
      wakeMinutes: null,
      source: "manual",
    });
  });

  it("does not replace a synced timing stream with a newer duration-only row", () => {
    const mixedProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('MixedSleep')").run()
        .lastInsertRowid
    );
    setTimezone(mixedProfileId, "UTC");
    for (let day = 1; day <= 14; day++) {
      const wakeDay = `2026-04-${String(day + 1).padStart(2, "0")}`;
      const bedDay = `2026-04-${String(day).padStart(2, "0")}`;
      upsertMetricSamples(
        mixedProfileId,
        [
          session(
            "sleep_min",
            wakeDay,
            480,
            `${bedDay}T23:00:00Z`,
            `${wakeDay}T07:00:00Z`
          ),
        ],
        "oura"
      );
    }
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'sleep_min', '2026-04-16',
               '2026-04-16T00:00:00', '2026-04-16T00:00:00', 450)`
    ).run(mixedProfileId);

    expect(getSleepSessions(mixedProfileId)).toHaveLength(14);
    expect(
      getSleepSessions(mixedProfileId).every((row) => row.source === "oura")
    ).toBe(true);
    expect(getSleepRegularity(mixedProfileId)).not.toBeNull();
    expect(getLastNightSummary(mixedProfileId)).toMatchObject({
      wakeDay: "2026-04-16",
      durationMin: 450,
      bedMinutes: null,
    });
  });

  it("uses nap-free main sessions for a newer manual row's baseline", () => {
    const baselineProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('ManualBaseline')").run()
        .lastInsertRowid
    );
    setTimezone(baselineProfileId, "UTC");
    upsertMetricSamples(
      baselineProfileId,
      [
        session(
          "sleep_min",
          "2026-05-02",
          420,
          "2026-05-01T23:00:00Z",
          "2026-05-02T06:00:00Z"
        ),
        session(
          "sleep_min",
          "2026-05-03",
          300,
          "2026-05-02T23:30:00Z",
          "2026-05-03T04:30:00Z"
        ),
        session(
          "sleep_min",
          "2026-05-03",
          90,
          "2026-05-03T14:00:00Z",
          "2026-05-03T15:30:00Z"
        ),
      ],
      "health-connect"
    );
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'sleep_min', '2026-05-04',
               '2026-05-04T00:00:00', '2026-05-04T00:00:00', 450)`
    ).run(baselineProfileId);

    expect(getLastNightSummary(baselineProfileId)).toMatchObject({
      wakeDay: "2026-05-04",
      durationMin: 450,
      baselineAvgMin: 360,
      deltaMin: 90,
      baselineNights: 2,
    });
  });

  it("keeps a duration-only row read-only beside a timed manual window", () => {
    const mixedManualId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('MixedManualSleep')")
        .run().lastInsertRowid
    );
    setTimezone(mixedManualId, "UTC");
    const wakeDay = today(mixedManualId);
    const bedDay = shiftDateStr(wakeDay, -1);
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 420),
              (?, 'manual', 'sleep_min', ?, ?, ?, 360)`
    ).run(
      mixedManualId,
      wakeDay,
      `${bedDay}T23:00:00Z`,
      `${wakeDay}T06:00:00Z`,
      mixedManualId,
      wakeDay,
      `${wakeDay}T00:00:00`,
      `${wakeDay}T00:00:00`
    );

    expect(
      getSleepMoodData(mixedManualId, 7).history.find(
        (row) => row.date === wakeDay
      )
    ).toMatchObject({
      sleepHours: 7,
      sleepEditable: false,
      sleepEditHours: null,
    });
  });
});

describe("bedtime supplements on the Sleep page", () => {
  it("joins due supplement doses to the actual sleep-start day", () => {
    const bedtimeProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('BedtimeSleep')").run()
        .lastInsertRowid
    );
    setTimezone(bedtimeProfileId, "UTC");
    const wakeDay = today(bedtimeProfileId);
    const sleepDate = shiftDateStr(wakeDay, -1);
    upsertMetricSamples(
      bedtimeProfileId,
      [
        session(
          "sleep_min",
          wakeDay,
          420,
          `${sleepDate}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
      ],
      "health-connect"
    );

    const insertItem = db.prepare(
      `INSERT INTO intake_items
         (profile_id, name, active, kind, condition, obligation, created_at)
         VALUES (?, ?, 1, ?, 'daily', 'should', ?)`
    );
    const createdAt = `${shiftDateStr(sleepDate, -7)} 00:00:00`;
    const magnesiumId = Number(
      insertItem.run(bedtimeProfileId, "Magnesium", "supplement", createdAt)
        .lastInsertRowid
    );
    const glycineId = Number(
      insertItem.run(bedtimeProfileId, "Glycine", "supplement", createdAt)
        .lastInsertRowid
    );
    const morningId = Number(
      insertItem.run(bedtimeProfileId, "Vitamin D", "supplement", createdAt)
        .lastInsertRowid
    );
    const medicationId = Number(
      insertItem.run(
        bedtimeProfileId,
        "Prescription sleep aid",
        "medication",
        createdAt
      ).lastInsertRowid
    );
    const insertDose = db.prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, created_at)
       VALUES (?, '1 cap', ?, 'any', 0, ?)`
    );
    const magnesiumDoseId = Number(
      insertDose.run(magnesiumId, "Before sleep", createdAt).lastInsertRowid
    );
    const glycineDoseId = Number(
      insertDose.run(glycineId, "bedtime", createdAt).lastInsertRowid
    );
    insertDose.run(morningId, "Morning", createdAt);
    insertDose.run(medicationId, "Before sleep", createdAt);

    const insertLog = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'taken')`
    );
    // Magnesium was taken before the session. Glycine has a misleading wake-day
    // log: it must remain missing for this night because the session began on the
    // prior profile-local date.
    insertLog.run(magnesiumDoseId, magnesiumId, sleepDate);
    insertLog.run(glycineDoseId, glycineId, wakeDay);

    const row = getSleepMoodData(bedtimeProfileId, 7).history.find(
      (entry) => entry.date === wakeDay
    );
    expect(row?.bedtimeSupplements).toMatchObject({
      sleepDate,
      due: 2,
      taken: 1,
      skipped: 0,
      state: "partial",
      items: [
        { name: "Magnesium", state: "taken" },
        { name: "Glycine", state: "missed" },
      ],
    });
  });

  it("keeps supplement context for every wake-day when nights include naps", () => {
    const historyProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('BedtimeHistory')").run()
        .lastInsertRowid
    );
    setTimezone(historyProfileId, "UTC");
    const end = today(historyProfileId);
    const oldestWakeDay = shiftDateStr(end, -59);
    const oldestSleepDate = shiftDateStr(oldestWakeDay, -1);
    const samples: NormMetricSample[] = [];
    for (let offset = 59; offset >= 0; offset--) {
      const wakeDay = shiftDateStr(end, -offset);
      const sleepDate = shiftDateStr(wakeDay, -1);
      samples.push(
        session(
          "sleep_min",
          wakeDay,
          420,
          `${sleepDate}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
        session(
          "sleep_min",
          wakeDay,
          30,
          `${wakeDay}T14:00:00Z`,
          `${wakeDay}T14:30:00Z`
        )
      );
    }
    upsertMetricSamples(historyProfileId, samples, "health-connect");
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation, created_at)
         VALUES (?, 'Magnesium', 1, 'supplement', 'daily', 'should', ?)`
        )
        .run(historyProfileId, `${shiftDateStr(oldestSleepDate, -1)} 00:00:00`)
        .lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort, created_at)
           VALUES (?, '1 cap', 'Before sleep', 'any', 0, ?)`
        )
        .run(itemId, `${shiftDateStr(oldestSleepDate, -1)} 00:00:00`)
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'taken')`
    ).run(doseId, itemId, oldestSleepDate);

    const oldest = getSleepMoodData(historyProfileId, 60).history.find(
      (row) => row.date === oldestWakeDay
    );
    expect(oldest?.bedtimeSupplements).toMatchObject({
      due: 1,
      taken: 1,
      state: "taken",
    });
  });

  // A logged night survives every later change to the dose row — retirement,
  // pause, or an edit after the fact (#1972). The one dose still excluded is the
  // one whose CURRENT slot is no longer bedtime: that log belongs to some other
  // part of the day, and nothing here claims otherwise.
  it("preserves resolved bedtime logs after retirement, pause, or a later edit", () => {
    const historyProfileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('ChangedBedtime')").run()
        .lastInsertRowid
    );
    setTimezone(historyProfileId, "UTC");
    const wakeDay = today(historyProfileId);
    const sleepDate = shiftDateStr(wakeDay, -1);
    upsertMetricSamples(
      historyProfileId,
      [
        session(
          "sleep_min",
          wakeDay,
          420,
          `${sleepDate}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
      ],
      "health-connect"
    );
    const insertItem = db.prepare(
      `INSERT INTO intake_items
         (profile_id, name, active, kind, condition, obligation, created_at)
         VALUES (?, ?, ?, 'supplement', 'daily', 'should', ?)`
    );
    const createdAt = `${shiftDateStr(sleepDate, -7)} 00:00:00`;
    const pausedId = Number(
      insertItem.run(historyProfileId, "Paused", 0, createdAt).lastInsertRowid
    );
    const retiredId = Number(
      insertItem.run(historyProfileId, "Retired", 1, createdAt).lastInsertRowid
    );
    const retimedId = Number(
      insertItem.run(historyProfileId, "Retimed", 1, createdAt).lastInsertRowid
    );
    const retimedToBedId = Number(
      insertItem.run(historyProfileId, "Retimed to bed", 1, createdAt)
        .lastInsertRowid
    );
    const insertDose = db.prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, retired, created_at, updated_at)
       VALUES (?, '1 cap', ?, 'any', 0, ?, ?, ?)`
    );
    const pausedDose = Number(
      insertDose.run(pausedId, "Before sleep", 0, createdAt, null)
        .lastInsertRowid
    );
    const retiredDose = Number(
      insertDose.run(retiredId, "Before sleep", 1, createdAt, null)
        .lastInsertRowid
    );
    const retimedDose = Number(
      insertDose.run(retimedId, "Morning", 0, createdAt, `${wakeDay} 12:00:00`)
        .lastInsertRowid
    );
    const retimedToBedDose = Number(
      insertDose.run(
        retimedToBedId,
        "Before sleep",
        0,
        createdAt,
        `${wakeDay} 12:00:00`
      ).lastInsertRowid
    );
    const insertLog = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, ?)`
    );
    insertLog.run(pausedDose, pausedId, sleepDate, "taken");
    insertLog.run(retiredDose, retiredId, sleepDate, "skipped");
    insertLog.run(retimedDose, retimedId, sleepDate, "taken");
    insertLog.run(retimedToBedDose, retimedToBedId, sleepDate, "taken");

    expect(
      getSleepMoodData(historyProfileId, 7).history.find(
        (row) => row.date === wakeDay
      )?.bedtimeSupplements
    ).toMatchObject({
      due: 3,
      taken: 2,
      skipped: 1,
      state: "partial",
    });
  });

  // Issue #1972. The reported shape: a bedtime dose is backfilled for a past
  // night and the dose row is edited afterwards (or edited first and backfilled
  // after). The log is a FACT about that night; nothing about how the dose row
  // looks today may retract it. The unlogged night below is the judgment side and
  // stays blank — that half is unchanged by this fix.
  it("keeps a backfilled bedtime dose that was edited after the night (#1972)", () => {
    const profile = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('BackfilledBedtime')")
        .run().lastInsertRowid
    );
    setTimezone(profile, "UTC");
    const wakeDay = today(profile);
    const sleepDate = shiftDateStr(wakeDay, -1);
    const earlyWakeDay = shiftDateStr(wakeDay, -4);
    const earlySleepDate = shiftDateStr(earlyWakeDay, -1);
    upsertMetricSamples(
      profile,
      [
        session(
          "sleep_min",
          wakeDay,
          420,
          `${sleepDate}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
        session(
          "sleep_min",
          earlyWakeDay,
          420,
          `${earlySleepDate}T23:00:00Z`,
          `${earlyWakeDay}T06:00:00Z`
        ),
      ],
      "health-connect"
    );

    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation, created_at)
           VALUES (?, 'Magnesium', 1, 'supplement', 'daily', 'should', ?)`
        )
        .run(profile, `${shiftDateStr(sleepDate, -1)} 00:00:00`).lastInsertRowid
    );
    // Created the day before the night, then edited the morning AFTER it.
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort, created_at, updated_at)
           VALUES (?, '1 cap', 'Before sleep', 'any', 0, ?, ?)`
        )
        .run(
          itemId,
          `${shiftDateStr(sleepDate, -1)} 00:00:00`,
          `${wakeDay} 09:30:00`
        ).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'taken')`
    ).run(doseId, itemId, sleepDate);

    const history = getSleepMoodData(profile, 7).history;
    expect(
      history.find((row) => row.date === wakeDay)?.bedtimeSupplements
    ).toMatchObject({
      sleepDate,
      due: 1,
      taken: 1,
      skipped: 0,
      state: "taken",
    });
    // A night before the dose existed carries no log, so the schedule still
    // decides — and it says the dose was not applicable yet.
    expect(
      history.find((row) => row.date === earlyWakeDay)?.bedtimeSupplements
    ).toBeNull();
  });

  it("keeps a bedtime log whose dose was last edited before the night (#1972)", () => {
    const profile = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('EditedBeforeNight')")
        .run().lastInsertRowid
    );
    setTimezone(profile, "UTC");
    const wakeDay = today(profile);
    const sleepDate = shiftDateStr(wakeDay, -1);
    upsertMetricSamples(
      profile,
      [
        session(
          "sleep_min",
          wakeDay,
          420,
          `${sleepDate}T23:00:00Z`,
          `${wakeDay}T06:00:00Z`
        ),
      ],
      "health-connect"
    );
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation, created_at)
           VALUES (?, 'Glycine', 1, 'supplement', 'daily', 'should', ?)`
        )
        .run(profile, `${shiftDateStr(sleepDate, -7)} 00:00:00`).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort, created_at, updated_at)
           VALUES (?, '1 cap', 'Before sleep', 'any', 0, ?, ?)`
        )
        .run(
          itemId,
          `${shiftDateStr(sleepDate, -7)} 00:00:00`,
          `${shiftDateStr(sleepDate, -2)} 08:00:00`
        ).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       VALUES (?, ?, ?, 'taken')`
    ).run(doseId, itemId, sleepDate);

    expect(
      getSleepMoodData(profile, 7).history.find((row) => row.date === wakeDay)
        ?.bedtimeSupplements
    ).toMatchObject({ sleepDate, due: 1, taken: 1, state: "taken" });
  });
});

// DB INTEGRATION TIER — the #2177 end-to-end fixtures for the paired-observations
// registry. The pure tier (lib/__tests__/paired-observations.test.ts) owns the gate
// matrix over pre-gathered arms; what only this tier can see is the INPUT LAYER — the
// factor readers over the user's own logs, the wake-day offset, the control rule that
// decides which days may join the without-arm, and the adult gate.
//
// The fixture takes the SHAPE of the issue's motivating table (a larger drink arm, a
// smaller dry arm, a gap in the tens of ms) with INVENTED values. Nothing here is
// anybody's data.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  buildPairedObservationFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import {
  pairedObservationSignalKey,
  PAIRED_MIN_NIGHTS_PER_ARM,
} from "@/lib/paired-observations";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function setBirthdate(profileId: number, iso: string): void {
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(profileId, iso);
}

function logFood(
  profileId: number,
  date: string,
  group: string,
  servings: number
): void {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = excluded.servings`
  ).run(profileId, date, group, servings);
}

function logWorkout(profileId: number, date: string): void {
  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, start_time, end_time, source)
     VALUES (?, ?, 'cardio', 'Evening session', 45, '18:00', '18:45', 'manual')`
  ).run(profileId, date);
}

function sample(
  profileId: number,
  metric: string,
  date: string,
  value: number
): void {
  const ts = `${date}T00:00:00`;
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'manual', ?, ?, ?, ?, ?)`
  ).run(profileId, metric, date, ts, ts, value);
}

function restingHr(profileId: number, date: string, bpm: number): void {
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, resting_hr) VALUES (?, ?, ?)"
  ).run(profileId, date, bpm);
}

// A run of evenings ending the day BEFORE `anchor` (the last factor day that can pair
// with an in-window outcome), each carrying a food log so the day counts as observed,
// `drinkDays` of them with a drink. The overnight reading lands on the WAKE day.
function seedDrinkFixture(
  profileId: number,
  anchor: string,
  opts: {
    drinkDays: number;
    dryDays: number;
    hrvAfterDrink?: number;
    hrvAfterDry?: number;
    logFoodOnDryDays?: boolean;
  }
): void {
  const total = opts.drinkDays + opts.dryDays;
  for (let i = 0; i < total; i++) {
    const evening = shiftDateStr(anchor, -(total - i));
    const wakeDay = shiftDateStr(evening, 1);
    const drank = i < opts.drinkDays;
    if (drank) {
      logFood(profileId, evening, "alcohol", 1);
      logFood(profileId, evening, "vegetables", 2);
    } else if (opts.logFoodOnDryDays ?? true) {
      logFood(profileId, evening, "vegetables", 2);
    }
    if (opts.hrvAfterDrink != null && opts.hrvAfterDry != null) {
      sample(
        profileId,
        "hrv_ms",
        wakeDay,
        drank ? opts.hrvAfterDrink : opts.hrvAfterDry
      );
    }
  }
}

describe("buildPairedObservationFindings — the alcohol → overnight HRV pair (#2177)", () => {
  it("fires with both arms' night counts in the copy", () => {
    const p = newProfile("paired-hrv-fires");
    setBirthdate(p, "1990-03-04");
    const anchor = today(p);
    seedDrinkFixture(p, anchor, {
      drinkDays: 20,
      dryDays: 10,
      hrvAfterDrink: 41,
      hrvAfterDry: 56,
    });

    const findings = buildPairedObservationFindings(p, anchor);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(
      pairedObservationSignalKey("alcohol-hrv", anchor.slice(0, 7))
    );
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(f.tone).toBe("info");
    expect(f.detail).toContain("20 nights");
    expect(f.detail).toContain("10 nights");
    expect(f.detail).toContain("41 ms");
    expect(f.detail).toContain("56 ms");
    // Co-occurrence phrasing only.
    expect(f.detail).toMatch(/not a cause/i);

    // It joins the ONE coaching rollup under the SAME key, so a dismiss anywhere
    // silences it everywhere.
    const rolled = collectCoachingFindings(p, anchor, "kg").map(
      (x) => x.dedupeKey
    );
    expect(rolled).toContain(f.dedupeKey);
  });

  it("vanishes when the drink arm drops below the per-arm minimum", () => {
    const p = newProfile("paired-hrv-thin-arm");
    setBirthdate(p, "1990-03-04");
    const anchor = today(p);
    seedDrinkFixture(p, anchor, {
      drinkDays: PAIRED_MIN_NIGHTS_PER_ARM - 1,
      dryDays: 20,
      hrvAfterDrink: 41,
      hrvAfterDry: 56,
    });
    expect(buildPairedObservationFindings(p, anchor)).toEqual([]);
  });

  it("does not count unlogged days as dry evenings", () => {
    // The control rule: a day with no food logged is evidence about LOGGING, not about
    // drinking. Twenty drink evenings and ten evenings with nothing logged at all must
    // leave the without-arm empty rather than manufacturing a comparison.
    const p = newProfile("paired-hrv-unlogged-control");
    setBirthdate(p, "1990-03-04");
    const anchor = today(p);
    seedDrinkFixture(p, anchor, {
      drinkDays: 20,
      dryDays: 10,
      hrvAfterDrink: 41,
      hrvAfterDry: 56,
      logFoodOnDryDays: false,
    });
    expect(buildPairedObservationFindings(p, anchor)).toEqual([]);
  });

  it("stays silent when the two arms sit inside the effect floor", () => {
    const p = newProfile("paired-hrv-null-result");
    setBirthdate(p, "1990-03-04");
    const anchor = today(p);
    seedDrinkFixture(p, anchor, {
      drinkDays: 20,
      dryDays: 10,
      hrvAfterDrink: 48,
      hrvAfterDry: 51,
    });
    expect(buildPairedObservationFindings(p, anchor)).toEqual([]);
  });

  it("withholds the substance-conditioned pairs from a known minor (#1174/#1279)", () => {
    const p = newProfile("paired-hrv-minor");
    const anchor = today(p);
    // Fourteen years old on the anchor date, whatever the run's clock.
    setBirthdate(p, shiftDateStr(anchor, -14 * 365 - 3));
    seedDrinkFixture(p, anchor, {
      drinkDays: 20,
      dryDays: 10,
      hrvAfterDrink: 41,
      hrvAfterDry: 56,
    });
    expect(buildPairedObservationFindings(p, anchor)).toEqual([]);

    // The same data on an adult profile does fire — so the empty result above is the
    // gate, not the fixture.
    const adult = newProfile("paired-hrv-adult-control");
    setBirthdate(adult, "1990-03-04");
    seedDrinkFixture(adult, anchor, {
      drinkDays: 20,
      dryDays: 10,
      hrvAfterDrink: 41,
      hrvAfterDry: 56,
    });
    expect(buildPairedObservationFindings(adult, anchor)).toHaveLength(1);
  });

  it("pairs the drink evening with the NEXT morning's resting heart rate", () => {
    // Same factor, a different outcome stream and a different table — this is what
    // proves the declared wake-day offset is applied to the outcome, not the factor.
    const p = newProfile("paired-rhr-fires");
    setBirthdate(p, "1990-03-04");
    const anchor = today(p);
    for (let i = 0; i < 30; i++) {
      const evening = shiftDateStr(anchor, -(30 - i));
      const drank = i < 20;
      if (drank) logFood(p, evening, "alcohol", 1);
      logFood(p, evening, "vegetables", 2);
      restingHr(p, shiftDateStr(evening, 1), drank ? 64 : 58);
    }
    const findings = buildPairedObservationFindings(p, anchor);
    expect(findings.map((f) => f.dedupeKey)).toEqual([
      pairedObservationSignalKey("alcohol-resting-hr", anchor.slice(0, 7)),
    ]);
    expect(findings[0].detail).toContain("64 bpm");
    expect(findings[0].detail).toContain("58 bpm");
  });
});

describe("buildPairedObservationFindings — the training → sleep pair (#2177)", () => {
  function seedTrainingFixture(
    profileId: number,
    anchor: string,
    opts: {
      workoutDays: number;
      restDays: number;
      afterWorkout: number;
      afterRest: number;
    }
  ): void {
    const total = opts.workoutDays + opts.restDays;
    for (let i = 0; i < total; i++) {
      const day = shiftDateStr(anchor, -(total - i));
      const trained = i < opts.workoutDays;
      if (trained) logWorkout(profileId, day);
      sample(
        profileId,
        "sleep_min",
        shiftDateStr(day, 1),
        trained ? opts.afterWorkout : opts.afterRest
      );
    }
  }

  it("fires when the two kinds of night differ by more than the floor", () => {
    const p = newProfile("paired-sleep-fires");
    const anchor = today(p);
    seedTrainingFixture(p, anchor, {
      workoutDays: 20,
      restDays: 12,
      afterWorkout: 470,
      afterRest: 405,
    });
    const findings = buildPairedObservationFindings(p, anchor);
    expect(findings.map((f) => f.dedupeKey)).toEqual([
      pairedObservationSignalKey("training-sleep", anchor.slice(0, 7)),
    ]);
    expect(findings[0].detail).toContain("20 nights");
    expect(findings[0].detail).toContain("12 nights");
    expect(findings[0].detail).toContain("7h 50m");
    expect(findings[0].detail).toContain("6h 45m");
  });

  it("says nothing when trained and rest nights come out the same", () => {
    // The issue's own null case (427 vs 433 minutes, shape only). v1 renders NOTHING
    // rather than a "no association" claim — #2177 constraint 4.
    const p = newProfile("paired-sleep-null");
    const anchor = today(p);
    seedTrainingFixture(p, anchor, {
      workoutDays: 30,
      restDays: 10,
      afterWorkout: 422,
      afterRest: 430,
    });
    expect(buildPairedObservationFindings(p, anchor)).toEqual([]);
  });

  it("ignores nights before the training log was ever used", () => {
    // Absence of an activity row is a rest day — but only once there is evidence the
    // log is in use. The forty nights before the first logged workout are not forty
    // rest nights, and counting them would build a control arm out of the stretch
    // before this profile trained at all.
    const p = newProfile("paired-sleep-pre-log");
    const anchor = today(p);
    for (let ago = 60; ago >= 1; ago--) {
      const day = shiftDateStr(anchor, -ago);
      // Long nights all the way back; workouts only in the last 12 days, on 10 of them.
      const trained = ago <= 12 && ago !== 6 && ago !== 3;
      if (trained) logWorkout(p, day);
      sample(p, "sleep_min", shiftDateStr(day, 1), trained ? 470 : 405);
    }
    // Ten workout nights clear the arm minimum; the control arm holds only the two
    // rest days inside the logged stretch, so the pair stays silent.
    expect(buildPairedObservationFindings(p, anchor)).toEqual([]);
  });
});

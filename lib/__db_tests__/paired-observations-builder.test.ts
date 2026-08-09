// DB INTEGRATION TIER — the #448 end-to-end fixture for the paired-observations
// registry (#2177). Seeds #2177's MOTIVATING FIXTURE from raw rows (21 evenings with a
// drink logged, 9 without, overnight HRV on the mornings after) and asserts the
// alcohol↔HRV pair fires with those numbers, parses against RULE_FINDING_PREFIXES,
// joins collectCoachingFindings and never leaves the coaching tier — then removes
// enough drink evenings to drop the present arm below its gate and asserts it vanishes
// entirely (no hedged finding, no "not enough data" note).
//
// Also pins the two gates the query composition owns rather than the pure measure: the
// lag (an evening's factor against the NEXT morning's reading) and the adult-only
// registry field (a minor never sees the substance pairs).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  buildPairedObservationFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import { getPairedObservation } from "@/lib/queries/paired-observations";
import {
  PAIRED_OBS_PREFIX,
  PAIRED_OBSERVATIONS,
  pairedObservationKey,
} from "@/lib/paired-observations";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { setUserBirthdate } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { ALCOHOL_FOOD_GROUP } from "@/lib/substance-use";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function logDrink(profileId: number, date: string, servings = 1): void {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = excluded.servings`
  ).run(profileId, date, ALCOHOL_FOOD_GROUP, servings);
}

function logHrv(profileId: number, date: string, ms: number): void {
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'oura', 'hrv_ms', ?, ?, ?, ?)`
  ).run(
    profileId,
    date,
    `${date}T02:00:00Z`,
    `${date}T02:05:00Z`,
    ms
  );
}

// #2177's fixture, laid on real days: 30 EVENINGS ending yesterday, each with the
// overnight HRV recorded on the morning after (so the newest reading is today's). 21
// evenings carry a drink, 9 do not, interleaved through the whole stretch so the two
// arms are two conditions rather than two phases. Values are the issue's measured
// means exactly, so the finding's sentence is reproducible from the rows.
const WITH_DRINK_MS = 42.4;
const NO_DRINK_MS = 54.4;

function drinkEvening(i: number): boolean {
  // 7 of every 10 — 21 of 30, present and absent in both halves of the window.
  return i % 10 < 7;
}

function seedFixture(profileId: number, anchor: string, eveningCount = 30) {
  for (let i = 0; i < eveningCount; i++) {
    const evening = shiftDateStr(anchor, -(i + 1));
    const morning = shiftDateStr(anchor, -i);
    const drank = drinkEvening(i);
    if (drank) logDrink(profileId, evening);
    logHrv(profileId, morning, drank ? WITH_DRINK_MS : NO_DRINK_MS);
  }
}

describe("buildPairedObservationFindings — the alcohol↔HRV pair (#2177)", () => {
  it("states #2177's fixture back with both arms and both n", () => {
    const p = newProfile("paired-alcohol-hrv");
    const anchor = today(p);
    seedFixture(p, anchor);

    const cmp = getPairedObservation(
      p,
      PAIRED_OBSERVATIONS["alcohol-hrv"],
      anchor
    )!;
    expect(cmp).not.toBeNull();
    expect(cmp.present.days).toBe(21);
    expect(cmp.absent.days).toBe(9);
    expect(cmp.present.mean).toBeCloseTo(WITH_DRINK_MS, 5);
    expect(cmp.absent.mean).toBeCloseTo(NO_DRINK_MS, 5);
    expect(cmp.delta).toBeCloseTo(-12, 5);

    const findings = buildPairedObservationFindings(p, anchor);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(
      pairedObservationKey("alcohol-hrv", anchor.slice(0, 7))
    );
    expect(f.dedupeKey.startsWith(PAIRED_OBS_PREFIX)).toBe(true);
    // #860 Track A — registered, and registered COACHING (never a push/hero).
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(f.tone).toBe("info");
    // Both arms' n render, and the arms are named by what was LOGGED.
    expect(f.detail).toContain("21 nights");
    expect(f.detail).toContain("9 nights");
    expect(f.detail).toContain("42 ms");
    expect(f.detail).toContain("54 ms");
    expect(f.evidence).toContain("none logged");
    // No dueness anywhere: an observation cannot be missed (findings doctrine §3).
    expect(f.dueDate ?? null).toBeNull();

    // It joins the ONE coaching rollup.
    expect(
      collectCoachingFindings(p, anchor, "kg").map((x) => x.dedupeKey)
    ).toContain(f.dedupeKey);
  });

  it("vanishes entirely once the present arm drops below its gate", () => {
    const p = newProfile("paired-alcohol-hrv-thin");
    const anchor = today(p);
    seedFixture(p, anchor);
    expect(buildPairedObservationFindings(p, anchor)).toHaveLength(1);

    // Remove 14 of the 21 drink evenings → 7 present, one short of the declared 8.
    const removed: string[] = [];
    for (let i = 0; i < 30 && removed.length < 14; i++) {
      if (!drinkEvening(i)) continue;
      const evening = shiftDateStr(anchor, -(i + 1));
      db.prepare(
        `DELETE FROM food_log WHERE profile_id = ? AND date = ? AND group_key = ?`
      ).run(p, evening, ALCOHOL_FOOD_GROUP);
      removed.push(evening);
    }
    expect(removed).toHaveLength(14);

    // Silence — not a hedged finding and not a "not enough data yet" note.
    expect(buildPairedObservationFindings(p, anchor)).toEqual([]);
  });

  it("is silent when the effect is real but under the declared floor", () => {
    const p = newProfile("paired-alcohol-hrv-small");
    const anchor = today(p);
    for (let i = 0; i < 30; i++) {
      const evening = shiftDateStr(anchor, -(i + 1));
      const morning = shiftDateStr(anchor, -i);
      const drank = drinkEvening(i);
      if (drank) logDrink(p, evening);
      // A 4 ms difference: measurable, below the 8 ms floor, so it says nothing.
      logHrv(p, morning, drank ? 50 : 54);
    }
    expect(buildPairedObservationFindings(p, anchor)).toEqual([]);
  });

  it("pairs an EVENING with the NEXT morning's reading, not the same day's", () => {
    const p = newProfile("paired-alcohol-hrv-lag");
    const anchor = today(p);
    // Same drink evenings, but every HRV reading is filed on the evening ITSELF.
    for (let i = 0; i < 30; i++) {
      const evening = shiftDateStr(anchor, -(i + 1));
      const drank = drinkEvening(i);
      if (drank) logDrink(p, evening);
      logHrv(p, evening, drank ? WITH_DRINK_MS : NO_DRINK_MS);
    }
    const cmp = getPairedObservation(
      p,
      PAIRED_OBSERVATIONS["alcohol-hrv"],
      anchor
    );
    // Shifted by one day the arms no longer line up with their readings, so the
    // difference collapses under the floor and nothing is claimed.
    expect(cmp).toBeNull();
  });

  it("never shows a known minor the adult-gated substance pairs", () => {
    const p = newProfile("paired-alcohol-hrv-minor");
    const anchor = today(p);
    seedFixture(p, anchor);
    expect(buildPairedObservationFindings(p, anchor)).toHaveLength(1);

    // A 14-year-old: the substance surface is adult-gated (#1174/#1279), and the
    // registry's own `adultOnly` field is what carries that here.
    setUserBirthdate(p, shiftDateStr(anchor, -365 * 14));
    expect(buildPairedObservationFindings(p, anchor)).toEqual([]);
  });
});

describe("buildPairedObservationFindings — the training↔sleep pair (#2177)", () => {
  it("compares nights after a session against nights after none", () => {
    const p = newProfile("paired-training-sleep");
    const anchor = today(p);
    const spec = PAIRED_OBSERVATIONS["training-sleep"];

    // 40 days: a session on 3 of every 5, and the following night's MAIN sleep session
    // recorded as an absolute window (the #1118 classifier's input).
    for (let i = 0; i < 40; i++) {
      const day = shiftDateStr(anchor, -(i + 1));
      const wakeDay = shiftDateStr(anchor, -i);
      const trained = i % 5 < 3;
      if (trained) {
        db.prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, ?, 'cardio', 'Evening run (fixture)', 45)`
        ).run(p, day);
      }
      // 7h30 after a session, 6h30 after a rest day — a 60-minute difference, over
      // the pair's declared 30-minute floor.
      const startHour = trained ? "22:30" : "23:30";
      db.prepare(
        `INSERT INTO metric_samples
           (profile_id, source, metric, date, start_time, end_time, value)
         VALUES (?, 'oura', 'sleep_min', ?, ?, ?, ?)`
      ).run(
        p,
        wakeDay,
        `${day}T${startHour}:00Z`,
        `${wakeDay}T06:00:00Z`,
        trained ? 450 : 390
      );
    }

    const cmp = getPairedObservation(p, spec, anchor)!;
    expect(cmp).not.toBeNull();
    expect(cmp.present.days).toBe(24);
    expect(cmp.absent.days).toBe(16);
    expect(cmp.delta).toBeCloseTo(60, 5);

    const findings = buildPairedObservationFindings(p, anchor);
    const f = findings.find((x) => x.dedupeKey.includes("training-sleep"))!;
    expect(f).toBeDefined();
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    // A duration renders on a clock, never as raw minutes.
    expect(f.detail).toContain("7h 30m");
    expect(f.detail).toContain("6h 30m");
  });
});

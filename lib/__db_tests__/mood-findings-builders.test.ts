// DB INTEGRATION TIER — the #448 end-to-end fixtures for the two #992 mood
// coaching builders: seed realistic mood_logs (+ metric_samples sleep) fixtures
// and assert the finding output — dedupeKey parses against the registry, tier
// resolves coaching, and it joins collectCoachingFindings. Pins the issue's
// required negative cases: low mood with steady sleep → NO bridge finding; a
// sleep dip with steady mood → NO bridge finding.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone, setProfileSetting } from "@/lib/settings";
import { getSleepRegularity } from "@/lib/queries/sleep";
import {
  getSleepRegularityDrop,
  getSituationImpacts,
} from "@/lib/queries/situation-impact";
import {
  buildMoodFindings,
  buildSleepMoodBridgeFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { lowMoodSignalKey, sleepMoodSignalKey } from "@/lib/mood-observation";
import { upsertMoodLog } from "@/lib/offline/writes";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Log a mood on each of the trailing `n` days (daysAgo n-1 → 0) at `valence`.
function seedMoodRun(
  profileId: number,
  anchor: string,
  n: number,
  valence: number
) {
  for (let ago = n - 1; ago >= 0; ago--) {
    upsertMoodLog(profileId, shiftDateStr(anchor, -ago), { valence });
  }
}

// One recorded night ending on `date`: a manual sleep_min daily sample (the same
// natural-key shape the vitals quick-add writes), `minutes` long.
function seedNight(profileId: number, date: string, minutes: number) {
  const ts = `${date}T00:00:00`;
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'manual', 'sleep_min', ?, ?, ?, ?)`
  ).run(profileId, date, ts, ts, minutes);
}

describe("buildMoodFindings — sustained low-mood observation (#992)", () => {
  it("surfaces the calm coaching note over a sustained low window", () => {
    const p = newProfile("mood-low");
    const anchor = today(p);
    seedMoodRun(p, anchor, 10, 2); // 10 low days in the 14-day window

    const findings = buildMoodFindings(p, anchor);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(lowMoodSignalKey(anchor.slice(0, 7)));
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    // Calm, observational, non-diagnostic (#449 coaching tier; no escalation).
    expect(f.tone).toBe("info");
    expect(f.detail).toMatch(/averaged 2/);
    expect(f.detail).not.toMatch(/depress|screen|crisis/i);

    // It joins the unified coaching rollup with the SAME key.
    const rolled = collectCoachingFindings(p, anchor, "kg").map(
      (x) => x.dedupeKey
    );
    expect(rolled).toContain(f.dedupeKey);
  });

  it("stays silent for an ordinary mixed stretch", () => {
    const p = newProfile("mood-ok");
    const anchor = today(p);
    seedMoodRun(p, anchor, 10, 4);
    expect(buildMoodFindings(p, anchor)).toEqual([]);
  });

  it("stays silent on sparse data (below the min logged days)", () => {
    const p = newProfile("mood-sparse");
    const anchor = today(p);
    seedMoodRun(p, anchor, 3, 1);
    expect(buildMoodFindings(p, anchor)).toEqual([]);
  });
});

describe("buildSleepMoodBridgeFindings — the co-occurrence bridge (#992)", () => {
  it("fires when a nightly-duration drop co-occurs with the low-mood window", () => {
    const p = newProfile("bridge-fires");
    const anchor = today(p);
    seedMoodRun(p, anchor, 10, 2); // low-mood window
    // Prior 14 nights ~8h, recent 14 nights ~6.5h → a 90-min drop.
    for (let ago = 27; ago >= 14; ago--) {
      seedNight(p, shiftDateStr(anchor, -ago), 480);
    }
    for (let ago = 13; ago >= 0; ago--) {
      seedNight(p, shiftDateStr(anchor, -ago), 390);
    }

    const findings = buildSleepMoodBridgeFindings(p, anchor);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(sleepMoodSignalKey(anchor.slice(0, 7)));
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(f.tone).toBe("info");
    // Co-occurrence phrasing only — never a causal claim.
    expect(f.detail).toMatch(/move together/i);
    expect(f.detail).not.toMatch(/because your sleep|caused/i);

    const rolled = collectCoachingFindings(p, anchor, "kg").map(
      (x) => x.dedupeKey
    );
    expect(rolled).toContain(f.dedupeKey);
  });

  it("NEGATIVE: low mood with steady sleep → no bridge finding (the low-mood note still fires)", () => {
    const p = newProfile("bridge-steady-sleep");
    const anchor = today(p);
    seedMoodRun(p, anchor, 10, 2);
    // 28 steady ~7.5h nights: no drop in either signal.
    for (let ago = 27; ago >= 0; ago--) {
      seedNight(p, shiftDateStr(anchor, -ago), 450);
    }
    expect(buildSleepMoodBridgeFindings(p, anchor)).toEqual([]);
    expect(buildMoodFindings(p, anchor)).toHaveLength(1);
  });

  it("NEGATIVE: a sleep dip with steady mood → no bridge finding", () => {
    const p = newProfile("bridge-steady-mood");
    const anchor = today(p);
    seedMoodRun(p, anchor, 10, 4); // mood fine
    for (let ago = 27; ago >= 14; ago--) {
      seedNight(p, shiftDateStr(anchor, -ago), 480);
    }
    for (let ago = 13; ago >= 0; ago--) {
      seedNight(p, shiftDateStr(anchor, -ago), 360); // a big dip
    }
    expect(buildSleepMoodBridgeFindings(p, anchor)).toEqual([]);
    expect(buildMoodFindings(p, anchor)).toEqual([]);
  });

  it("stays silent without enough recorded nights to compare", () => {
    const p = newProfile("bridge-sparse-sleep");
    const anchor = today(p);
    seedMoodRun(p, anchor, 10, 2);
    // Only 3 recent nights — under the per-window night gate.
    for (let ago = 2; ago >= 0; ago--) {
      seedNight(p, shiftDateStr(anchor, -ago), 300);
    }
    expect(buildSleepMoodBridgeFindings(p, anchor)).toEqual([]);
  });
});

// Actual session windows keep duration steady while their clock times alternate.
function seedRegularity(
  profileId: number,
  anchor: string,
  oldest: number,
  shiftedDays = 28
) {
  setTimezone(profileId, "UTC");
  for (let ago = oldest; ago >= 0; ago--) {
    const date = shiftDateStr(anchor, -ago);
    const shifted = ago < shiftedDays && ago % 2 === 0;
    const start = shifted
      ? `${date}T03:00:00Z`
      : `${shiftDateStr(date, -1)}T23:00:00Z`;
    const end = `${date}T${shifted ? "11" : "07"}:00:00Z`;
    db.prepare(
      `INSERT INTO metric_samples
      (profile_id, source, metric, date, started_at, ended_at, value)
      VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 480)`
    ).run(profileId, date, start, end);
  }
}

describe("shared SRI drop in the Sleep note and existing mood bridge", () => {
  it("uses the actual endpoint and latest sufficient declared episode without changing impact means", () => {
    const p = newProfile("sri-shared");
    setTimezone(p, "UTC");
    const anchor = today(p);
    seedRegularity(p, anchor, 69, 48);
    const drop = getSleepRegularityDrop(p, anchor)!;
    expect(drop.points).toBeGreaterThan(10);
    expect(drop.detail).toBe(
      `Sleep regularity dropped about ${Math.round(drop.points)} points over the last four weeks.`
    );
    expect(buildSleepMoodBridgeFindings(p, anchor)).toEqual([]);
    seedMoodRun(p, anchor, 10, 2);
    const bridge = buildSleepMoodBridgeFindings(p, anchor)[0];
    expect(bridge.detail).toContain(
      `regularity dropped about ${Math.round(drop.points)} points`
    );
    expect(bridge.detail).toContain(`through ${drop.through}`);
    expect(bridge.title).toBe("Sleep regularity and low mood");

    const travelStart = shiftDateStr(anchor, -20);
    setProfileSetting(
      p,
      "situation_events",
      JSON.stringify([
        { date: travelStart, situation: "Travel", change: "start" },
        // A more recent one-day episode does not pass the engine sample gate.
        { date: anchor, situation: "High stress", change: "start" },
      ])
    );
    expect(getSleepRegularityDrop(p, anchor)?.detail).toContain(
      `; your Travel started on ${travelStart}.`
    );

    // A sufficient, flat short episode is context, not a second drop detector.
    const flatStart = shiftDateStr(anchor, -6);
    setProfileSetting(
      p,
      "situation_events",
      JSON.stringify([
        { date: travelStart, situation: "Travel", change: "start" },
        { date: flatStart, situation: "High stress", change: "start" },
      ])
    );
    const flatImpact = getSituationImpacts(p, anchor, "kg").find(
      (impact) => impact.situation === "High stress"
    );
    expect(
      flatImpact?.outcomes.find((outcome) => outcome.key === "index:sri")
        ?.meanDelta
    ).toBeCloseTo(0, 8);
    const context = getSleepRegularityDrop(p, anchor)!;
    expect(context.points).toBe(drop.points);
    expect(context.detail).toContain(
      `; your High stress started on ${flatStart}.`
    );
  });

  it("refuses the private exact-anchor result when the baseline series is insufficient", () => {
    const p = newProfile("sri-shared-insufficient");
    setTimezone(p, "UTC");
    const anchor = today(p);
    // Fourteen baseline nights yield only one eligible SRI trend anchor.
    seedRegularity(p, anchor, 41);
    seedMoodRun(p, anchor, 10, 2);
    const oldPrior = getSleepRegularity(p, { asOf: shiftDateStr(anchor, -28) });
    const oldRecent = getSleepRegularity(p, { asOf: anchor });
    expect(oldPrior!.sri - oldRecent!.sri).toBeGreaterThan(10);
    expect(getSleepRegularityDrop(p, anchor)).toBeNull();
    expect(buildSleepMoodBridgeFindings(p, anchor)).toEqual([]);
  });
});

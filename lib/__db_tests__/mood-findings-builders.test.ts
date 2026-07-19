// DB INTEGRATION TIER — the #448 end-to-end fixtures for the two #992 mood
// coaching builders: seed realistic mood_logs (+ metric_samples sleep) fixtures
// and assert the finding output — dedupeKey parses against the registry, tier
// resolves coaching, and it joins collectCoachingFindings. Pins the issue's
// required negative cases: low mood with steady sleep → NO bridge finding; a
// sleep dip with steady mood → NO bridge finding.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
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
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
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

// DB INTEGRATION TIER — the #448 end-to-end fixture for the sun-exposure coaching
// builder (issue #571): seed a profile with a home location, a below-optimal vitamin
// D, and little outdoor daylight → assert the observation surfaces and parses against
// the RULE_FINDING_PREFIXES registry, joins collectCoachingFindings, and never leaves
// the coaching tier.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  buildSunExposureFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import { setHomeLocation } from "@/lib/settings";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { SUN_EXPOSURE_PREFIX } from "@/lib/sun-exposure";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A below-optimal 25-OH vitamin D reading (optimal is typically ≥ 30 ng/mL).
function seedLowVitaminD(profileId: number, date: string, value: number) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name)
     VALUES (?, ?, 'biomarker', 'Vitamin D, 25-Hydroxy', ?, ?, 'ng/mL', 'Vitamin D, 25-Hydroxy')`
  ).run(profileId, date, String(value), value);
}

// An outdoor cardio session (avg_temp_c present = the persisted outdoor signal) with
// a daytime window, `daysAgo` before today.
function seedOutdoorActivity(
  profileId: number,
  date: string,
  start: string,
  end: string
) {
  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, start_time, end_time, avg_temp_c)
     VALUES (?, ?, 'cardio', 'Walk', ?, ?, 18)`
  ).run(profileId, date, start, end);
}

describe("buildSunExposureFindings (#571)", () => {
  it("surfaces the observation when daylight is scarce and vitamin D is below optimal", () => {
    const p = newProfile("sun-low");
    const anchor = today(p);
    setHomeLocation(p, { lat: 40.7, lng: -74 });
    seedLowVitaminD(p, anchor, 22); // below the ~30 ng/mL optimal floor
    // One short midday outdoor walk in the whole window → well under an hour/week.
    seedOutdoorActivity(p, anchor, "12:00", "12:10");

    const findings = buildSunExposureFindings(p, anchor);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey.startsWith(SUN_EXPOSURE_PREFIX)).toBe(true);
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    // #860 Track A — registered coaching tier (never a push/hero).
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    // Coaching tier: a calm info tone, never a hero/alarm.
    expect(f.tone).toBe("info");
    expect(f.detail).toMatch(/vitamin D/i);

    // It joins the unified coaching rollup.
    const all = collectCoachingFindings(p, anchor, "kg");
    expect(all.map((x) => x.dedupeKey)).toContain(f.dedupeKey);
  });

  it("stays silent without a home location", () => {
    const p = newProfile("sun-nohome");
    const anchor = today(p);
    seedLowVitaminD(p, anchor, 22);
    expect(buildSunExposureFindings(p, anchor)).toEqual([]);
  });

  it("stays silent when vitamin D is optimal", () => {
    const p = newProfile("sun-optimal");
    const anchor = today(p);
    setHomeLocation(p, { lat: 40.7, lng: -74 });
    seedLowVitaminD(p, anchor, 45); // comfortably optimal
    seedOutdoorActivity(p, anchor, "12:00", "12:10");
    expect(buildSunExposureFindings(p, anchor)).toEqual([]);
  });

  it("stays silent when plenty of daylight-outdoor time is logged", () => {
    const p = newProfile("sun-plenty");
    const anchor = today(p);
    setHomeLocation(p, { lat: 40.7, lng: -74 });
    seedLowVitaminD(p, anchor, 22);
    // A daily 2-hour daytime walk across the window → far above the threshold.
    for (let i = 0; i < 30; i++) {
      const d = new Date(anchor + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - i);
      seedOutdoorActivity(p, d.toISOString().slice(0, 10), "10:00", "12:00");
    }
    expect(buildSunExposureFindings(p, anchor)).toEqual([]);
  });
});

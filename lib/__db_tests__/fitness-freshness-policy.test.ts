// DB INTEGRATION TIER (#2025). The per-test freshness policy has to survive the real
// gather: ambient natural-store readings and check-session entries arrive by different
// paths, and the same reading DATE lands on different verdicts because a continuously
// measured body value and a performed protocol carry different clocks. This fixture
// crosses those two axes and pins that the whole-check coverage the header renders is the
// sum of what the tiles show.
// All fixture values are synthetic (obviously-fictional profile, plain names).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  saveFitnessEntry,
  getFitnessAssessments,
  getAmbientFitnessReadings,
} from "@/lib/fitness-assessment";
import { batteryForAge } from "@/lib/fitness-battery";
import { buildFitnessCheckModel } from "@/lib/fitness-check-model";
import { assembleFitnessCheckModel } from "@/lib/fitness-check-assemble";
import { addCanonicalNames } from "@/lib/queries/medical";

function makeAdult(name: string) {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  const ins = db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)"
  );
  ins.run(profileId, "sex", "male");
  ins.run(profileId, "birthdate", "1985-06-01");
  return { profileId, anchor: today(profileId) };
}

function seedVital(
  profileId: number,
  canonical: string,
  value: number,
  date: string,
  source: string
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
     VALUES (?, ?, 'biomarker', ?, ?, ?, 'mL/kg/min', ?, ?)`
  ).run(profileId, date, canonical, String(value), value, canonical, source);
  addCanonicalNames([canonical]);
}

function seedBody(
  profileId: number,
  date: string,
  source: string,
  fields: { body_fat_pct?: number; resting_hr?: number; weight_kg?: number }
): void {
  db.prepare(
    `INSERT INTO body_metrics
       (profile_id, date, source, body_fat_pct, resting_hr, weight_kg)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    date,
    source,
    fields.body_fat_pct ?? null,
    fields.resting_hr ?? null,
    fields.weight_kg ?? null
  );
}

function modelFor(profileId: number, anchor: string, cadence = 180) {
  const battery = batteryForAge(40);
  return buildFitnessCheckModel(
    battery,
    getFitnessAssessments(profileId),
    getAmbientFitnessReadings(profileId, battery),
    "male",
    40,
    80,
    anchor,
    cadence
  );
}

describe("per-test freshness policy over the real gather (#2025)", () => {
  it("one date, two clocks: a synced body value is stale while a protocol is current", () => {
    const { profileId, anchor } = makeAdult("freshness-policy-cross");
    // 100 days back: inside the 180-day protocol cadence, past the 30/60-day body clocks.
    const when = shiftDateStr(anchor, -100);
    seedVital(profileId, "VO2 Max", 48, when, "oura");
    seedBody(profileId, when, "withings", {
      body_fat_pct: 18,
      resting_hr: 55,
      weight_kg: 80,
    });

    const m = modelFor(profileId, anchor);
    const by = new Map(m.results.map((r) => [r.key, r]));

    // Same source, same date — different verdicts, because the tests declare different
    // clocks. Provenance is intact on all three.
    expect(by.get("vo2max")!.provenance!.date).toBe(when);
    expect(by.get("vo2max")!.freshness).toBe("current");
    expect(by.get("restinghr")!.provenance!.date).toBe(when);
    expect(by.get("restinghr")!.freshness).toBe("due");
    expect(by.get("bodyfat")!.freshness).toBe("due");
    // The interval that applied is disclosed, so a surface never has to guess.
    expect(by.get("vo2max")!.provenance!.freshnessDays).toBe(180);
    expect(by.get("bodyfat")!.provenance!.freshnessDays).toBe(60);

    // All three are measured; only one is current.
    expect(m.coverage.measured).toBe(3);
    expect(m.coverage.fresh).toBe(1);
    expect(m.coverage.stale).toBe(2);
  });

  it("a check entry and an ambient reading are counted by the same rule", () => {
    const { profileId, anchor } = makeAdult("freshness-policy-mixed");
    // A performed check today, and a synced resting HR from 45 days back.
    expect(
      saveFitnessEntry(profileId, { date: anchor, testKey: "grip", value: 48 })
        .ok
    ).toBe(true);
    seedBody(profileId, shiftDateStr(anchor, -45), "withings", {
      resting_hr: 55,
      weight_kg: 80,
    });

    const m = modelFor(profileId, anchor);
    const grip = m.results.find((r) => r.key === "grip")!;
    const rhr = m.results.find((r) => r.key === "restinghr")!;
    expect(grip.provenance!.kind).toBe("check");
    expect(grip.freshness).toBe("current");
    expect(rhr.provenance!.kind).toBe("synced");
    // 45 days > the 30-day resting-HR clock, even though the profile cadence is 180.
    expect(rhr.freshness).toBe("due");

    // Coverage reconciles with the per-test verdicts the tiles render.
    expect(m.coverage.fresh).toBe(
      m.results.filter((r) => r.freshness === "current").length
    );
    expect(m.coverage.stale).toBe(
      m.results.filter((r) => r.freshness === "due").length
    );
    expect(m.coverage.measured + m.coverage.unmeasured).toBe(m.coverage.total);
  });

  it("the shared assembler carries the same coverage both surfaces render", () => {
    const { profileId, anchor } = makeAdult("freshness-policy-assemble");
    expect(
      saveFitnessEntry(profileId, { date: anchor, testKey: "grip", value: 48 })
        .ok
    ).toBe(true);
    seedBody(profileId, shiftDateStr(anchor, -400), "withings", {
      body_fat_pct: 18,
      weight_kg: 80,
    });

    // Training and Longevity both read this one assembler now (#2025).
    const { model } = assembleFitnessCheckModel(profileId);
    expect(model.coverage.fresh).toBeGreaterThanOrEqual(1);
    expect(model.coverage.stale).toBeGreaterThanOrEqual(1);
    expect(model.measuredCount).toBe(model.coverage.measured);
    // Domain coverage sums to the whole check.
    const sum = model.domains.reduce((n, d) => n + d.coverage.total, 0);
    expect(sum).toBe(model.coverage.total);
  });
});

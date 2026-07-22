import { describe, expect, it } from "vitest";
import { buildFitnessTile } from "@/lib/fitness-tile";
import {
  bodyFavorability,
  evidenceFavorability,
} from "@/lib/fitness-favorability";
import type { FitnessTestResult } from "@/lib/fitness-check-model";

// #1132 — the pure grid-tile VM, per encoding. The tile is a formatter over a
// FitnessTestResult (no new scoring), colored by favorability with a tier-appropriate
// overlay marker; unmeasured is the only grey. Also covers the body/evidence favorability
// helpers (distance-from-reference, symmetric / signed).

function result(over: Partial<FitnessTestResult>): FitnessTestResult {
  return {
    key: "x",
    label: "X",
    tier: "norms",
    domain: "endurance",
    unit: "u",
    measured: true,
    value: 1,
    lowerIsBetter: false,
    percentile: null,
    fitnessAge: null,
    standing: null,
    standingLift: null,
    selfNorm: null,
    favorability: null,
    provenance: null,
    delta: null,
    improved: null,
    ...over,
  };
}

describe("unmeasured tile is the only grey", () => {
  it("greys an unmeasured tile, never red", () => {
    const t = buildFitnessTile(result({ measured: false, value: null }));
    expect(t.basis).toBe("unmeasured");
    expect(t.tone).toBe("neutral");
    expect(t.heat).toBeNull();
    expect(t.overlay).toMatch(/not measured/i);
  });
});

describe("norms tile → percentile ramp", () => {
  it("maps the percentile to heat and shows the percentile number", () => {
    const t = buildFitnessTile(
      result({
        tier: "norms",
        favorability: 82,
        percentile: { percentile: 82, clamped: null },
      })
    );
    expect(t.basis).toBe("percentile");
    expect(t.heat).toBe(82);
    expect(t.tone).toBe("great");
    expect(t.overlay).toContain("82");
  });
});

describe("standard tile → ladder position + badge", () => {
  it("colors by the ladder position and shows the strength band", () => {
    const t = buildFitnessTile(
      result({
        tier: "standard",
        domain: "strength",
        favorability: 60,
        standing: { level: "advanced", label: "Advanced", color: "" },
      })
    );
    expect(t.basis).toBe("standard");
    expect(t.heat).toBe(60);
    expect(t.overlay).toBe("Advanced");
  });
});

describe("body tile → symmetric distance-from-range", () => {
  it("reddens as body fat leaves the healthy band on EITHER edge", () => {
    const inRange = bodyFavorability("bodyfat", 14, "male")!; // inside [8,20]
    const tooHigh = bodyFavorability("bodyfat", 30, "male")!;
    const tooLow = bodyFavorability("bodyfat", 3, "male")!;
    expect(inRange).toBe(100);
    expect(tooHigh).toBeLessThan(100);
    expect(tooLow).toBeLessThan(100);
  });

  it("resting-HR favorability is highest in the healthy band and both edges redden", () => {
    expect(bodyFavorability("restinghr", 55, null)).toBe(100); // no sex needed
    expect(bodyFavorability("restinghr", 95, null)!).toBeLessThan(100);
    expect(bodyFavorability("restinghr", 30, null)!).toBeLessThan(100);
  });

  it("tile overlay states in/out of range", () => {
    const inR = buildFitnessTile(
      result({ tier: "body", domain: "body", value: 14, favorability: 100 })
    );
    const outR = buildFitnessTile(
      result({ tier: "body", domain: "body", value: 30, favorability: 40 })
    );
    expect(inR.overlay).toMatch(/in healthy range/i);
    expect(outR.overlay).toMatch(/outside range/i);
  });
});

describe("evidence tile → signed distance-from-threshold", () => {
  it("greens further into good, reds into risk", () => {
    expect(evidenceFavorability("hrr", 30)!).toBe(100);
    expect(evidenceFavorability("hrr", 8)!).toBe(0);
    expect(evidenceFavorability("srt", 10)!).toBe(100);
    expect(evidenceFavorability("srt", 4)!).toBe(0);
    expect(evidenceFavorability("fourstage", 4)!).toBe(100);
  });

  it("tile shows a cited state chip (good / borderline / risk)", () => {
    const good = buildFitnessTile(
      result({ tier: "evidence", value: 30, favorability: 100 })
    );
    const risk = buildFitnessTile(
      result({ tier: "evidence", value: 8, favorability: 0 })
    );
    expect(good.overlay).toBe("good");
    expect(risk.overlay).toBe("risk");
  });
});

describe("self-norm tile (#1135) → rough band + delta, tagged rough", () => {
  it("colors by the rough-band position, shows the band + rough-guide tag + delta arrow, never a percentile", () => {
    const t = buildFitnessTile(
      result({
        tier: "self-norm",
        domain: "strength",
        value: 90,
        favorability: 62,
        selfNorm: {
          band: "good",
          bandLabel: "Good",
          position: 62,
          quality: "rough",
          citation: "coach guidance",
        },
        delta: 30,
        improved: true,
      })
    );
    expect(t.basis).toBe("self-norm");
    expect(t.heat).toBe(62);
    expect(t.roughGuide).toBe(true);
    expect(t.overlay).toMatch(/Good/);
    expect(t.overlay).toMatch(/rough guide/i);
    expect(t.deltaArrow).toBe("up");
    expect(t.selfNormCitation).toBe("coach guidance");
  });
});

describe("self-trend tile → delta direction only", () => {
  it("colors green when improved, red when declined, never an absolute fill", () => {
    const up = buildFitnessTile(
      result({ tier: "self-trend", value: 5, delta: 2, improved: true })
    );
    const down = buildFitnessTile(
      result({ tier: "self-trend", value: 5, delta: -2, improved: false })
    );
    expect(up.heat).toBeNull();
    expect(up.tone).toBe("good");
    expect(down.tone).toBe("bad");
  });
});

describe("lowerIsBetter delta direction", () => {
  it("a lower resting HR is an up (improving) arrow", () => {
    const t = buildFitnessTile(
      result({
        tier: "body",
        value: 55,
        favorability: 100,
        lowerIsBetter: true,
        delta: -4,
        improved: true,
      })
    );
    expect(t.deltaArrow).toBe("up"); // improvement-aware, not raw sign
  });
});

describe("stale provenance desaturates the tile state", () => {
  it("marks a stale reading", () => {
    const t = buildFitnessTile(
      result({
        tier: "norms",
        favorability: 50,
        percentile: { percentile: 50, clamped: null },
        provenance: {
          kind: "synced",
          label: "from Oura",
          sourceName: "Oura",
          date: "2025-01-01",
          ageDays: 400,
          stale: true,
        },
      })
    );
    expect(t.stale).toBe(true);
  });
});

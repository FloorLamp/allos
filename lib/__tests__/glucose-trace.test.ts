import { describe, expect, it } from "vitest";
import {
  deriveGlucoseDay,
  GLUCOSE_DERIVED_METRICS,
  GLUCOSE_TARGET_HIGH_MGDL,
  GLUCOSE_TARGET_LOW_MGDL,
} from "@/lib/glucose-trace";
import { READING_IDENTITY_MAP } from "@/lib/reading-identity-map";
import { frameUnstatedNames } from "@/lib/patient-state-qualifiers";
import canonicalSeed from "@/lib/canonical-result-definitions.json";
import { normalizeCanonicalKey } from "@/lib/canonical-name";

// The pure half of the continuous-glucose trace (#2810), and the naming ruling that
// decides where its derivations may NOT be registered.

describe("deriveGlucoseDay", () => {
  const at = (mgdl: number, i: number) => ({
    ts: `2026-08-19T${String(Math.floor(i / 12)).padStart(2, "0")}:${String(
      (i % 12) * 5
    ).padStart(2, "0")}:00Z`,
    mgdl,
  });

  it("is null for a day the sensor did not cover — never a zeroed summary", () => {
    // 0% time-in-range would read as "spent the whole day out of range", which is a
    // claim about a day nobody measured.
    expect(deriveGlucoseDay([])).toBeNull();
  });

  it("means the day and counts its points", () => {
    const day = deriveGlucoseDay([at(100, 0), at(120, 1), at(140, 2)]);
    expect(day).toEqual({ meanMgdl: 120, timeInRangePct: 100, points: 3 });
  });

  it("counts the target range inclusively at both ends", () => {
    const edges = [
      at(GLUCOSE_TARGET_LOW_MGDL, 0),
      at(GLUCOSE_TARGET_HIGH_MGDL, 1),
    ];
    expect(deriveGlucoseDay(edges)?.timeInRangePct).toBe(100);
    // One tick outside either edge is out of range, which is what makes the
    // inclusive boundary a real decision rather than a rounding artifact.
    expect(
      deriveGlucoseDay([at(GLUCOSE_TARGET_LOW_MGDL - 1, 0)])?.timeInRangePct
    ).toBe(0);
    expect(
      deriveGlucoseDay([at(GLUCOSE_TARGET_HIGH_MGDL + 1, 0)])?.timeInRangePct
    ).toBe(0);
  });

  it("puts a hypo and a hyper on the same side of the fraction", () => {
    // Time-in-range is a single number about being INSIDE the target; a low counts
    // against it exactly as a high does. Two of four points in range → 50%.
    const day = deriveGlucoseDay([
      at(55, 0),
      at(90, 1),
      at(140, 2),
      at(260, 3),
    ]);
    expect(day).toEqual({ meanMgdl: 136.3, timeInRangePct: 50, points: 4 });
  });

  it("rounds to one decimal so an idempotent recompute is not an update", () => {
    // 1/3 of the day in range is 33.333…; a stored float tail would make the next
    // recompute compare unequal and count as a write forever.
    const day = deriveGlucoseDay([at(100, 0), at(200, 1), at(201, 2)]);
    expect(day?.timeInRangePct).toBe(33.3);
    expect(day?.meanMgdl).toBe(167);
  });
});

describe("the canonical-name ruling (#2337/#2799/#2810)", () => {
  const streamKeys = new Set(
    READING_IDENTITY_MAP.flatMap((e) => (e.stream ? [e.stream.key] : []))
  );

  it("registers no glucose derivation as a Reading stream", () => {
    // The derivations are summaries OF a trace, not readings of an analyte. A
    // stream registration would give one of them a canonical identity, and the only
    // identity on offer is the band-less `Glucose` — see the general guard below.
    for (const metric of GLUCOSE_DERIVED_METRICS) {
      expect(streamKeys.has(metric), metric).toBe(false);
    }
  });

  it("registers no frame-unstated analyte as a Reading stream at all", () => {
    // THE GENERAL FORM OF THE RULING. #2337 ruled `Glucose` band-less because the
    // draw's fasting frame was never stated, and #2799 added `frameUnstatedNames`
    // so a CMP's printed 65-99 could not re-commit that frame — the note there
    // names "a CGM stream lighting up wholesale" as the failure being avoided.
    // Registering a continuous stream under such a name folds a trace into the same
    // identity as a qualified draw and hands that argument back from the other end.
    //
    // Derived from the live catalog, so coining a fourth frame pair needs no edit
    // here: today the set is Glucose / Insulin / Cortisol.
    const frameUnstated = frameUnstatedNames(
      (canonicalSeed as { definitions: { name: string }[] }).definitions.map(
        (d) => d.name
      )
    );
    expect(frameUnstated.size).toBeGreaterThan(0);
    for (const entry of READING_IDENTITY_MAP) {
      if (!entry.stream) continue;
      expect(
        frameUnstated.has(normalizeCanonicalKey(entry.canonical)),
        `${entry.canonical} is band-less because its frame was never stated — a ` +
          `stream may not be registered under it (#2810)`
      ).toBe(false);
    }
  });
});

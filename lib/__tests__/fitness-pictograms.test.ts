// Battery ⇆ pictogram totality (#1253, the prefix-registry pattern): every fitness
// battery test key (adult AND senior variants) resolves to its own pictogram — a new
// test can't ship icon-less — and every non-fallback pictogram key is a battery key —
// a dead key can't linger. An unknown/future key resolves to the neutral fallback,
// never a crash. Domain glyphs cover every FitnessDomain the battery uses.
import { describe, expect, it } from "vitest";
import {
  FITNESS_BATTERY,
  batteryForAge,
  type FitnessDomain,
} from "@/lib/fitness-battery";
import {
  FITNESS_DOMAIN_GLYPH_PATHS,
  FITNESS_PICTOGRAM_PATHS,
  resolveFitnessPictogram,
} from "@/lib/fitness-pictograms";

// A stroked path: starts with a moveto and uses only path-data characters.
const PATH_D = /^M[0-9. ,LHVACQZlhvacqz-]+$/i;

describe("fitness pictograms (#1253)", () => {
  it("every battery test key (adult + senior) resolves to its own pictogram", () => {
    for (const t of FITNESS_BATTERY) {
      expect(resolveFitnessPictogram(t.key), t.key).toBe(t.key);
      const paths = FITNESS_PICTOGRAM_PATHS[resolveFitnessPictogram(t.key)];
      expect(paths.length, t.key).toBeGreaterThan(0);
    }
    // Both age-band variants are covered (batteryForAge slices FITNESS_BATTERY,
    // but pin it explicitly so a future variant-only source can't dodge the test).
    for (const t of [...batteryForAge(40), ...batteryForAge(75)]) {
      expect(resolveFitnessPictogram(t.key)).toBe(t.key);
    }
  });

  it("no dead pictogram keys: every non-fallback key is a battery test key", () => {
    const batteryKeys = new Set(FITNESS_BATTERY.map((t) => t.key));
    for (const key of Object.keys(FITNESS_PICTOGRAM_PATHS)) {
      if (key === "fallback") continue;
      expect(batteryKeys.has(key), key).toBe(true);
    }
  });

  it("an unknown or future test key falls back to the neutral figure", () => {
    expect(resolveFitnessPictogram("some-future-test")).toBe("fallback");
    expect(resolveFitnessPictogram("")).toBe("fallback");
    // "fallback" is not a battery key; resolving it stays on the fallback figure.
    expect(resolveFitnessPictogram("fallback")).toBe("fallback");
    expect(
      FITNESS_PICTOGRAM_PATHS[resolveFitnessPictogram("some-future-test")]
        .length
    ).toBeGreaterThan(0);
  });

  it("every battery domain has a glyph", () => {
    const domains = new Set<FitnessDomain>(
      FITNESS_BATTERY.map((t) => t.domain)
    );
    for (const d of domains) {
      expect(FITNESS_DOMAIN_GLYPH_PATHS[d]?.length, d).toBeGreaterThan(0);
    }
  });

  it("all path data is well-formed stroke path syntax", () => {
    const all = [
      ...Object.values(FITNESS_PICTOGRAM_PATHS).flat(),
      ...Object.values(FITNESS_DOMAIN_GLYPH_PATHS).flat(),
    ];
    for (const d of all) expect(d, d).toMatch(PATH_D);
  });
});

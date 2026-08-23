import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHANGE_DETECTION_DOMAIN_CENSUS,
  CHANGE_DETECTION_KIND_REGISTRY,
  CHANGE_DETECTION_KINDS,
} from "../change-detection";
import { isArguedExclusion, LOGGABLE_DOMAINS } from "../loggable-domains";

describe("change-detection registry (#3397)", () => {
  const ownsExport = (module: string, symbol: string): boolean =>
    new RegExp(
      `export\\s+(?:async\\s+)?(?:function|const)\\s+${symbol}\\b`
    ).test(readFileSync(resolve(module), "utf8"));

  it("declares all five kinds with real exported owners and surfaces", () => {
    expect(Object.keys(CHANGE_DETECTION_KIND_REGISTRY)).toEqual([
      ...CHANGE_DETECTION_KINDS,
    ]);
    for (const declaration of Object.values(CHANGE_DETECTION_KIND_REGISTRY)) {
      expect(existsSync(resolve(declaration.ownerModule))).toBe(true);
      expect(
        ownsExport(declaration.ownerModule, declaration.ownerSymbol),
        `${declaration.ownerModule} must export ${declaration.ownerSymbol}`
      ).toBe(true);
      expect(declaration.surfaces.length).toBeGreaterThan(0);
    }
  });

  it("every existing loggable domain declares detection or argues absence", () => {
    expect(Object.keys(CHANGE_DETECTION_DOMAIN_CENSUS).sort()).toEqual(
      [...LOGGABLE_DOMAINS].sort()
    );
    for (const domain of LOGGABLE_DOMAINS) {
      const declaration = CHANGE_DETECTION_DOMAIN_CENSUS[domain];
      if (isArguedExclusion(declaration)) {
        expect(declaration.reason.trim().length, domain).toBeGreaterThan(0);
        continue;
      }
      expect(declaration.detectors.length, domain).toBeGreaterThan(0);
      for (const detector of declaration.detectors) {
        expect(CHANGE_DETECTION_KINDS).toContain(detector.kind);
        expect(detector.scope.trim().length, domain).toBeGreaterThan(0);
        expect(detector.surfaces.length, domain).toBeGreaterThan(0);
        expect(
          ownsExport(detector.ownerModule, detector.ownerSymbol),
          `${domain}: ${detector.ownerModule} must export ${detector.ownerSymbol}`
        ).toBe(true);
      }
      for (const exclusion of "exclusions" in declaration
        ? declaration.exclusions
        : []) {
        expect(CHANGE_DETECTION_KINDS).toContain(exclusion.kind);
        expect(exclusion.scope.trim().length, domain).toBeGreaterThan(0);
        expect(exclusion.reason.trim().length, domain).toBeGreaterThan(0);
      }
    }
  });

  it("states the narrow dormancy and reachable-production boundaries", () => {
    const vitals = CHANGE_DETECTION_DOMAIN_CENSUS.vitals;
    expect(
      vitals.detectors.find((entry) => entry.kind === "pipeline-silence")?.scope
    ).toBe("Blood pressure and resting heart rate only");
    expect(
      CHANGE_DETECTION_DOMAIN_CENSUS.temperature.detectors.map(
        (entry) => entry.kind
      )
    ).not.toContain("pipeline-silence");
    expect(
      CHANGE_DETECTION_DOMAIN_CENSUS.temperature.exclusions
    ).toContainEqual(expect.objectContaining({ kind: "pipeline-silence" }));
    const substance = CHANGE_DETECTION_DOMAIN_CENSUS.substance;
    expect(isArguedExclusion(substance)).toBe(true);
    expect(substance.reason).toContain("cap-direction");
    expect(substance.reason).toContain("floor-direction");
  });
});

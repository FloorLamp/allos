import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHANGE_DETECTION_DOMAIN_CENSUS,
  CHANGE_DETECTION_KIND_REGISTRY,
  CHANGE_DETECTION_KINDS,
} from "../change-detection";
import { isArguedExclusion, LOGGABLE_DOMAINS } from "../loggable-domains";

describe("change-detection registry (#3397)", () => {
  it("declares all five kinds with real owners and surfaces", () => {
    expect(Object.keys(CHANGE_DETECTION_KIND_REGISTRY)).toEqual([
      ...CHANGE_DETECTION_KINDS,
    ]);
    for (const declaration of Object.values(CHANGE_DETECTION_KIND_REGISTRY)) {
      expect(existsSync(resolve(declaration.ownerModule))).toBe(true);
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
      expect(declaration.kinds.length, domain).toBeGreaterThan(0);
      expect(declaration.ownerModules.length, domain).toBeGreaterThan(0);
      expect(declaration.surfaces.length, domain).toBeGreaterThan(0);
      for (const owner of declaration.ownerModules) {
        expect(existsSync(resolve(owner)), `${domain}: ${owner}`).toBe(true);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMetsDataset } from "@/scripts/gen-mets";
import { CARDIO_ACTIVITIES, SPORTS } from "@/lib/activities-catalog";
import metsJson from "@/lib/mets.json";
import { metsForActivity } from "@/lib/calorie-estimate";

// Anti-drift pins for the baked MET dataset (issue #151): the committed lib/mets.json
// must be a FIXED POINT of the generator, every catalog activity must resolve a MET
// value, and the tier structure the estimator relies on must hold. Pure — reads the
// generator constants + the committed JSON, no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/mets.json");

describe("mets.json dataset", () => {
  it("is a fixed point of buildMetsDataset() (regenerate with `npm run gen:mets`)", () => {
    const generated = JSON.stringify(buildMetsDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("carries the tiered structure the estimator reads", () => {
    expect(metsJson.defaultTier).toBe("moderate");
    for (const type of ["strength", "cardio", "sport"] as const) {
      const def = metsJson.typeDefaults[type];
      expect(def).toBeTruthy();
      // Tiers are ordered easy ≤ moderate ≤ hard and positive.
      expect(def.easy).toBeGreaterThan(0);
      expect(def.easy).toBeLessThanOrEqual(def.moderate);
      expect(def.moderate).toBeLessThanOrEqual(def.hard);
    }
  });

  it("gives every per-activity entry a positive, monotone easy≤moderate≤hard MET", () => {
    for (const [name, tiers] of Object.entries(metsJson.activities)) {
      expect(tiers.easy, name).toBeGreaterThan(0);
      expect(tiers.easy, name).toBeLessThanOrEqual(tiers.moderate);
      expect(tiers.moderate, name).toBeLessThanOrEqual(tiers.hard);
    }
  });

  it("resolves a MET tier for EVERY catalog cardio activity and sport", () => {
    // A catalog name resolves either to its own dataset entry or, as a documented
    // fallback, to the per-type default — never to null. This is the anti-drift pin:
    // a NEW catalog activity added without a MET entry still resolves (via default),
    // but the coverage assertion below flags names missing a dedicated tier so the
    // reviewer can decide whether it deserves its own compendium value.
    for (const name of CARDIO_ACTIVITIES) {
      expect(metsForActivity(name, "cardio", "moderate"), name).toBeGreaterThan(
        0
      );
    }
    for (const name of SPORTS) {
      expect(metsForActivity(name, "sport", "moderate"), name).toBeGreaterThan(
        0
      );
    }
  });

  it("gives every catalog cardio activity and sport its OWN dedicated MET entry", () => {
    // Stronger anti-drift: the curated tables must cover the whole catalog by name,
    // not lean on the per-type default. If this fails after adding a catalog
    // activity, add its compendium MET row to scripts/gen-mets.ts and regenerate.
    const named = new Set(Object.keys(metsJson.activities));
    const missing = [...CARDIO_ACTIVITIES, ...SPORTS].filter(
      (n) => !named.has(n)
    );
    expect(
      missing,
      `catalog activities missing a MET entry: ${missing}`
    ).toEqual([]);
  });
});

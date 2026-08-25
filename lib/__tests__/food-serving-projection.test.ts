import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyFoodServingPlacements } from "@/lib/food-serving-projection";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("applyFoodServingPlacements", () => {
  it("publishes both halves of a same-group meal correction as one projection", () => {
    const projected = applyFoodServingPlacements(
      {
        "2026-08-24": { nuts_seeds: 1, berries: 2 },
      },
      {
        "2026-08-24": {
          Morning: { nuts_seeds: 1, berries: 1 },
          Midday: { berries: 1 },
          Evening: {},
        },
      },
      [
        {
          date: "2026-08-24",
          groupKey: "nuts_seeds",
          mealSlot: "Morning",
          servings: 1,
          mealServings: 0,
        },
        {
          date: "2026-08-24",
          groupKey: "nuts_seeds",
          mealSlot: "Evening",
          servings: 1,
          mealServings: 1,
        },
      ]
    );

    expect(projected.countsByDate["2026-08-24"]).toEqual({
      nuts_seeds: 1,
      berries: 2,
    });
    expect(projected.slotCountsByDate["2026-08-24"]).toEqual({
      Morning: { nuts_seeds: 0, berries: 1 },
      Midday: { berries: 1 },
      Evening: { nuts_seeds: 1 },
    });
  });

  it("keeps browser projection publication on one provider state boundary", () => {
    const provider = readFileSync(
      `${ROOT}/app/(app)/nutrition/FoodSuggestionsLayout.tsx`,
      "utf8"
    );
    const bar = readFileSync(
      `${ROOT}/app/(app)/nutrition/FoodLogBar.tsx`,
      "utf8"
    );

    expect(provider).toContain("useState<FoodProjectionState>");
    expect(provider).not.toContain("setCountsByDate");
    expect(provider).not.toContain("setSlotCountsByDate");
    expect(provider.match(/key=\{activeProfileId/g)).toHaveLength(2);
    expect(bar).toContain("setProjection(next)");
    expect(bar).not.toContain("setCountsByDate");
    expect(bar).not.toContain("setSlotCountsByDate");
  });

  it("stamps every food interaction receipt with its captured profile generation", () => {
    const bar = readFileSync(
      `${ROOT}/app/(app)/nutrition/FoodLogBar.tsx`,
      "utf8"
    );
    const watcher = readFileSync(
      `${ROOT}/components/ProfileSwitchWatcher.tsx`,
      "utf8"
    );

    // Correction, precise removal, serving add/undo, and "usual" each capture
    // the canonical root-toast scope before their first await.
    expect(bar.match(/const noticeScope = receiptProfileScope;/g)).toHaveLength(
      4
    );
    // One direct call is allowed: the helper itself. Every health notice goes
    // through profileToast, whose final properties cannot be overridden by a
    // caller-supplied options object.
    expect(bar.match(/\btoast\(/g)).toHaveLength(1);
    expect(bar).toMatch(
      /toast\(message, \{\s*\.\.\.options,\s*profileId: scope\.profileId,\s*profileToken: scope\.token,/s
    );
    expect(bar).toContain("offerEndFast(noticeScope, outcome.endFastOffer)");
    expect(bar).toContain("offerEndFast(noticeScope, result.endFastOffer)");
    expect(bar).toContain("undoEnd(scope, undoFastId)");
    expect(watcher).toContain("useLayoutEffect(() => {");
    expect(watcher).not.toContain("useEffect(() => {");
  });
});

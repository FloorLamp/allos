import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FOOD_QUICK_COUNT } from "@/lib/food-rank";
import { renderFoodNudge } from "@/lib/notifications/food-format";
import { FOOD_GROUPS } from "@/lib/food-groups";

// ONE constant decides how many food affordances are FAST (issue #2225).
//
// The web log bar and the Telegram nudge draw their quick set from the same ranking and
// used to slice it with two separate 6s — `QUICK_GROUP_COUNT` in FoodLogBar.tsx and
// `FOOD_NUDGE_BUTTON_COUNT` in food-format.ts — which agreed only by coincidence. They
// now share `FOOD_QUICK_COUNT`, exported from lib/food-rank beside the ranking whose
// head it takes.
//
// There is deliberately NO shared slice FUNCTION to test: the two surfaces legitimately
// differ on the protein entry (getFoodBarOrder strips `__protein__` out of `groups` and
// returns its position separately, so the page shows six food groups plus a stepper;
// the nudge leaves it in `rankedKeys` where it consumes one of the six keyboard slots).
// The count is the seam, so the count is what this pins — plus a source scan proving
// neither surface has quietly grown a second one back.
//
// Same source-scan idiom as `telegram-chokepoint.test.ts` and
// `icon-button-tooltip-scan.test.ts`: the app's own source read as TEXT, no DB and no
// network, so it stays pure in the vitest sense.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BAR = path.join(REPO, "app/(app)/nutrition/FoodLogBar.tsx");
const NUDGE = path.join(REPO, "lib/notifications/food-format.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("FOOD_QUICK_COUNT", () => {
  it("is the even, small head of the ranking both surfaces slice", () => {
    expect(FOOD_QUICK_COUNT).toBe(6);
    // The nudge lays two buttons per keyboard row, so an odd count would leave a ragged
    // last row — and the same number is the progressive-expansion page size (#1075).
    expect(FOOD_QUICK_COUNT % 2).toBe(0);
    expect(FOOD_QUICK_COUNT).toBeLessThan(FOOD_GROUPS.length);
  });

  it("is the nudge's default visible count", () => {
    const ranked = FOOD_GROUPS.map((g) => g.slug);
    const msg = renderFoodNudge(1, "Midday", "2026-08-08", ranked, new Map());
    const logButtons = (msg.actions ?? []).filter((a) =>
      (a.data ?? "").startsWith("food:")
    );
    expect(logButtons).toHaveLength(FOOD_QUICK_COUNT);
    expect(logButtons.map((a) => (a.data ?? "").split(":").at(-1))).toEqual(
      ranked.slice(0, FOOD_QUICK_COUNT)
    );
  });

  it("is the only quick count either surface declares", () => {
    for (const file of [BAR, NUDGE]) {
      const src = read(file);
      expect(src).toContain("FOOD_QUICK_COUNT");
      // No surface-local redeclaration of the count under any name.
      expect(src).not.toMatch(
        /^\s*(export\s+)?const\s+\w*(QUICK|BUTTON)\w*(COUNT|_COUNT)\s*(:[^=]+)?=\s*\d/m
      );
    }
    // Both import it from the ranking module rather than from each other.
    expect(read(BAR)).toMatch(
      /import\s*\{[^}]*FOOD_QUICK_COUNT[^}]*\}\s*from\s*"@\/lib\/food-rank"/
    );
    expect(read(NUDGE)).toMatch(
      /import\s*\{[^}]*FOOD_QUICK_COUNT[^}]*\}\s*from\s*"\.\.\/food-rank"/
    );
  });

  it("selects the bar's quick rows by RANK alone — no tier quota (#2225)", () => {
    const src = read(BAR);
    // The deleted quota, by name and by shape. `TIER_ORDER`/`TIER_LABEL`/
    // `TIER_BADGE_CLASS` all keep their presentation consumers (the per-row badge and
    // the tier-sectioned overflow), so this asserts the SELECTION is gone, not the
    // vocabulary.
    expect(src).not.toContain("QUICK_TIER_SEQUENCE");
    expect(src).not.toContain("QUICK_GROUP_COUNT");
    expect(src).toContain("TIER_LABEL");
    // The quick set is a plain slice of the frozen ranked order.
    expect(src).toMatch(/\.slice\(0,\s*FOOD_QUICK_COUNT\)/);
    // The slot-`logged` pre-sort that existed only to feed the quota is gone with it —
    // `rankFoodGroups` already carries a slot signal (#2019 proximity weighting), and a
    // second derivation of that question is the #221 duplication the unification removed.
    expect(src).not.toMatch(/Number\(b\.logged\)/);
  });
});

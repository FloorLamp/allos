// Pre-generate the curated food-group catalog (lib/food-groups.json) that the
// food-group serving log (issue #579) logs against — the INPUT half of the nutrition
// umbrella (#576). ~24 groups at the HABIT tier (a serving, one tap) rather than macros:
// the granularity dietary evidence actually lives at ("2 servings of fatty fish a
// week"), sufficient for every output feature (#577 suggestions, #580 habit targets)
// and cheap to log.
//
// Mirrors the gen-mets.ts / gen-dri.ts committed-and-human-reviewable convention: the
// JSON is COMMITTED, the values are curated dietary facts, no API key needed —
//
//   npm run gen:food-groups
//
// Each group carries a STABLE slug (the #203 discipline: a rename is display-only, the
// slug never changes — food_log.group_key and any target/dismissal keyed on it depend
// on it), a display name, a serving description, a `tier` (`encourage` — foods dietary
// guidance says to eat more of; `limit` — eat less of; `neutral`), and the `nutrients`
// it's a meaningful source of (keyed to the #577 nutrient-food-map entry keys). The
// nutrient links are the join the food engine (#577) and habit targets (#580) consume.
//
// Anti-drift: the committed JSON is a FIXED POINT of buildFoodGroups(), and every slug
// / nutrient link is pinned by lib/__tests__/food-groups-dataset.test.ts — including
// the CROSS-REFERENCE that every foodGroup slug the #577 map references resolves here,
// and every nutrient a group links resolves to a #577 map entry.

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "lib", "food-groups.json");

export type FoodGroupTier = "encourage" | "limit" | "neutral";

export interface FoodGroup {
  // Stable slug — food_log.group_key. NEVER changes once shipped (renames are display
  // only). Lowercase snake_case.
  slug: string;
  // Display name for the log button / rollup label.
  name: string;
  // What one serving looks like — the one-tap unit.
  serving: string;
  tier: FoodGroupTier;
  // The #577 nutrient-food-map entry keys this group is a meaningful source of
  // (`omega-3`, `iron`, `folate`, `magnesium`, `potassium`, `vitamin-d`, `vitamin-b12`).
  // Empty for a group that isn't a notable source of a tracked nutrient.
  nutrients: string[];
}

// Curated food-group catalog. Ordered encourage-first (the foods to eat more of lead
// the log), then neutral, then limit. Public, evidence-shaped dietary groups.
const GROUPS: FoodGroup[] = [
  // ── Encourage ────────────────────────────────────────────────────────────
  {
    slug: "fatty_fish",
    name: "Fatty fish",
    serving:
      "A palm-sized fillet (~4 oz) of salmon, sardines, mackerel, herring",
    tier: "encourage",
    nutrients: ["omega-3", "vitamin-d", "vitamin-b12"],
  },
  {
    slug: "lean_fish",
    name: "White / lean fish",
    serving: "A palm-sized fillet (~4 oz) of cod, tilapia, haddock",
    tier: "encourage",
    nutrients: ["vitamin-b12"],
  },
  {
    slug: "shellfish",
    name: "Shellfish",
    serving: "~3 oz of shrimp, clams, mussels, oysters",
    tier: "encourage",
    nutrients: ["iron", "vitamin-b12", "omega-3"],
  },
  {
    slug: "leafy_greens",
    name: "Leafy greens",
    serving: "A cup of raw (or ½ cup cooked) spinach, kale, chard, romaine",
    tier: "encourage",
    nutrients: ["folate", "potassium", "iron"],
  },
  {
    slug: "cruciferous",
    name: "Cruciferous vegetables",
    serving: "½ cup of broccoli, cauliflower, Brussels sprouts, cabbage",
    tier: "encourage",
    nutrients: ["folate"],
  },
  {
    slug: "other_vegetables",
    name: "Other vegetables",
    serving: "½ cup of peppers, carrots, tomatoes, squash",
    tier: "encourage",
    nutrients: ["potassium"],
  },
  {
    slug: "legumes",
    name: "Legumes & beans",
    serving: "½ cup of cooked lentils, chickpeas, black beans, tofu",
    tier: "encourage",
    nutrients: ["iron", "folate", "magnesium", "potassium"],
  },
  {
    slug: "nuts_seeds",
    name: "Nuts & seeds",
    serving: "A small handful (~1 oz) of almonds, walnuts, pumpkin seeds, chia",
    tier: "encourage",
    nutrients: ["magnesium", "omega-3"],
  },
  {
    slug: "whole_grains",
    name: "Whole grains",
    serving: "½ cup of cooked oats, brown rice, quinoa, whole-grain bread",
    tier: "encourage",
    nutrients: ["magnesium"],
  },
  {
    slug: "fruit",
    name: "Fruit",
    serving: "One piece or ~½ cup of whole fruit",
    tier: "encourage",
    nutrients: ["potassium"],
  },
  {
    slug: "berries",
    name: "Berries",
    serving: "½ cup of blueberries, strawberries, raspberries",
    tier: "encourage",
    nutrients: [],
  },
  {
    slug: "fermented",
    name: "Fermented foods",
    serving: "A serving of yogurt, kefir, sauerkraut, kimchi, miso",
    tier: "encourage",
    nutrients: ["vitamin-b12"],
  },
  // ── Neutral / balance ──────────────────────────────────────────────────────
  {
    slug: "poultry",
    name: "Poultry",
    serving: "A palm-sized portion (~4 oz) of chicken or turkey",
    tier: "neutral",
    nutrients: ["vitamin-b12"],
  },
  {
    slug: "eggs",
    name: "Eggs",
    serving: "One to two eggs",
    tier: "neutral",
    nutrients: ["vitamin-b12", "vitamin-d"],
  },
  {
    slug: "dairy",
    name: "Dairy",
    serving: "A cup of milk, a slice of cheese, ¾ cup of yogurt",
    tier: "neutral",
    nutrients: ["vitamin-b12", "vitamin-d"],
  },
  {
    slug: "red_meat",
    name: "Red meat",
    serving: "A palm-sized portion (~4 oz) of beef, pork, lamb",
    tier: "neutral",
    nutrients: ["iron", "vitamin-b12"],
  },
  {
    slug: "tubers",
    name: "Potatoes & starchy veg",
    serving: "One medium potato or ½ cup of sweet potato, corn, peas",
    tier: "neutral",
    nutrients: ["potassium"],
  },
  {
    slug: "water",
    name: "Water",
    serving: "A glass (~8 oz) of water or unsweetened drink",
    tier: "neutral",
    nutrients: [],
  },
  // ── Limit ────────────────────────────────────────────────────────────────
  {
    slug: "processed_meat",
    name: "Processed meat",
    serving: "A serving of bacon, sausage, deli meat, hot dogs",
    tier: "limit",
    nutrients: [],
  },
  {
    slug: "refined_grains",
    name: "Refined grains",
    serving: "A serving of white bread, white rice, pasta, crackers",
    tier: "limit",
    nutrients: [],
  },
  {
    slug: "fried_food",
    name: "Fried / fast food",
    serving: "A serving of fried or fast food",
    tier: "limit",
    nutrients: [],
  },
  {
    slug: "added_sugar",
    name: "Sugary foods & desserts",
    serving: "A dessert, candy, or sweetened snack",
    tier: "limit",
    nutrients: [],
  },
  {
    slug: "sugary_drinks",
    name: "Sugar-sweetened drinks",
    serving: "A soda, juice drink, or sweetened coffee/tea",
    tier: "limit",
    nutrients: [],
  },
  {
    slug: "alcohol",
    name: "Alcohol",
    serving: "One standard drink (12 oz beer, 5 oz wine, 1.5 oz spirits)",
    tier: "limit",
    nutrients: [],
  },
];

export interface FoodGroupsDataset {
  $comment: string;
  groups: FoodGroup[];
}

// Pure builder: the committed lib/food-groups.json is a FIXED POINT of this.
export function buildFoodGroups(): FoodGroupsDataset {
  return {
    $comment:
      "Curated food-group catalog for the serving log (issue #579): ~24 groups at the " +
      "habit tier (one serving = one tap), each with a stable slug (food_log.group_key), " +
      "a serving description, a tier (encourage/limit/neutral), and the #577 nutrient-" +
      "food-map keys it's a source of. Committed + HUMAN-REVIEWABLE. Regenerate with " +
      "`npm run gen:food-groups`. INFORMATIONAL dietary guidance, NOT medical advice.",
    groups: GROUPS,
  };
}

function writeDataset(): void {
  const dataset = buildFoodGroups();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  console.log(`Wrote ${dataset.groups.length} food groups to ${OUT}`);
  console.log("Review the group list + serving sizes before committing.");
}

// CLI-only guard (the fixed-point test imports buildFoodGroups without writing).
if (process.argv[1]?.includes("gen-food-groups")) {
  writeDataset();
}

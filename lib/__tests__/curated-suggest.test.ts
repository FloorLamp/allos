import { describe, it, expect } from "vitest";
import {
  suggestCurated,
  isLowFlag,
  isHighFlag,
  type CuratedEntry,
} from "@/lib/curated-suggest";
import { suggestFoods } from "@/lib/food-suggest";
import { suggestCuratedSupplements } from "@/lib/supplement-suggest-curated";
import { NUTRIENT_FOOD_ENTRIES } from "@/lib/datasets/nutrient-food-map";
import { BIOMARKER_SUPPLEMENT_ENTRIES } from "@/lib/datasets/biomarker-supplement-map";

// Pure-tier tests for THE curated-suggestion engine (issue #5173) — the one loop and one
// screen behind lib/food-suggest.ts (#577) and lib/supplement-suggest-curated.ts (#2378).
// No DB, no network, no model.
//
// The per-map behaviour is already pinned by food-suggest.test.ts and
// supplement-suggest-curated.test.ts; this file pins only what the two now SHARE, and
// that each declared extra belongs to exactly one of them.

const EMPTY = {
  allergens: [],
  medications: [],
  conditions: [],
  situations: [],
};

// Every canonical biomarker name BOTH maps answer, with the side each declares. The two
// tables agree on direction for every shared name today; a future disagreement is a real
// finding, not a test to relax.
const SHARED: { name: string; side: "low" | "high" }[] = [];
for (const supp of BIOMARKER_SUPPLEMENT_ENTRIES) {
  for (const name of supp.biomarkers) {
    const food = NUTRIENT_FOOD_ENTRIES.find((f) =>
      f.biomarkers.some((b) => b.toLowerCase() === name.toLowerCase())
    );
    if (!food || food.direction !== supp.direction) continue;
    SHARED.push({ name, side: supp.direction });
  }
}

describe("the two wrappers are the same engine", () => {
  it("covers enough shared names to be worth asserting", () => {
    expect(SHARED.length).toBeGreaterThanOrEqual(5);
  });

  it("selects the same entries, by the same rule, from each table", () => {
    // THE selection the two wrappers share: every entry whose declared biomarkers name
    // this reading AND whose declared direction is the side it is flagged on, in table
    // order, citing the reading's OWN spelling. Computed here off the raw tables and
    // asserted against BOTH wrappers — the keys differ between the maps (the food side
    // spells the #2754 route `soluble-fiber`, the supplement side `lipids`), the rule
    // does not.
    for (const { name, side } of SHARED) {
      const flagged = [{ name, flag: side }];
      const lower = name.toLowerCase();
      const wantFood = NUTRIENT_FOOD_ENTRIES.filter(
        (e) =>
          e.direction === side &&
          e.biomarkers.some((b) => b.toLowerCase() === lower)
      ).map((e) => e.key);
      const wantSupp = BIOMARKER_SUPPLEMENT_ENTRIES.filter(
        (e) =>
          e.direction === side &&
          e.biomarkers.some((b) => b.toLowerCase() === lower)
      ).map((e) => e.key);

      const foods = suggestFoods({ flagged, ...EMPTY }).filter(
        (f) => f.direction === "add"
      );
      const supps = suggestCuratedSupplements({ flagged, ...EMPTY });
      expect(foods.map((f) => f.key)).toEqual(wantFood);
      expect(supps.map((s) => s.key)).toEqual(wantSupp);
      // Same reason, same declared trigger side, on both.
      for (const s of [...foods, ...supps]) {
        expect(s.triggeredBy).toEqual([name]);
        expect(s.side).toBe(side);
      }
    }
  });

  it("both stay silent on the flag side neither entry declares", () => {
    for (const { name, side } of SHARED) {
      const other = side === "low" ? "high" : "low";
      const flagged = [{ name, flag: other }];
      const adds = suggestFoods({ flagged, ...EMPTY }).filter(
        (f) => f.direction === "add" && f.triggeredBy.includes(name)
      );
      expect(adds).toEqual([]);
      expect(suggestCuratedSupplements({ flagged, ...EMPTY })).toEqual([]);
    }
  });

  it("both normalise the reading's spelling identically", () => {
    const { name, side } = SHARED[0];
    const padded = [{ name: `  ${name.toUpperCase()}  `, flag: ` ${side} ` }];
    const plain = [{ name, flag: side }];
    // The engine matches case- and whitespace-insensitively and cites the reading's
    // OWN spelling back, on both sides.
    expect(
      suggestCuratedSupplements({ flagged: padded, ...EMPTY }).map(
        (s) => s.triggeredBy
      )
    ).toEqual([[`  ${name.toUpperCase()}  `]]);
    expect(
      suggestCuratedSupplements({ flagged: plain, ...EMPTY }).map((s) => s.key)
    ).toEqual(
      suggestCuratedSupplements({ flagged: padded, ...EMPTY }).map((s) => s.key)
    );
  });
});

describe("each declared extra belongs to exactly one declaration", () => {
  const LOW_OMEGA = [{ name: "Omega-3 Total (OmegaCheck)", flag: "low" }];

  it("alreadyTaking is the supplement declaration's — the food side has no such field", () => {
    const taking = { alreadyTaking: ["Fish oil 1000mg"] };
    expect(
      suggestCuratedSupplements({ flagged: LOW_OMEGA, ...EMPTY, ...taking })
    ).toEqual([]);
    // The food wrapper does not declare it, so the same profile still gets its food
    // answer — eating salmon and taking fish oil are different acts.
    expect(
      suggestFoods({ flagged: LOW_OMEGA, ...EMPTY }).map((f) => f.key)
    ).toContain("omega-3");
  });

  it("extraTriggers and reduceEntries are the food declaration's", () => {
    // A directly-named target (#2383) with NO flagged reading still yields a
    // suggestion on the food side; the supplement side has no second door.
    const out = suggestFoods({
      flagged: [],
      ...EMPTY,
      targets: [{ key: "fiber", direction: "add", reason: "12g of 30g" }],
    });
    expect(out.map((f) => f.key)).toEqual(["fiber"]);
    expect(out[0].triggeredBy).toEqual(["12g of 30g"]);
    // The #775 reduce table is reached by the same trigger match, one side only.
    const high = [{ name: "LDL Cholesterol", flag: "high" }];
    expect(
      suggestFoods({ flagged: high, ...EMPTY })
        .filter((f) => f.direction === "reduce")
        .map((f) => f.key)
    ).toEqual(["ldl-apob"]);
  });

  it("exclude is the food declaration's soft layer, never a withholding one", () => {
    const out = suggestFoods({
      flagged: LOW_OMEGA,
      ...EMPTY,
      excludedGroups: ["fatty_fish", "lean_fish", "shellfish"],
    });
    const omega = out.find((f) => f.key === "omega-3");
    // Filtered and substituted — never absent.
    expect(omega).toBeDefined();
    expect(omega!.foods.length).toBeGreaterThan(0);
    expect(omega!.safetyNotes.some((n) => n.kind === "preference")).toBe(true);
  });
});

describe("the engine itself, on a synthetic declaration", () => {
  // A minimal curated table: the engine's contract without either real dataset.
  interface Item {
    name: string;
    group: string;
    keys?: string[];
  }
  type Note = { kind: "condition" | "medication" | "allergy"; text: string };
  const entry: CuratedEntry<Item> & { label: string } = {
    key: "widget",
    label: "Widget",
    biomarkers: ["Widgetase"],
    direction: "low",
    items: [
      { name: "primary", group: "a", keys: ["k1"] },
      { name: "second", group: "b" },
    ],
    allergyAlternative: { name: "alt", group: "c" },
    contraindications: [
      { match: "bad thing", caution: "careful", severity: "drop" },
      { match: "mild thing", caution: "annotated" },
    ],
  };

  function run(
    opts: {
      flag?: string | null;
      conditions?: string[];
      situations?: string[];
      strike?: (item: Item) => boolean;
      advice?: string | null;
    } = {}
  ) {
    return suggestCurated<
      typeof entry,
      Item,
      { items: string[]; notes: Note[] },
      Note
    >(
      [
        {
          name: "Widgetase",
          flag: opts.flag === undefined ? "low" : opts.flag,
        },
      ],
      {
        entries: [entry],
        conditions: opts.conditions ?? [],
        situations: opts.situations ?? [],
        screenItem: (i) =>
          opts.strike?.(i) ? { field: "allergen", label: i.group } : null,
        struckNote: (strikes, allStruck) =>
          strikes.length === 0
            ? null
            : {
                kind: "allergy",
                text: `${allStruck ? "all" : "some"}:${strikes
                  .map((s) => s.label)
                  .join(",")}`,
              },
        drugKeys: (i) => i.keys,
        drugNoteScope: "entry",
        drugAdvice: () => opts.advice ?? null,
        note: (kind, text) => ({ kind, text }),
        finish: (_e, _t, rendered, notes) => ({
          items: rendered.map(
            (r) => `${r.item.name}${r.isAlternative ? "*" : ""}`
          ),
          notes,
        }),
      }
    );
  }

  it("selects on the DECLARED side and nothing else", () => {
    expect(run({ flag: "non-optimal-low" })).toHaveLength(1);
    expect(run({ flag: "high" })).toEqual([]);
    expect(run({ flag: "normal" })).toEqual([]);
    expect(run({ flag: null })).toEqual([]);
  });

  it("a drop-severity tag withholds the whole suggestion; a caution annotates it", () => {
    expect(run({ conditions: ["a bad thing here"] })).toEqual([]);
    expect(run({ situations: ["A BAD THING"] })).toEqual([]);
    const [out] = run({ conditions: ["mild thing"] });
    expect(out.notes).toEqual([{ kind: "condition", text: "annotated" }]);
  });

  it("screens, falls back to the alternative, then gives up — in that order", () => {
    const [partial] = run({ strike: (i) => i.name === "second" });
    expect(partial.items).toEqual(["primary"]);
    expect(partial.notes).toContainEqual({ kind: "allergy", text: "some:b" });

    const [all] = run({ strike: (i) => i.group !== "c" });
    expect(all.items).toEqual(["alt*"]);
    expect(all.notes).toContainEqual({ kind: "allergy", text: "all:a,b" });

    expect(run({ strike: () => true })).toEqual([]);
  });

  it("attaches one medication note per interaction key, deduped", () => {
    const [out] = run({ advice: "separate by four hours" });
    expect(
      out.notes.filter((n) => n.kind === "medication").map((n) => n.text)
    ).toEqual(["separate by four hours"]);
  });

  it("re-exports the flag sort both declarations select on", () => {
    expect(isLowFlag(" NON-OPTIMAL-LOW ")).toBe(true);
    expect(isHighFlag("abnormal")).toBe(true);
    expect(isLowFlag("abnormal")).toBe(false);
  });
});

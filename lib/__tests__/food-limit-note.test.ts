// PURE TIER — the curated limit direction at the log tap and in the digest (#2377).
// No DB, no clock.
//
// Three things are under test, and only the first is arithmetic.
//
//   1. THE RANKING AND THE GATES. One note per tap, the interaction always above the
//      dietary one, at most one per group per day, the dietary half only on the first
//      serving since the flag that motivates it, and silence for a cap-governed group.
//   2. #998. Nothing in the vocabulary reports a run, a pace, a to-go or a day "under"
//      a limit.
//   3. THE #2572 FIREWALL, which is a DOCTRINE constraint and therefore structural
//      rather than editorial. A biomarker may be named beside a SINGLE ACT (the #577
//      shape, shipped for years) and may never be named beside a COUNT OVER DAYS (the
//      juxtaposition #2397 forbids). The tap note is the first; the digest observation
//      is the second, and it has nowhere to put a result — pinned the same way
//      lib/__tests__/food-habit-observation.test.ts pins its twin.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FOOD_LIMIT_MAX_NAMED,
  activeFoodLimits,
  foodLimitDayObservations,
  foodLimitDigestHead,
  foodLimitNoteText,
  foodLimitTapNote,
  type ActiveFoodLimit,
  type DietaryLimitCandidate,
} from "@/lib/food-limit-note";
import { REDUCE_FOOD_ENTRIES, suggestFoods } from "@/lib/food-suggest";
import type { FoodDrugEventFinding } from "@/lib/food-drug-ledger";

// The engine's own output for a profile whose LDL reads high — the only door into the
// curated limits, so these tests exercise the real map rather than a fixture of it.
const ldlSuggestions = suggestFoods({
  flagged: [{ name: "LDL Cholesterol", flag: "high" }],
  allergens: [],
  medications: [],
  conditions: [],
  situations: [],
});

const LDL: ActiveFoodLimit = activeFoodLimits(ldlSuggestions)[0];

const armed = (limit: ActiveFoodLimit): DietaryLimitCandidate[] => [
  { limit, firstSinceActive: true },
];

// One food–drug EVENT finding, in the shape the #2021 ledger hands over. Only the
// fields the note reads are meaningful; the rest are the type's own minimum.
function interaction(
  groups: string[],
  opts: { itemName?: string; advice?: string } = {}
): FoodDrugEventFinding {
  return {
    dedupeKey: `food-drug-event:1:alcohol-metronidazole:2026-08-12`,
    itemId: 1,
    itemName: opts.itemName ?? "Flagyl",
    ruleId: "alcohol-metronidazole",
    date: "2026-08-12",
    groups,
    servings: 1,
    daysAfterCourse: 0,
    hit: {
      key: "alcohol-metronidazole",
      drugLabel: "Metronidazole",
      food: "Alcohol",
      severity: "major",
      advice:
        opts.advice ??
        "Avoid all alcohol during treatment and for 3 days after.",
      mechanism: "Disulfiram-like reaction.",
      source: "Test source",
      catalog: { groups, rule: "event", tailDays: 3 },
    },
  };
}

const tap = (over: Partial<Parameters<typeof foodLimitTapNote>[0]> = {}) =>
  foodLimitTapNote({
    groupKey: "fried_food",
    servingsBefore: 0,
    capGoverned: false,
    interactions: [],
    dietary: armed(LDL),
    ...over,
  });

describe("the curated limits come from the engine, never a second copy", () => {
  it("projects the reduce direction of a real engine run", () => {
    expect(LDL.key).toBe("ldl-apob");
    expect(LDL.dedupeKey).toBe("food-reduce:ldl-apob");
    expect(LDL.triggeredBy).toEqual(["LDL Cholesterol"]);
    // The loggable half only: the entry's foods that name a catalog group.
    expect(LDL.groupKeys).toEqual(["fried_food", "processed_meat"]);
  });

  it("drops an entry whose foods name no loggable group", () => {
    // A limit can only meet a log tap through a group the tap can name. Nothing in the
    // committed map is group-less today, so this is asserted on a synthetic suggestion
    // rather than by hoping one exists.
    expect(
      activeFoodLimits([
        {
          key: "x",
          label: "X",
          direction: "reduce",
          dedupeKey: "food-reduce:x",
          triggeredBy: ["Whatever"],
          foods: [
            {
              food: "Organ meats",
              foodGroup: null,
              serving: "",
              isAlternative: false,
            },
          ],
          evidence: "e",
          source: "s",
          caveat: null,
          safetyNotes: [],
        },
      ])
    ).toEqual([]);
  });

  it("ignores the ADD direction entirely", () => {
    const adds = suggestFoods({
      flagged: [{ name: "Vitamin D, 25-Hydroxy", flag: "low" }],
      allergens: [],
      medications: [],
      conditions: [],
      situations: [],
    });
    expect(adds.some((s) => s.direction === "add")).toBe(true);
    expect(activeFoodLimits(adds)).toEqual([]);
  });
});

describe("the tap note: ranking and the frequency gates (#2377)", () => {
  it("names the marker that selected the guidance, beside the ONE serving", () => {
    const note = tap();
    expect(note?.kind).toBe("dietary");
    expect(note?.title).toBe(
      "Fried / fast food: guidance for a high LDL Cholesterol lists it among the foods to limit."
    );
    // The clause that says out loud what the structural rule enforces.
    expect(note?.body).toContain("not a claim about this serving");
    expect(note?.body).toContain("Informational, not medical advice.");
    expect(note?.body).toContain("Source: ");
    expect(note?.hold).toBe(false);
  });

  it("is silent on every repeat serving that day — one note per group per day", () => {
    expect(tap({ servingsBefore: 1 })).toBeNull();
    expect(tap({ servingsBefore: 4 })).toBeNull();
    // Including for an interaction, which is per-DAY by its own dedupe granularity.
    expect(
      tap({ servingsBefore: 1, interactions: [interaction(["fried_food"])] })
    ).toBeNull();
  });

  it("is silent once the group has been logged since the flag — one per activation", () => {
    expect(
      tap({ dietary: [{ limit: LDL, firstSinceActive: false }] })
    ).toBeNull();
  });

  it("ranks an interaction above a dietary note and speaks in the ledger's own words", () => {
    const note = tap({ interactions: [interaction(["fried_food"])] });
    expect(note?.kind).toBe("interaction");
    // The finding's OWN title and detail — one computation moved to the moment, not a
    // second sentence about the same fact.
    expect(note?.title).toBe("Alcohol logged today while taking Flagyl");
    expect(note?.body).toContain(
      "Avoid all alcohol during treatment and for 3 days after."
    );
    // Distinct prominence, as a property of the claim rather than a per-surface choice.
    expect(note?.hold).toBe(true);
  });

  it("ignores an interaction that does not name the group being logged", () => {
    const note = tap({ interactions: [interaction(["leafy_greens"])] });
    expect(note?.kind).toBe("dietary");
  });

  it("stays silent for a cap-governed group — the cap vocabulary owns it (#998)", () => {
    expect(
      tap({ groupKey: "alcohol", capGoverned: true, dietary: armed(LDL) })
    ).toBeNull();
  });

  it("still speaks the INTERACTION for a cap-governed group", () => {
    // The cap-deferral clause is about the biomarker-motivated dietary claim. Alcohol +
    // metronidazole is the live case the whole ledger exists for; silencing it because
    // alcohol carries a cap would delete the feature's reason to exist.
    const note = tap({
      groupKey: "alcohol",
      capGoverned: true,
      dietary: [],
      interactions: [interaction(["alcohol"])],
    });
    expect(note?.kind).toBe("interaction");
  });

  it("says nothing when nothing applies — never an all-clear", () => {
    expect(tap({ dietary: [] })).toBeNull();
  });

  it("flattens to one string for a surface with one line to spend", () => {
    const note = tap()!;
    expect(foodLimitNoteText(note)).toBe(`${note.title} ${note.body}`);
  });
});

describe("the digest observation (#2377)", () => {
  const capNone = new Set<string>();

  it("names the day's logged groups that a live limit covers, in curated order", () => {
    expect(
      foodLimitDayObservations({
        loggedGroups: ["processed_meat", "berries", "fried_food"],
        limits: [LDL],
        capGoverned: capNone,
      }).map((o) => o.groupKey)
    ).toEqual(["fried_food", "processed_meat"]);
  });

  it("is empty when the day logged nothing the limits name", () => {
    expect(
      foodLimitDayObservations({
        loggedGroups: ["berries", "fatty_fish"],
        limits: [LDL],
        capGoverned: capNone,
      })
    ).toEqual([]);
  });

  it("drops a cap-governed group (#998)", () => {
    const urate = activeFoodLimits(
      suggestFoods({
        flagged: [{ name: "Uric Acid", flag: "high" }],
        allergens: [],
        medications: [],
        conditions: [],
        situations: [],
      })
    )[0];
    expect(urate.groupKeys).toContain("alcohol");
    expect(
      foodLimitDayObservations({
        loggedGroups: ["alcohol", "sugary_drinks"],
        limits: [urate],
        capGoverned: new Set(["alcohol"]),
      }).map((o) => o.groupKey)
    ).toEqual(["sugary_drinks"]);
  });

  it("caps how many it names, and drops the rest rather than counting them", () => {
    const many: ActiveFoodLimit = {
      ...LDL,
      groupKeys: [
        "fried_food",
        "processed_meat",
        "added_sugar",
        "sugary_drinks",
      ],
    };
    const out = foodLimitDayObservations({
      loggedGroups: many.groupKeys,
      limits: [many],
      capGoverned: capNone,
    });
    expect(out).toHaveLength(FOOD_LIMIT_MAX_NAMED);
    // "+1 more" would be a tally of the person's day, which this surface is bounded
    // against; the head says nothing about what was dropped.
    expect(foodLimitDigestHead(out)).not.toMatch(/more|\+|\d/);
  });

  it("states a membership, with no count, no marker and no verdict", () => {
    const head = foodLimitDigestHead(
      foodLimitDayObservations({
        loggedGroups: ["fried_food", "processed_meat"],
        limits: [LDL],
        capGoverned: capNone,
      })
    );
    expect(head).toBe(
      "Foods to limit, logged yesterday: fried / fast food and processed meat."
    );
  });

  it("is null for an empty intersection — silence, not a reassurance", () => {
    expect(foodLimitDigestHead([])).toBeNull();
  });
});

// ── #998: A LIMIT IS A CAP, AND A CAP HAS NO STREAK ─────────────────────────────

describe("nothing here reflects a limit back as a run (#998)", () => {
  const strings = [
    tap()!.title,
    tap()!.body,
    tap({ interactions: [interaction(["fried_food"])] })!.title,
    foodLimitDigestHead(
      foodLimitDayObservations({
        loggedGroups: ["fried_food"],
        limits: [LDL],
        capGoverned: new Set<string>(),
      })
    )!,
  ];

  it("never reports a streak, a run, a pace or a to-go", () => {
    for (const s of strings)
      expect(s.toLowerCase()).not.toMatch(
        /streak|in a row|day run|consecutive|to go|on pace|behind|ahead|under (?:your )?(?:cap|limit) for/
      );
  });

  it("never congratulates a day spent under a limit", () => {
    for (const s of strings)
      expect(s.toLowerCase()).not.toMatch(
        /well done|nice work|good job|keep it up/
      );
  });
});

// ── THE RULE THIS MODULE SHARES A BORDER WITH ───────────────────────────────────
//
// #2397/#2572 forbid the app observing YOUR pattern, observing YOUR result, and
// implying the first explains the second. #2377 is a different act — a curated, general
// lookup with a cited source, the same shape #577 has shipped for years — and the two
// are told apart by WHAT THE CLAIM IS ATTACHED TO, not by tone. A biomarker may be named
// beside a SINGLE ACT; it may never be named beside a COUNT OVER DAYS. These pins are
// what keeps a renderer from crossing that line by choosing to.

describe("a pattern is never joined to a biomarker (#2397/#2572)", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "lib/food-limit-note.ts"),
    "utf8"
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("has no field the DAY observation could carry a result in", () => {
    const [observation] = foodLimitDayObservations({
      loggedGroups: ["fried_food"],
      limits: [LDL],
      capGoverned: new Set<string>(),
    });
    const keys = Object.keys(observation);
    for (const forbidden of [
      "biomarker",
      "flag",
      "result",
      "value",
      "reading",
      "marker",
    ])
      expect(keys.some((k) => k.toLowerCase().includes(forbidden))).toBe(false);
  });

  it("never lets a marker reach the digest head, whatever the limit says", () => {
    // The limit's own `triggeredBy` is one property access away on the very same object
    // the observation is built from — which is exactly why this is pinned rather than
    // reviewed. Asserted against a marker name the map's own entry carries.
    const head = foodLimitDigestHead(
      foodLimitDayObservations({
        loggedGroups: ["fried_food", "processed_meat"],
        limits: [LDL],
        capGoverned: new Set<string>(),
      })
    )!;
    for (const name of LDL.triggeredBy) expect(head).not.toContain(name);
    for (const entry of REDUCE_FOOD_ENTRIES)
      for (const name of entry.biomarkers) expect(head).not.toContain(name);
  });

  it("imports nothing that could supply a reading, a flag or a range", () => {
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      "./food-drug-ledger",
      "./food-groups",
      "./food-suggest",
    ]);
  });

  it("counts nothing over days anywhere in it", () => {
    // The tap note answers one act and the day observation reports membership. Neither
    // computes a share, a run or a per-day rate — the shapes that turn a lookup into a
    // correlation. `lib/food-regularity.ts` owns pattern arithmetic and is not reachable
    // from here (pinned by the import census above); this pins the absence of a local
    // re-derivation of it.
    expect(code).not.toMatch(/\bshare\b|observedDays|consecutive|\/\s*days\b/);
  });
});

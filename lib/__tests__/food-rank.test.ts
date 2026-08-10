import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  blendFoodOrder,
  FOOD_QUICK_COUNT,
  proteinSplitIndex,
} from "@/lib/food-rank";

// Pure slot-aware blend (issue #950): slot frecency LEADS, overall frecency BACKFILLS,
// catalog order breaks the final tie. The degrade-to-overall property is the load-
// bearing invariant — a cold slot must reproduce today's ranking with no cliff.

const CATALOG = ["fatty_fish", "leafy_greens", "berries", "whole_grains"];
const TODAY = "2026-07-10";

describe("blendFoodOrder", () => {
  it("with NO slot signal, collapses to pure overall frecency (degrade property)", () => {
    const overall = [
      { name: "berries", date: TODAY, weight: 5 },
      { name: "leafy_greens", date: TODAY, weight: 2 },
    ];
    const ordered = blendFoodOrder(CATALOG, overall, [], TODAY);
    // berries (heaviest) then leafy_greens, then the untouched catalog tail.
    expect(ordered).toEqual([
      "berries",
      "leafy_greens",
      "fatty_fish",
      "whole_grains",
    ]);
  });

  it("an empty ledger yields the exact catalog order (fresh profile, no cliff)", () => {
    expect(blendFoodOrder(CATALOG, [], [], TODAY)).toEqual(CATALOG);
  });

  it("a group tapped in THIS slot leads, even over a heavier overall staple", () => {
    // whole_grains dominates overall; fatty_fish was tapped in the slot (lunch).
    const overall = [{ name: "whole_grains", date: TODAY, weight: 20 }];
    const slot = [{ name: "fatty_fish", date: TODAY }];
    const ordered = blendFoodOrder(CATALOG, overall, slot, TODAY);
    expect(ordered[0]).toBe("fatty_fish"); // slot leads
    // …and whole_grains does NOT backfill second any more (#2369): twenty servings with
    // none of them in this window is the ledger saying it is not a this-window food, so
    // it sinks below the groups that have said nothing either way. It used to rank 2nd.
    expect(ordered).toEqual([
      "fatty_fish",
      "leafy_greens",
      "berries",
      "whole_grains",
    ]);
  });

  it("among groups WITH slot signal, more slot taps rank higher", () => {
    const slot = [
      { name: "leafy_greens", date: TODAY },
      { name: "leafy_greens", date: TODAY },
      { name: "berries", date: TODAY },
    ];
    const ordered = blendFoodOrder(CATALOG, [], slot, TODAY);
    expect(ordered.indexOf("leafy_greens")).toBeLessThan(
      ordered.indexOf("berries")
    );
  });

  it("groups with no slot signal keep their OVERALL order among themselves", () => {
    // fatty_fish leads the slot; the rest carry only overall weight and must stay in
    // overall order (berries > whole_grains), not catalog order.
    const overall = [
      { name: "whole_grains", date: TODAY, weight: 1 },
      { name: "berries", date: TODAY, weight: 3 },
    ];
    const slot = [{ name: "fatty_fish", date: TODAY }];
    const ordered = blendFoodOrder(CATALOG, overall, slot, TODAY);
    expect(ordered).toEqual([
      "fatty_fish", // slot leader
      "berries", // heavier overall
      "whole_grains", // lighter overall
      "leafy_greens", // no signal → catalog tail
    ]);
  });

  it("recency decays a stale slot tap below a fresh one", () => {
    const slot = [
      { name: "berries", date: TODAY }, // fresh
      { name: "leafy_greens", date: "2026-04-01" }, // ~100 days stale
    ];
    const ordered = blendFoodOrder(CATALOG, [], slot, TODAY);
    expect(ordered.indexOf("berries")).toBeLessThan(
      ordered.indexOf("leafy_greens")
    );
  });
});

// ---- The slot axis is TWO-SIDED (#2369) ----
//
// The bug: the slot signal only ever BOOSTED, so "logged twenty times and never in this
// window" contributed exactly what "never logged at all" contributed — zero — and the
// heavier of the two won on overall frecency. On a morning window that put alcohol and
// red meat in the quick six, which since #2225 is also the six the morning nudge sends.
// The fix reads the group's slot SHARE, so a group whose own ledger says it is not eaten
// here sinks BELOW the groups whose ledger says nothing at all.

// A morning-window fixture in the shape #2369 describes: three staples with morning taps,
// four heavily-logged groups whose taps all fall outside the window (proximity 0 → no slot
// occurrences at all), three groups never logged.
const MORNING_CATALOG = [
  "fatty_fish",
  "leafy_greens",
  "berries",
  "whole_grains",
  "legumes",
  "fruit",
  "nuts_seeds",
  "red_meat",
  "alcohol",
  "added_sugar",
];
// Decayed weights equal raw servings when everything is dated TODAY, which keeps the
// numbers in these fixtures readable as serving counts.
const MORNING_OVERALL = [
  { name: "leafy_greens", date: TODAY, weight: 84 },
  { name: "fruit", date: TODAY, weight: 56 },
  { name: "whole_grains", date: TODAY, weight: 28 },
  { name: "legumes", date: TODAY, weight: 19 }, // midday
  { name: "alcohol", date: TODAY, weight: 18 }, // evening
  { name: "nuts_seeds", date: TODAY, weight: 14 }, // afternoon
  { name: "red_meat", date: TODAY, weight: 12 }, // evening
];
const MORNING_SLOT = [
  ...Array.from({ length: 20 }, () => ({ name: "leafy_greens", date: TODAY })),
  ...Array.from({ length: 14 }, () => ({ name: "fruit", date: TODAY })),
  ...Array.from({ length: 10 }, () => ({ name: "whole_grains", date: TODAY })),
];

describe("blendFoodOrder's negative slot evidence (#2369)", () => {
  it("keeps a never-eaten-here staple OUT of the window's quick six", () => {
    const ordered = blendFoodOrder(
      MORNING_CATALOG,
      MORNING_OVERALL,
      MORNING_SLOT,
      TODAY
    );
    const six = ordered.slice(0, FOOD_QUICK_COUNT);
    // The reported defect, in one assertion: the morning six no longer offers a drink.
    expect(six).not.toContain("alcohol");
    expect(six).not.toContain("red_meat");
    // What it offers instead: the three groups this profile actually eats in the morning,
    // then the groups with NO history — which say nothing either way and stay neutral.
    expect(six).toEqual([
      "leafy_greens",
      "fruit",
      "whole_grains",
      "fatty_fish",
      "berries",
      "added_sugar",
    ]);
    // ORDERING ONLY (#559). Every group is still there, exactly once, one disclosure
    // away — and the demoted tail keeps its own overall order, heaviest first, because
    // position is a speed affordance even at the bottom.
    expect(ordered.slice(FOOD_QUICK_COUNT)).toEqual([
      "legumes",
      "alcohol",
      "nuts_seeds",
      "red_meat",
    ]);
    expect(new Set(ordered).size).toBe(MORNING_CATALOG.length);
  });

  it("a COLD slot still collapses to pure overall order (no-cliff guarantee)", () => {
    // Same heavy ledger, no slot signal anywhere — a pre-#950 profile, or a person who
    // has simply never logged at this hour. Nothing may be demoted: with no group carrying
    // window evidence there is no evidence to read, and the order is the pre-#950 one.
    const ordered = blendFoodOrder(MORNING_CATALOG, MORNING_OVERALL, [], TODAY);
    expect(ordered).toEqual([
      "leafy_greens",
      "fruit",
      "whole_grains",
      "legumes",
      "alcohol",
      "nuts_seeds",
      "red_meat",
      // The untouched catalog tail, in catalog order.
      "fatty_fish",
      "berries",
      "added_sugar",
    ]);
  });

  it("does NOT demote a group with one lifetime log outside the window", () => {
    // The floor. One evening tap is not evidence about mornings, so `red_meat` keeps its
    // ordinary backfill position ABOVE the groups with no history — demoting it there
    // would be over-reading a single tap.
    const ordered = blendFoodOrder(
      ["fatty_fish", "berries", "red_meat"],
      [{ name: "red_meat", date: TODAY, weight: 1 }],
      [{ name: "fatty_fish", date: TODAY }],
      TODAY
    );
    expect(ordered).toEqual(["fatty_fish", "red_meat", "berries"]);
  });

  it("engages AT the evidence floor and not below it", () => {
    const order = (weight: number) =>
      blendFoodOrder(
        ["fatty_fish", "berries", "red_meat"],
        [{ name: "red_meat", date: TODAY, weight }],
        [{ name: "fatty_fish", date: TODAY }],
        TODAY
      );
    // Just under eight decayed servings: still no claim either way.
    expect(order(7.9)).toEqual(["fatty_fish", "red_meat", "berries"]);
    // At eight: (2/3)^8 ≈ 3.9%, so silence in this window is read as a habit.
    expect(order(8)).toEqual(["fatty_fish", "berries", "red_meat"]);
  });

  it("one real tap in the window is presence; edge crumbs are not", () => {
    // A single tap at proximity 0.5 (within two hours of the anchor) against twenty
    // servings is a 2.5% share — above the near-zero bar, so the group is NOT demoted.
    const withTap = blendFoodOrder(
      ["berries", "alcohol"],
      [{ name: "alcohol", date: TODAY, weight: 20 }],
      [{ name: "alcohol", date: TODAY, weight: 0.5 }],
      TODAY
    );
    expect(withTap).toEqual(["alcohol", "berries"]);
    // The same twenty servings whose only morning signal is a sliver from the far edge of
    // the proximity span (a 3h55m-away tap is worth 0.02) is dust, and does not buy its
    // way out of the demotion.
    const withCrumb = blendFoodOrder(
      ["berries", "alcohol"],
      [{ name: "alcohol", date: TODAY, weight: 20 }],
      [{ name: "alcohol", date: TODAY, weight: 0.02 }],
      TODAY
    );
    expect(withCrumb).toEqual(["berries", "alcohol"]);
  });

  it("is a TOTAL order — the same inputs give the same six every time", () => {
    // The bar and the nudge each slice FOOD_QUICK_COUNT off this one ranking, so a tie
    // that resolved differently run to run would show a person two different sixes.
    const run = (overall: typeof MORNING_OVERALL, slot: typeof MORNING_SLOT) =>
      blendFoodOrder(MORNING_CATALOG, overall, slot, TODAY);
    const first = run(MORNING_OVERALL, MORNING_SLOT);
    for (let i = 0; i < 5; i++) {
      expect(run(MORNING_OVERALL, MORNING_SLOT)).toEqual(first);
    }
    // …including when the ledger rows arrive in a different order, since the weights are
    // summed and the last tiebreak is the unique catalog index.
    expect(
      run([...MORNING_OVERALL].reverse(), [...MORNING_SLOT].reverse())
    ).toEqual(first);
  });
});

// ---- Ranking does not editorialize (#1980, reversing #1822 item 5) ----
//
// #1822 item 5 pushed CAPPED groups (the catalog's `limit` tier) below every floor group
// on the Telegram path. #1980 reversed it by owner ruling: a group you log often is one
// you need to log FAST, and position is a speed affordance, not a verdict. The pin below
// is the reversal — a heavily-logged capped group now LEADS, on frecency alone.

describe("capped groups rank on frecency alone (#1980 reversal pin)", () => {
  it("a heavily-logged capped group leads the order", () => {
    const ranked = blendFoodOrder(
      ["leafy_greens", "alcohol", "berries"],
      [{ name: "alcohol", date: TODAY, weight: 20 }],
      [{ name: "alcohol", date: TODAY }],
      TODAY
    );
    expect(ranked).toEqual(["alcohol", "leafy_greens", "berries"]);
  });

  it("the `limit` tier moves nothing — two groups with equal signal keep catalog order", () => {
    // added_sugar (limit) is curated ahead of berries here and stays ahead: the tier is
    // not consulted at all.
    const ranked = blendFoodOrder(
      ["added_sugar", "berries", "fried_food"],
      [],
      [],
      TODAY
    );
    expect(ranked).toEqual(["added_sugar", "berries", "fried_food"]);
  });

  it("the user's own exclusions are still the ONLY demotion (composed by the caller)", () => {
    // demoteExcludedGroups is exercised in dietary-preferences.test.ts; what matters here
    // is that the blend itself hands over an untouched frecency order for it to partition.
    const ranked = blendFoodOrder(
      ["leafy_greens", "alcohol"],
      [
        { name: "alcohol", date: TODAY, weight: 9 },
        { name: "leafy_greens", date: TODAY, weight: 1 },
      ],
      [],
      TODAY
    );
    expect(ranked[0]).toBe("alcohol");
  });
});

// ---- The protein control's slice point (#1980, fixed in #2061) ----
//
// The bar renders the protein entry as its own control between two slices of the quick
// rows. The rank it was given counts groups in the RANKED order; the rows it is sliced
// into are the quick set, which a deep link can reorder by pinning its own group to the
// front. These cases are that mismatch, in the shape the bar hits it.

describe("proteinSplitIndex (#2061)", () => {
  it("splits after the rows that outrank protein when the rendered order is the ranked one", () => {
    // Six quick rows drawn in rank order; protein ranked 4th overall, and two of those
    // four groups are in the quick set → the control renders after two rows.
    expect(proteinSplitIndex([0, 1, 5, 7, 9, 11], 4)).toBe(2);
  });

  it("renders the control first when every quick row is outranked by protein", () => {
    expect(proteinSplitIndex([3, 4, 8], 2)).toBe(0);
  });

  it("renders the control last when every quick row outranks protein", () => {
    expect(proteinSplitIndex([0, 1, 2], 9)).toBe(3);
  });

  it("a PINNED deep-link row that protein outranks puts the control above it", () => {
    // The bug: `fried_food` is pinned to the front by a "Log servings" deep link even
    // though it ranks 9th, and protein ranks 3rd. Counting the quick rows that outrank
    // protein gives 2 — which would leave the rank-1 and rank-2 rows BELOW the control
    // while the rank-9 pin sat above it. The scan answers 0: the first rendered row is
    // already one protein outranks, so the control leads.
    expect(proteinSplitIndex([9, 0, 1, 4, 6, 8], 3)).toBe(0);
  });

  it("a PINNED row that outranks protein keeps the control below it", () => {
    // Same pin, ranked ahead of protein this time: the pinned row stays above the
    // control, and the control still lands before the first row protein outranks.
    expect(proteinSplitIndex([1, 0, 2, 7, 9], 3)).toBe(3);
  });

  it("an untracked profile splits after every row, so the control renders last", () => {
    // proteinRank null = the entry was never ranked (#559: a cold start still gets the
    // control, it just goes at the end).
    expect(proteinSplitIndex([0, 1, 2], null)).toBe(3);
    expect(proteinSplitIndex([], null)).toBe(0);
  });

  it("a rank of 0 puts the control above everything", () => {
    expect(proteinSplitIndex([0, 1, 2], 0)).toBe(0);
  });
});

// ---- #2269 decision 2: the slot-signal gather does not read meal_slot --------
//
// Ranking learns WHEN THIS PERSON EATS, so it weights each event at its eating minute
// and never at an asserted meal's anchor — decided (not incidental) in #2269, recorded
// in the gather's comment. This scan keeps the gather's SQL honest about it: the
// slot-signal SELECT names no `meal_slot`, so the column it never read cannot quietly
// come back as an input.
describe("the ranking gather's slot signal (#2269)", () => {
  it("SELECTs no meal_slot in gatherFoodRankingSignals", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/queries/nutrition.ts"),
      "utf8"
    );
    const start = src.indexOf("function gatherFoodRankingSignals");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\nexport function", start);
    const gather = src.slice(start, end === -1 ? undefined : end);
    // The decision comment stays with the code it governs…
    expect(gather).toContain("#2269 decision 2");
    // …and the SQL carries no meal_slot read. The match is the backticked SQL string
    // itself, so prose ABOUT the column (the decision comment) does not trip it.
    const selects = gather.match(/`SELECT[^`]*food_log_events[^`]*`/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) expect(select).not.toContain("meal_slot");
  });
});

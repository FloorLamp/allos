// PURE TIER — the Telegram food-log nudge renderer + callback tokens (issues #682, #1016,
// #1073, #1075). DB-free: the gather (lib/notifications/food.ts) hands ranked KEYS + slot-
// scoped counts + day totals here; this pins that the top-N ranked keys become quick-log
// buttons in order, the button "(n)" suffix is SLOT-scoped while the tally is the DAY total
// (labeled "Today:"), the reserved __protein__ key renders the "+Xg protein" button, and the
// progressive-expansion window + "Show more" behave per visibleCount.

import { describe, it, expect } from "vitest";
import {
  renderFoodNudge,
  foodLogCallbackData,
  foodProteinCallbackData,
  foodMoreCallbackData,
  foodOptInCallbackData,
  countVisibleFoodButtons,
  FOOD_NUDGE_BUTTON_COUNT,
  FOOD_NUDGE_WINDOWS,
} from "@/lib/notifications/food-format";
import { PROTEIN_NUDGE_KEY } from "@/lib/protein-nudge";
import { FOOD_GROUPS, foodGroupSlugs } from "@/lib/food-groups";
import {
  proteinTodayNudgeLine,
  proteinIntake,
  proteinTarget,
  type ProteinToday,
} from "@/lib/protein";

const DATE = "2026-07-13";
// A stable, deliberately non-catalog-order ranking so "ranked order leads" is real.
const RANKED_GROUPS = FOOD_GROUPS.slice().reverse();
const RANKED = RANKED_GROUPS.map((g) => g.slug);

describe("renderFoodNudge", () => {
  it("renders the top-N ranked keys as quick-log buttons in order", () => {
    const msg = renderFoodNudge(
      1,
      "Morning",
      DATE,
      RANKED,
      new Map(),
      new Map()
    );
    const logButtons = (msg.actions ?? []).filter((a) =>
      a.data?.startsWith("food:")
    );
    expect(logButtons).toHaveLength(FOOD_NUDGE_BUTTON_COUNT);
    // Same groups, same order as the ranked input's head.
    expect(logButtons.map((a) => a.label)).toEqual(
      RANKED_GROUPS.slice(0, FOOD_NUDGE_BUTTON_COUNT).map((g) => g.name)
    );
    expect(logButtons[0].data).toBe(
      foodLogCallbackData(1, "Morning", DATE, RANKED[0])
    );
    expect(msg.kind).toBe("food");
    expect(msg.title).toContain("Morning");
  });

  it("button counts are SLOT-scoped while the tally is the DAY total, labeled Today (#1016)", () => {
    const top = RANKED_GROUPS[0];
    // Slot: 1 this slot. Day: 3 total (2 from an earlier slot). The button shows the SLOT
    // count; the tally shows the DAY total.
    const slot = new Map<string, number>([[top.slug, 1]]);
    const day = new Map<string, number>([[top.slug, 3]]);
    const msg = renderFoodNudge(1, "Midday", DATE, RANKED, slot, day);
    const first = (msg.actions ?? [])[0];
    expect(first.label).toBe(`${top.name} (1)`); // slot count, not the day's 3
    expect(msg.body).toContain(`✓ Today: ${top.name} ×3`); // day total, labeled
  });

  it("a morning-tapped group shows an UNMARKED button on the midday nudge + a day tally (#1016)", () => {
    const top = RANKED_GROUPS[0];
    // Logged in the morning → 0 this midday slot, 2 on the day.
    const msg = renderFoodNudge(
      1,
      "Midday",
      DATE,
      RANKED,
      new Map(), // slot count 0
      new Map([[top.slug, 2]]) // day total 2
    );
    const first = (msg.actions ?? [])[0];
    expect(first.label).toBe(top.name); // no "(n)" — clean at midday
    expect(msg.body).toContain(`✓ Today: ${top.name} ×2`);
  });

  it("appends the #974 protein status line when one is supplied, and equals the gauge figure", () => {
    const target = proteinTarget({
      goal: "active",
      bodyweightKg: 80,
      leanMassKg: null,
    })!; // 95–130
    const todayIntake = proteinIntake({
      dailyTracked: null,
      dailyLogged: 30,
      dailyEstimated: 25,
    })!; // 55 g floor
    const t: ProteinToday = {
      todayIntake,
      todayGrams: todayIntake.grams,
      target,
      weeklyAverageGrams: 95,
    };
    const line = proteinTodayNudgeLine(t);
    const msg = renderFoodNudge(
      1,
      "Morning",
      DATE,
      RANKED,
      new Map(),
      new Map(),
      {
        proteinLine: line,
      }
    );
    expect(msg.body).toContain(line);
    expect(msg.body).toContain("at least 55 g");
    expect(String(Math.round(t.todayGrams))).toBe("55");
  });

  it("omits the protein line when none is supplied (no bare 0 g nag)", () => {
    const msg = renderFoodNudge(
      1,
      "Morning",
      DATE,
      RANKED,
      new Map(),
      new Map()
    );
    expect(msg.body).not.toMatch(/Protein/);
  });

  it("prompts to tap when nothing is logged yet, with no tally", () => {
    const msg = renderFoodNudge(
      1,
      "Evening",
      DATE,
      RANKED,
      new Map(),
      new Map()
    );
    expect(msg.body).toContain("Tap what you've eaten");
    expect(msg.body).not.toContain("✓");
  });

  it("adds a More… deep link only when a base URL is configured", () => {
    const withBase = renderFoodNudge(
      1,
      "Morning",
      DATE,
      RANKED,
      new Map(),
      new Map(),
      {
        deepLinkBase: "https://allos.example.com/",
      }
    );
    const more = (withBase.actions ?? []).find((a) => a.url);
    expect(more?.url).toBe("https://allos.example.com/nutrition");

    const noBase = renderFoodNudge(
      1,
      "Morning",
      DATE,
      RANKED,
      new Map(),
      new Map()
    );
    expect((noBase.actions ?? []).some((a) => a.url)).toBe(false);
  });

  it("only exposes the three non-bedtime windows", () => {
    expect(FOOD_NUDGE_WINDOWS).toEqual(["Morning", "Midday", "Evening"]);
  });
});

// ---- #1073: reserved __protein__ pseudo-group renders the "+Xg protein" button ----
// #1379: it now also carries the #1016 slot-scoped "(n)" suffix like every sibling.
describe("renderFoodNudge protein pseudo-group (#1073)", () => {
  // A ranked list with __protein__ at position 1 (within the default 6-button window).
  const withProtein = [RANKED[0], PROTEIN_NUDGE_KEY, ...RANKED.slice(1)];

  it("renders the reserved key as a '+Xg protein' button, not a food group", () => {
    const msg = renderFoodNudge(
      1,
      "Evening",
      DATE,
      withProtein,
      new Map(),
      new Map(),
      {
        proteinPresetGrams: 30,
      }
    );
    const proteinBtn = (msg.actions ?? []).find((a) =>
      a.data?.startsWith("foodprotein:")
    );
    expect(proteinBtn?.label).toBe("＋30g protein");
    expect(proteinBtn?.data).toBe(
      foodProteinCallbackData(1, "Evening", DATE, 30)
    );
  });

  it("carries the SLOT-scoped (n) suffix like its siblings (#1379), never the day tally", () => {
    // #1379 reverses the original #1073 no-suffix decision: the button now shows the SLOT
    // count (2 this slot) exactly like a food group — not the day total (3), which stays on
    // the protein line. The reserved key is STILL filtered out of the food-serving tally.
    const msg = renderFoodNudge(
      1,
      "Evening",
      DATE,
      withProtein,
      new Map([[PROTEIN_NUDGE_KEY, 2]]), // slot: 2 protein logs this evening slot
      new Map([[PROTEIN_NUDGE_KEY, 3]]), // day map would say 3 — must NOT drive the button
      { proteinPresetGrams: 25 }
    );
    const proteinBtn = (msg.actions ?? []).find((a) =>
      a.data?.startsWith("foodprotein:")
    );
    expect(proteinBtn?.label).toBe("＋25g protein (2)"); // slot count, not the day's 3
    // The tally line is empty (no real food group logged) — the reserved key is filtered.
    expect(msg.body).not.toContain("✓ Today:");
    expect(msg.body).not.toContain("__protein__");
  });

  it("shows a bare button (no suffix) when nothing's been logged this slot (#1379)", () => {
    const msg = renderFoodNudge(
      1,
      "Evening",
      DATE,
      withProtein,
      new Map(), // no slot logs
      new Map(),
      { proteinPresetGrams: 25 }
    );
    const proteinBtn = (msg.actions ?? []).find((a) =>
      a.data?.startsWith("foodprotein:")
    );
    expect(proteinBtn?.label).toBe("＋25g protein"); // 0 → bare, matches the sibling matrix
  });

  it("falls back to the default preset grams when none is supplied", () => {
    const msg = renderFoodNudge(
      1,
      "Evening",
      DATE,
      withProtein,
      new Map(),
      new Map()
    );
    const proteinBtn = (msg.actions ?? []).find((a) =>
      a.data?.startsWith("foodprotein:")
    );
    expect(proteinBtn?.label).toBe("＋30g protein"); // DEFAULT_PROTEIN_PRESET_GRAMS
  });
});

// ---- #1075: progressive expansion (visibleCount + Show more) ----
describe("renderFoodNudge progressive expansion (#1075)", () => {
  it("shows exactly visibleCount ranked buttons and a Show more row below the total", () => {
    for (const vc of [6, 12]) {
      const msg = renderFoodNudge(
        1,
        "Morning",
        DATE,
        RANKED,
        new Map(),
        new Map(),
        {
          visibleCount: vc,
        }
      );
      const logButtons = (msg.actions ?? []).filter((a) =>
        a.data?.startsWith("food:")
      );
      expect(logButtons).toHaveLength(vc);
      const more = (msg.actions ?? []).find((a) =>
        a.data?.startsWith("foodmore:")
      );
      expect(more?.label).toBe("➕ Show more");
      expect(more?.data).toBe(foodMoreCallbackData(1, "Morning", DATE));
    }
  });

  it("drops the Show more row when visibleCount reaches the total", () => {
    const msg = renderFoodNudge(
      1,
      "Morning",
      DATE,
      RANKED,
      new Map(),
      new Map(),
      { visibleCount: RANKED.length }
    );
    const logButtons = (msg.actions ?? []).filter((a) =>
      a.data?.startsWith("food:")
    );
    expect(logButtons).toHaveLength(RANKED.length);
    expect(
      (msg.actions ?? []).some((a) => a.data?.startsWith("foodmore:"))
    ).toBe(false);
  });

  it("drops the Show more row when visibleCount exceeds the total", () => {
    const msg = renderFoodNudge(
      1,
      "Morning",
      DATE,
      RANKED,
      new Map(),
      new Map(),
      { visibleCount: RANKED.length + 6 }
    );
    expect(
      (msg.actions ?? []).some((a) => a.data?.startsWith("foodmore:"))
    ).toBe(false);
  });
});

// ---- #1075: stateless count-from-keyboard derivation ----
describe("countVisibleFoodButtons (#1075)", () => {
  it("counts food + protein buttons, ignoring the Show more, deep link, and non-buttons", () => {
    const keyboard = [
      [
        {
          text: "Leafy greens",
          callback_data: "food:1:Morning:2026-07-13:leafy_greens",
        },
        { text: "Berries", callback_data: "food:1:Morning:2026-07-13:berries" },
      ],
      [
        {
          text: "＋30g protein",
          callback_data: "foodprotein:1:Morning:2026-07-13:30",
        },
      ],
      [
        {
          text: "➕ Show more",
          callback_data: "foodmore:1:Morning:2026-07-13",
        },
      ],
      [{ text: "＋ More…", url: "https://allos.example.com/nutrition" }],
    ];
    // 2 food buttons + 1 protein button = 3; the show-more, deep-link (no callback_data) ignored.
    expect(countVisibleFoodButtons(keyboard)).toBe(3);
  });

  it("returns 0 for an empty / undefined keyboard", () => {
    expect(countVisibleFoodButtons([])).toBe(0);
    expect(countVisibleFoodButtons(undefined)).toBe(0);
  });

  it("round-trips a rendered nudge's visible count", () => {
    const msg = renderFoodNudge(
      1,
      "Morning",
      DATE,
      RANKED,
      new Map(),
      new Map(),
      {
        visibleCount: 12,
      }
    );
    const keyboard = (msg.actions ?? []).map((a) => [
      { text: a.label, callback_data: a.data },
    ]);
    expect(countVisibleFoodButtons(keyboard)).toBe(12);
  });
});

describe("token builders", () => {
  it("foodLogCallbackData round-trips its fields", () => {
    expect(foodLogCallbackData(7, "Evening", DATE, "leafy_greens")).toBe(
      `food:7:Evening:${DATE}:leafy_greens`
    );
  });
  it("foodProteinCallbackData encodes profile/window/date/grams", () => {
    expect(foodProteinCallbackData(7, "Evening", DATE, 30)).toBe(
      `foodprotein:7:Evening:${DATE}:30`
    );
  });
  it("foodMoreCallbackData encodes profile/window/date", () => {
    expect(foodMoreCallbackData(7, "Evening", DATE)).toBe(
      `foodmore:7:Evening:${DATE}`
    );
  });
  it("foodOptInCallbackData encodes the choice", () => {
    expect(foodOptInCallbackData(3, true)).toBe("foodoptin:3:yes");
    expect(foodOptInCallbackData(3, false)).toBe("foodoptin:3:no");
  });
  it("the reserved protein key is not a catalog slug", () => {
    expect(foodGroupSlugs()).not.toContain(PROTEIN_NUDGE_KEY);
  });
});

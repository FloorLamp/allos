// PURE TIER — the Telegram food-log nudge renderer + callback tokens (issue #682).
// DB-free: the gather (lib/notifications/food.ts) hands a ranked group list + today's
// serving counts here; this pins that the top-N groups become quick-log buttons in
// ranked order, each token is well-formed, the tally line reflects today's counts,
// and the "More…" deep link only appears with a configured base URL.

import { describe, it, expect } from "vitest";
import {
  renderFoodNudge,
  foodLogCallbackData,
  foodOptInCallbackData,
  FOOD_NUDGE_BUTTON_COUNT,
  FOOD_NUDGE_WINDOWS,
} from "@/lib/notifications/food-format";
import { FOOD_GROUPS } from "@/lib/food-groups";

const DATE = "2026-07-13";
// A stable, deliberately non-catalog-order ranking so "ranked order leads" is real.
const RANKED = FOOD_GROUPS.slice().reverse();

describe("renderFoodNudge", () => {
  it("renders the top-N ranked groups as quick-log buttons in order", () => {
    const msg = renderFoodNudge(1, "Morning", DATE, RANKED, new Map());
    const logButtons = (msg.actions ?? []).filter((a) => a.data);
    expect(logButtons).toHaveLength(FOOD_NUDGE_BUTTON_COUNT);
    // Same groups, same order as the ranked input's head.
    expect(logButtons.map((a) => a.label)).toEqual(
      RANKED.slice(0, FOOD_NUDGE_BUTTON_COUNT).map((g) => g.name)
    );
    expect(logButtons[0].data).toBe(
      foodLogCallbackData(1, "Morning", DATE, RANKED[0].slug)
    );
    expect(msg.kind).toBe("food");
    expect(msg.title).toContain("Morning");
  });

  it("shows a per-button running count and a tally line for today's servings", () => {
    const top = RANKED[0];
    const servings = new Map<string, number>([[top.slug, 2]]);
    const msg = renderFoodNudge(1, "Midday", DATE, RANKED, servings);
    const first = (msg.actions ?? [])[0];
    expect(first.label).toBe(`${top.name} (2)`);
    expect(msg.body).toContain(`✓ ${top.name} ×2`);
  });

  it("prompts to tap when nothing is logged yet, with no tally", () => {
    const msg = renderFoodNudge(1, "Evening", DATE, RANKED, new Map());
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
      "https://allos.example.com/"
    );
    const more = (withBase.actions ?? []).find((a) => a.url);
    expect(more?.url).toBe("https://allos.example.com/nutrition");

    const noBase = renderFoodNudge(1, "Morning", DATE, RANKED, new Map());
    expect((noBase.actions ?? []).some((a) => a.url)).toBe(false);
  });

  it("only exposes the three non-bedtime windows", () => {
    expect(FOOD_NUDGE_WINDOWS).toEqual(["Morning", "Midday", "Evening"]);
  });
});

describe("token builders", () => {
  it("foodLogCallbackData round-trips its fields", () => {
    expect(foodLogCallbackData(7, "Evening", DATE, "leafy_greens")).toBe(
      `food:7:Evening:${DATE}:leafy_greens`
    );
  });
  it("foodOptInCallbackData encodes the choice", () => {
    expect(foodOptInCallbackData(3, true)).toBe("foodoptin:3:yes");
    expect(foodOptInCallbackData(3, false)).toBe("foodoptin:3:no");
  });
});

import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_FOODSLOT, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Slot-aware food-log ranking + the N-week habit consistency trend (#950 / #954).
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_FOODSLOT in its OWN cookie
// context on a dedicated profile whose per-tap ledger is slot-SKEWED — exactly one
// dominant encourage group per window (whole_grains at breakfast, fatty_fish at lunch,
// berries in the evening). Read-only, so it never races a neighbor. The wall clock at
// render decides the current slot; the fixture has a dominant group for ALL THREE, so
// the assertion (bar lead == slot chip's window) holds whenever CI runs.

const SLOT_LEADER: Record<string, string> = {
  Morning: "whole_grains",
  Midday: "fatty_fish",
  Evening: "berries",
};

test("the one-tap bar leads with the current slot's group, and the chip matches (#950)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FOODSLOT,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    test.slow(); // next dev compiles the nutrition route on first hit
    await page.goto("/nutrition");

    // The slot chip renders the derived current window (Morning/Midday/Evening).
    const chip = page.getByTestId("food-slot-chip");
    await expect(chip).toBeVisible();
    const slot = await chip.getAttribute("data-slot");
    expect(slot).toBeTruthy();
    expect(["Morning", "Midday", "Evening"]).toContain(slot);
    // The chip label reads the same window (label and ranking share one derivation).
    await expect(chip).toHaveText(slot!);

    // The FIRST food-group row in the bar (encourage tier leads) is the slot's dominant
    // group — the SAME derivation that labeled the chip ranked the bar (#221).
    const expectedLead = SLOT_LEADER[slot!];
    const firstRow = page
      .getByTestId("food-log-bar")
      .locator('[data-testid^="food-group-"]')
      .first();
    await expect(firstRow).toHaveAttribute(
      "data-testid",
      `food-group-${expectedLead}`
    );
  } finally {
    await page.context().close();
  }
});

test("a tracked habit shows the N-week consistency trend; a fresh one shows a short honest history (#954)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FOODSLOT,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    test.slow();
    await page.goto("/nutrition");

    const card = page.getByTestId("weekly-habits");
    await expect(card).toBeVisible();

    // The backdated "fatty fish 2×/week" habit shows a full 8-week trend strip.
    const fishTrend = page.getByTestId("habit-trend-fatty_fish");
    await expect(fishTrend).toBeVisible();
    const fishCells = fishTrend.locator("span[data-verdict]");
    await expect(fishCells).toHaveCount(8);
    // A cell carries the week/count tooltip ("… – … · N of 2").
    await expect(fishCells.first()).toHaveAttribute("title", /·\s\d+ of 2$/);
    // A backdated habit has NO not-applicable cells (it existed for the whole window).
    await expect(fishTrend.locator('span[data-verdict="na"]')).toHaveCount(0);

    // The freshly-created "leafy greens" habit renders an honest cold start — the weeks
    // before it existed are not-applicable, never red misses.
    const greensTrend = page.getByTestId("habit-trend-leafy_greens");
    await expect(greensTrend).toBeVisible();
    await expect(
      greensTrend.locator('span[data-verdict="na"]').first()
    ).toBeVisible();
    // Its na cell tooltip says so.
    await expect(
      greensTrend.locator('span[data-verdict="na"]').first()
    ).toHaveAttribute("title", /not tracked yet$/);
  } finally {
    await page.context().close();
  }
});

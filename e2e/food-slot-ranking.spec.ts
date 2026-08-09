import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_FOODSLOT,
  E2E_LOGIN_FOODUSUAL,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

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

test("the one-tap bar order follows every selected meal slot (#950)", async ({
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

    const firstRow = page
      .getByTestId("food-log-bar")
      .locator(
        '[data-testid^="food-group-"]:not([data-testid="food-group-icon"])'
      )
      .first(); // first-ok: the TOP-ranked food-group row IS the assertion (deterministic seeded ranking for this spec's own profile)
    await expect(firstRow).toHaveAttribute(
      "data-testid",
      `food-group-${SLOT_LEADER[slot!]}`
    );

    // Switching meal cards swaps the quick-log catalog to that meal's independent
    // learned order; counts and ordering now share the same selected-slot context.
    for (const meal of ["Morning", "Midday", "Evening"]) {
      await page.getByTestId(`food-slot-${meal.toLowerCase()}`).click();
      await expect(chip).toHaveText(meal);
      await expect(firstRow).toHaveAttribute(
        "data-testid",
        `food-group-${SLOT_LEADER[meal]}`
      );
    }
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
    await expect(fishCells.first()).toHaveAttribute("title", /·\s\d+ of 2$/); // first-ok: a week-cell of the deterministic 8-cell strip (count asserted above); tooltip format check
    // A backdated habit has NO not-applicable cells (it existed for the whole window).
    await expect(fishTrend.locator('span[data-verdict="na"]')).toHaveCount(0);

    // The freshly-created "leafy greens" habit renders an honest cold start — the weeks
    // before it existed are not-applicable, never red misses.
    const greensTrend = page.getByTestId("habit-trend-leafy_greens");
    await expect(greensTrend).toBeVisible();
    await expect(
      greensTrend.locator('span[data-verdict="na"]').first() // first-ok: a not-applicable cold-start cell of the freshly-created greens habit — order-agnostic
    ).toBeVisible();
    // Its na cell tooltip says so.
    await expect(
      greensTrend.locator('span[data-verdict="na"]').first() // first-ok: a not-applicable cold-start cell of the freshly-created greens habit — order-agnostic
    ).toHaveAttribute("title", /not tracked yet$/);
  } finally {
    await page.context().close();
  }
});

// ── Food regularity: the usual-breakfast shortcut (#2380) ────────────────────
//
// Fixture-OWNED on its own profile (E2E_LOGIN_FOODUSUAL): three weeks of mornings
// holding the SAME TWO groups and nothing else, with today deliberately empty, plus a
// daily evening alcohol habit that must never be offered back. The spec WRITES (it taps
// the offer), so it owns its fixture rather than sharing one.

test("a regular window offers its usual set in one tap, and stops offering it once logged (#2380)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FOODUSUAL,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    test.slow();
    await page.goto("/nutrition");

    // Whatever window the run's frozen clock lands in, the habit is in Morning.
    await page.getByTestId("food-slot-morning").click();
    await expect(page.getByTestId("food-slot-chip")).toHaveText("Morning");

    // The offer names EXACTLY the groups it will write — the label is the promise.
    const offer = page.getByTestId("food-usual-offer");
    await expect(offer).toBeVisible();
    await expect(offer).toHaveAttribute("data-groups", "berries,fermented");
    await expect(page.getByTestId("food-usual-names")).toHaveText(
      "Berries and Fermented foods"
    );

    // One tap logs both. The counts beside the rows are the evidence.
    await expect(page.getByTestId("count-berries")).toHaveText("0");
    await expect(page.getByTestId("count-fermented")).toHaveText("0");
    await offer.click();
    await expect(page.getByTestId("count-berries")).toHaveText("1");
    await expect(page.getByTestId("count-fermented")).toHaveText("1");

    // …and the offer is GONE, because it is rendered from state: the window now holds
    // its usual set, so there is nothing left that a second tap could log.
    await expect(offer).toHaveCount(0);

    // The absence survives a reload — it is the server's answer, not a local flag.
    await page.reload();
    await page.getByTestId("food-slot-morning").click();
    await expect(page.getByTestId("count-berries")).toHaveText("1");
    await expect(page.getByTestId("food-usual-offer")).toHaveCount(0);

    // Teardown through the product's own "−", which doubles as the assertion that the
    // offer renders from state in BOTH directions: undo what made it disappear and it
    // comes back, with no dismissal bookkeeping anywhere. Leaves the fixture exactly as
    // it was found, so the spec is repeat-safe.
    await page.getByTestId("undo-berries").click();
    await expect(page.getByTestId("count-berries")).toHaveText("0");
    await page.getByTestId("undo-fermented").click();
    await expect(page.getByTestId("count-fermented")).toHaveText("0");
    await expect(page.getByTestId("food-usual-offer")).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("a cap-direction group is never offered back as an expectation (#2380 / #998)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_FOODUSUAL,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    test.slow();
    await page.goto("/nutrition");

    // The fixture's evenings hold alcohol AND leafy greens every day for three weeks —
    // two habitual groups by the arithmetic. Alcohol is excluded because its counter is
    // the substance ledger, which leaves ONE, and one group is already one tap on the
    // row below. So the window that is MOST regular offers nothing at all.
    await page.getByTestId("food-slot-evening").click();
    await expect(page.getByTestId("food-slot-chip")).toHaveText("Evening");
    await expect(page.getByTestId("food-quick-log")).toBeVisible();
    await expect(page.getByTestId("food-usual-offer")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

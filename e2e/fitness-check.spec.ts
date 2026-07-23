import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_FITNESS,
  E2E_LOGIN_FITNESS_SENIOR,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Guided Fitness check — the #1132 heat-grid redesign over the #1129 auto-count data + the
// #1135 rough hold band. Drives dedicated fixture profiles (isolated member logins) so
// recording tests never perturbs a shared-seed profile under --repeat-each. The FITNESS
// profile carries a PRIOR grip check (so a re-record shows a delta) AND seeded natural-store
// readings the check never recorded (a synced VO2, a scale body-fat/RHR, a logged squat +
// plank) so the grid lights up auto-counted tiles. The SENIOR profile (age 72) renders the
// older-adult variant.
test.describe("Fitness check grid (#1129/#1132/#1135)", () => {
  test("renders the heat grid, auto-counts synced/logged values, records a test, shows a delta", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow(); // local next dev compiles the training route on first hit

    await page.goto("/training?tab=fitness");

    const surface = page.getByTestId("fitness-check");
    await expect(surface).toBeVisible();
    await expect(page.getByTestId("fitness-completion")).toBeVisible();

    // The grid renders one square per battery test.
    const grid = page.getByTestId("fitness-grid");
    await expect(grid).toBeVisible();
    await expect(page.getByTestId("fitness-tile-grip")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-vo2max")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-plank")).toBeVisible();

    // #1129: the seeded SYNCED VO2 auto-counts — its tile is colored (not the grey
    // "neutral" unmeasured tone) and shows a "from Oura" provenance chip.
    const vo2Tile = page.getByTestId("fitness-tile-vo2max");
    await expect(vo2Tile).not.toHaveAttribute("data-tone", "neutral");
    await expect(page.getByTestId("fitness-provenance-vo2max")).toContainText(
      "Oura"
    );

    // #1135: the seeded logged Plank auto-counts onto the rough band ladder — its tile
    // shows the "rough guide" disclosure tag (not a percentile).
    await expect(page.getByTestId("fitness-rough-plank")).toContainText(
      "rough guide"
    );

    // #1253: every tile leads with its decorative pictogram — aria-hidden, with the
    // text label/overlay still present (never icon-only), and the domain chip/bars
    // carry their glyphs (scoped lookups: the glyph testid repeats across tiles).
    const gripTileEl = page.getByTestId("fitness-tile-grip");
    const gripPicto = gripTileEl.getByTestId("fitness-pictogram-grip");
    await expect(gripPicto).toBeVisible();
    await expect(gripPicto).toHaveAttribute("aria-hidden", "true");
    await expect(gripPicto).toHaveAttribute("data-pictogram", "grip");
    await expect(gripTileEl).toContainText("Grip strength");
    await expect(
      gripTileEl.getByTestId("fitness-domain-glyph-strength")
    ).toBeVisible();
    await expect(
      page
        .getByTestId("fitness-domain-strength")
        .getByTestId("fitness-domain-glyph-strength")
    ).toBeVisible();

    // Tap the grip tile → the entry modal opens → record a NEW grip value (prior seeded
    // check was 44) → the tile updates and shows a +6 improvement delta.
    await page.getByTestId("fitness-tile-grip").click();
    const gripModal = page.getByTestId("fitness-entry-grip");
    await expect(gripModal).toBeVisible();
    // The modal header reuses the same figure — one keyed lookup, no second mapping.
    await expect(gripModal.getByTestId("fitness-pictogram-grip")).toBeVisible();
    await gripModal.getByTestId("fitness-value-grip").fill("50");
    await settledClick(page, gripModal.getByTestId("fitness-submit-grip"));

    await expect(gripModal).toBeHidden();
    const gripTile = page.getByTestId("fitness-tile-grip");
    await expect(gripTile).toContainText("50");
    await expect(page.getByTestId("fitness-delta-grip")).toContainText("+6");
    // Percentiles resolve (the profile has sex + birthdate).
    await expect(gripTile).toContainText("percentile");

    await page.close();
  });

  test("the rough-guide disclosure and provenance render in the entry modal", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();

    await page.goto("/training?tab=fitness");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // Open the plank tile → its modal discloses "rough guide only — no validated norms".
    await page.getByTestId("fitness-tile-plank").click();
    const modal = page.getByTestId("fitness-entry-plank");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("fitness-rough-note-plank")).toContainText(
      /rough guide only/i
    );

    await page.close();
  });

  test("the grid is single-scroll on mobile with no horizontal overflow (#1063)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/training?tab=fitness");
    await expect(page.getByTestId("fitness-grid")).toBeVisible();
    // No horizontal overflow: the document isn't wider than the viewport.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1
    );
    expect(overflow).toBe(false);

    await page.close();
  });

  test("shows the older-adult battery variant for a senior profile", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_FITNESS_SENIOR,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();

    await page.goto("/training?tab=fitness");
    await expect(page.getByTestId("fitness-check")).toBeVisible();

    // Senior-variant items are present; the maximal adult items (push-ups, dead hang)
    // are NOT — never hand a 72-year-old a Cooper run and a dead hang.
    await expect(page.getByTestId("fitness-tile-tug")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-armcurl")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-fourstage")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-pushups")).toHaveCount(0);
    await expect(page.getByTestId("fitness-tile-deadhang")).toHaveCount(0);

    await page.close();
  });
});

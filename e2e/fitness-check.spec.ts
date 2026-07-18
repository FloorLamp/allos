import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_FITNESS,
  E2E_LOGIN_FITNESS_SENIOR,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Guided Fitness check (issue #834). Drives dedicated fixture profiles (isolated member
// logins) so recording tests never perturbs a shared-seed profile under --repeat-each.
// The FITNESS profile has a PRIOR grip check (seeded), so re-recording shows a
// check-over-check delta; the SENIOR profile (age 72) renders the older-adult variant.
test.describe("Fitness check (#834)", () => {
  test("renders the battery, records tests, and shows percentiles + a delta", async ({
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

    // Record a NEW grip value (prior seeded check was 44 kg) → expect a +6 delta.
    const gripCard = page.getByTestId("fitness-test-grip");
    await gripCard.getByTestId("fitness-test-toggle-grip").click();
    await gripCard.getByTestId("fitness-value-grip").fill("50");
    await settledClick(page, gripCard.getByTestId("fitness-submit-grip"));

    const gripResult = page.getByTestId("fitness-result-grip");
    await expect(gripResult).toContainText("50");
    // Percentiles resolve (the profile has sex + birthdate).
    await expect(gripResult).toContainText("percentile");
    // Check-over-check delta vs the prior seeded check.
    await expect(page.getByTestId("fitness-delta-grip")).toContainText("+6");

    // Record a second test (single-leg balance) — coverage is first-class/partial.
    const balanceCard = page.getByTestId("fitness-test-balance");
    await balanceCard.getByTestId("fitness-test-toggle-balance").click();
    await balanceCard.getByTestId("fitness-value-balance").fill("40");
    await settledClick(page, balanceCard.getByTestId("fitness-submit-balance"));
    await expect(page.getByTestId("fitness-result-balance")).toContainText(
      "40"
    );

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
    await expect(page.getByTestId("fitness-test-tug")).toBeVisible();
    await expect(page.getByTestId("fitness-test-armcurl")).toBeVisible();
    await expect(page.getByTestId("fitness-test-fourstage")).toBeVisible();
    await expect(page.getByTestId("fitness-test-pushups")).toHaveCount(0);
    await expect(page.getByTestId("fitness-test-deadhang")).toHaveCount(0);

    await page.close();
  });
});

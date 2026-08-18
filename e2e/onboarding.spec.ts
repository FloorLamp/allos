import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { resetOnboardingFixture, withE2eDb } from "./onboarding-reset";
import { E2E_LOGIN_ONBOARDING, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The wizard is stateful, so this spec resets its dedicated fixture before
// every run. It covers the current six-step journey without preserving the
// retired dashboard-choice step or any widget-selection expectations.
test("a new profile completes the six-step onboarding journey", async ({
  browser,
}) => {
  test.slow();
  withE2eDb(workerDbPath(), (db) => resetOnboardingFixture(db, "onboarding"));
  const page = await loginAs(browser, {
    username: E2E_LOGIN_ONBOARDING,
    password: E2E_MEMBER_PASSWORD,
  });

  try {
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByText("Step 1 of 6", { exact: true })).toBeVisible();
    await page
      .getByTestId("onboarding-profile-path")
      .getByLabel("Set up my own profile")
      .check();

    const outcomes = page.getByTestId("onboarding-outcomes");
    await expect(page).toHaveURL(/\/onboarding\?step=2/);
    await expect(page.getByText("Step 2 of 6", { exact: true })).toBeVisible();
    await outcomes.getByLabel("Monitor body metrics and labs").check();
    await outcomes.getByRole("button", { name: "Next" }).click();

    const basics = page.getByTestId("onboarding-basics");
    await expect(page).toHaveURL(/\/onboarding\?step=3/);
    await expect(page.getByText("Step 3 of 6", { exact: true })).toBeVisible();
    await page.getByLabel("Or approximate age").fill("38");
    await basics.getByRole("button", { name: "Next" }).click();

    const firstValue = page.getByTestId("onboarding-first-value");
    await expect(page).toHaveURL(/\/onboarding\?step=4/);
    await expect(page.getByText("Step 4 of 6", { exact: true })).toBeVisible();
    await expect(
      firstValue.getByRole("link", { name: /Record a starting metric/ })
    ).toHaveAttribute("href", "/trends#body");
    await firstValue.getByRole("button", { name: "Next" }).click();

    const notifications = page.getByTestId("onboarding-notifications");
    await expect(page).toHaveURL(/\/onboarding\?step=5/);
    await expect(page.getByText("Step 5 of 6", { exact: true })).toBeVisible();
    await notifications.getByLabel("Decide later").check();
    await notifications.getByRole("button", { name: "Next" }).click();

    const finish = page.getByTestId("onboarding-finish");
    await expect(page).toHaveURL(/\/onboarding\?step=6/);
    await expect(page.getByText("Step 6 of 6", { exact: true })).toBeVisible();
    await expect(finish).toContainText("Monitor body metrics and labs");
    await expect(finish).toContainText("Ready when you are");
    await expect(finish).toContainText("Decide later");
    await finish.getByRole("button", { name: "View dashboard" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("onboarding-resume-card")).toHaveCount(0);
    await expect(page.getByTestId("onboarding-checklist")).toBeVisible();
  } finally {
    await page.context().close();
  }
});

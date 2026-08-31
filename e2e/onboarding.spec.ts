import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { resetOnboardingFixture, withE2eDb } from "./onboarding-reset";
import { E2E_LOGIN_ONBOARDING, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import {
  expectPhoneTapTargets,
  followLink,
  openDashboardAll,
  settledBoxes,
  settledClick,
} from "./helpers";
import { TAP_FLOOR_FLOAT_EPSILON_PX } from "@/lib/tap-floor-tokens";

const PHONE = { width: 390, height: 844 };
const PRIMARY_ACTION_WIDTH_PX = 9 * 16;

async function expectPrimaryActionLayout(
  section: import("@playwright/test").Locator,
  buttonName: string
) {
  const page = section.page();
  const button = section.getByRole("button", { name: buttonName, exact: true });
  const slot = section.getByTestId("onboarding-primary-action");

  await expectPhoneTapTargets(page, `${buttonName} onboarding action`, [
    button,
  ]);
  const [sectionBox, slotBox, buttonBox] = await settledBoxes([
    section,
    slot,
    button,
  ]);

  expect(slotBox.width, "the parent slot owns the retained 9rem width").toBe(
    PRIMARY_ACTION_WIDTH_PX
  );
  expect(buttonBox.width, "the submit stretches to its parent slot").toBe(
    slotBox.width
  );
  expect(
    buttonBox.x + TAP_FLOOR_FLOAT_EPSILON_PX,
    "the submit starts inside its slot"
  ).toBeGreaterThanOrEqual(slotBox.x);
  expect(
    buttonBox.x + buttonBox.width,
    "the submit ends inside its slot"
  ).toBeLessThanOrEqual(slotBox.x + slotBox.width + TAP_FLOOR_FLOAT_EPSILON_PX);
  expect(
    buttonBox.y + TAP_FLOOR_FLOAT_EPSILON_PX,
    "the submit starts inside its slot vertically"
  ).toBeGreaterThanOrEqual(slotBox.y);
  expect(
    buttonBox.y + buttonBox.height,
    "the submit ends inside its slot vertically"
  ).toBeLessThanOrEqual(
    slotBox.y + slotBox.height + TAP_FLOOR_FLOAT_EPSILON_PX
  );
  expect(
    slotBox.x + TAP_FLOOR_FLOAT_EPSILON_PX,
    "the action slot starts inside its section"
  ).toBeGreaterThanOrEqual(sectionBox.x);
  expect(
    slotBox.x + slotBox.width,
    "the action slot ends inside its section"
  ).toBeLessThanOrEqual(
    sectionBox.x + sectionBox.width + TAP_FLOOR_FLOAT_EPSILON_PX
  );
  expect(
    slotBox.y + TAP_FLOOR_FLOAT_EPSILON_PX,
    "the action slot starts inside its section vertically"
  ).toBeGreaterThanOrEqual(sectionBox.y);
  expect(
    slotBox.y + slotBox.height,
    "the action slot ends inside its section vertically"
  ).toBeLessThanOrEqual(
    sectionBox.y + sectionBox.height + TAP_FLOOR_FLOAT_EPSILON_PX
  );
}

async function expectWizardActionLayout(
  section: import("@playwright/test").Locator,
  buttonName: string
) {
  await expectPrimaryActionLayout(section, buttonName);
  await expectPhoneTapTargets(
    section.page(),
    `${buttonName} and Back onboarding actions`,
    [
      section.getByRole("link", { name: "Back", exact: true }),
      section.getByRole("button", { name: buttonName, exact: true }),
    ],
    { disjoint: true }
  );
}

// The wizard is stateful, so this spec resets its dedicated fixture before
// every run. It covers the current six-step journey without preserving the
// retired dashboard-choice step or any widget-selection expectations.
test("a new profile completes the six-step onboarding journey", async ({
  browser,
}) => {
  test.slow();
  withE2eDb(workerDbPath(), (db) => resetOnboardingFixture(db, "onboarding"));
  const page = await loginAs(
    browser,
    {
      username: E2E_LOGIN_ONBOARDING,
      password: E2E_MEMBER_PASSWORD,
    },
    { viewport: PHONE, hasTouch: true }
  );

  try {
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByText("Step 1 of 6", { exact: true })).toBeVisible();
    const exit = page.getByTestId("onboarding-exit-section");
    const defer = exit.getByRole("button", {
      name: "Set up later, take me to my dashboard",
    });
    await expect(defer).toHaveAttribute("type", "submit");
    await expectPhoneTapTargets(page, "onboarding defer sentence action", [
      defer,
    ]);
    const [exitBox, deferBox] = await settledBoxes([exit, defer]);
    expect(deferBox.x).toBeGreaterThanOrEqual(exitBox.x);
    expect(deferBox.x + deferBox.width).toBeLessThanOrEqual(
      exitBox.x + exitBox.width + TAP_FLOOR_FLOAT_EPSILON_PX
    );
    await page
      .getByTestId("onboarding-profile-path")
      .getByLabel("Set up my own profile")
      .check();

    const outcomes = page.getByTestId("onboarding-outcomes");
    await expect(page).toHaveURL(/\/onboarding\?step=2/);
    await expect(page.getByText("Step 2 of 6", { exact: true })).toBeVisible();
    const focusNext = outcomes.getByRole("button", {
      name: "Next",
      exact: true,
    });
    await expect(focusNext).toBeDisabled();
    await expectWizardActionLayout(outcomes, "Next");
    await followLink(
      page,
      outcomes.getByRole("link", { name: "Back", exact: true }),
      /\/onboarding\?step=1/
    );

    const profilePath = page.getByTestId("onboarding-profile-path");
    await expect(page.getByText("Step 1 of 6", { exact: true })).toBeVisible();
    await expectPrimaryActionLayout(profilePath, "Next");
    await settledClick(
      page,
      profilePath.getByRole("button", { name: "Next", exact: true })
    );
    await expect(page).toHaveURL(/\/onboarding\?step=2/);

    await outcomes.getByLabel("Monitor body metrics and labs").check();
    await expect(focusNext).toBeEnabled();
    await settledClick(page, focusNext);

    const basics = page.getByTestId("onboarding-basics");
    await expect(page).toHaveURL(/\/onboarding\?step=3/);
    await expect(page.getByText("Step 3 of 6", { exact: true })).toBeVisible();
    await expectWizardActionLayout(basics, "Next");
    await page.getByLabel("Or approximate age").fill("38");
    await settledClick(
      page,
      basics.getByRole("button", { name: "Next", exact: true })
    );

    const firstValue = page.getByTestId("onboarding-first-value");
    await expect(page).toHaveURL(/\/onboarding\?step=4/);
    await expect(page.getByText("Step 4 of 6", { exact: true })).toBeVisible();
    await expect(
      firstValue.getByRole("link", { name: /Record a starting metric/ })
    ).toHaveAttribute("href", "/trends#body");
    await expectWizardActionLayout(firstValue, "Next");
    await settledClick(
      page,
      firstValue.getByRole("button", { name: "Next", exact: true })
    );

    const notifications = page.getByTestId("onboarding-notifications");
    await expect(page).toHaveURL(/\/onboarding\?step=5/);
    await expect(page.getByText("Step 5 of 6", { exact: true })).toBeVisible();
    const notificationNext = notifications.getByRole("button", {
      name: "Next",
      exact: true,
    });
    await expect(notificationNext).toBeDisabled();
    await expectWizardActionLayout(notifications, "Next");
    await notifications.getByLabel("Decide later").check();
    await expect(notificationNext).toBeEnabled();
    await settledClick(page, notificationNext);

    const finish = page.getByTestId("onboarding-finish");
    await expect(page).toHaveURL(/\/onboarding\?step=6/);
    await expect(page.getByText("Step 6 of 6", { exact: true })).toBeVisible();
    await expect(finish).toContainText("Monitor body metrics and labs");
    await expect(finish).toContainText("Ready when you are");
    await expect(finish).toContainText("Decide later");
    await expectWizardActionLayout(finish, "View dashboard");
    await settledClick(
      page,
      finish.getByRole("button", { name: "View dashboard", exact: true })
    );

    await expect(page).toHaveURL(/\/$/);
    await openDashboardAll(page);
    // The checklist is a ROW since #4076 — its suggestions in the facts column, its
    // "Hide" on the row — so it is found by the candidate it always was.
    await expect(
      page.locator('[data-candidate-id^="onboarding.progress:checklist"]')
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_ONBOARDING,
  E2E_LOGIN_ORIENTATION,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Goal-based onboarding (#719): an isolated, empty profile renders every outcome
// branch, then moves through the metrics path from minimum facts → one real
// baseline record → a personalized dashboard. The profile/login fixture is dedicated
// to this spec, so no shared admin session or profile-1 dashboard state is mutated.
test("a new profile reaches a useful dashboard through the metrics path", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_ONBOARDING,
    password: E2E_MEMBER_PASSWORD,
  });

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(
      page.getByRole("heading", { name: "Welcome to Allos" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Welcome to Allos" }).locator("svg")
    ).toBeVisible();

    const profilePath = page.getByTestId("onboarding-profile-path");
    await expect(
      profilePath.getByLabel("Set up someone I care for")
    ).toBeVisible();
    await expect(
      profilePath.getByText("Continue with this existing profile")
    ).toHaveCount(0);
    await expect(
      profilePath.getByRole("button", { name: "Save profile choice" })
    ).toHaveCount(0);
    await expect(
      profilePath.getByRole("button", {
        name: "Set up later, take me to my dashboard",
      })
    ).toBeVisible();

    // Choosing a profile path saves immediately and opens the next page.
    await profilePath.getByLabel("Set up my own profile").check();
    await expect(page).toHaveURL(/\/onboarding\?step=2/);
    const outcomes = page.getByTestId("onboarding-outcomes");
    await expect(outcomes).toBeVisible();
    await expect(outcomes).toBeInViewport();
    await expect(outcomes.getByRole("button", { name: "Next" })).toBeDisabled();
    await expect(page.getByText("Step 2 of 7", { exact: true })).toBeVisible();
    expect(
      await page
        .locator('[aria-current="step"]')
        .evaluate((element) => element.getBoundingClientRect().height)
    ).toBeGreaterThanOrEqual(44);
    await expect(profilePath).toHaveCount(0);
    const back = page.getByRole("link", { name: "Back" });
    await expect(back).toHaveAttribute("href", "/onboarding?step=1");
    await expect(back).toHaveClass(/btn-ghost/);
    await back.click();
    await expect(profilePath).toBeVisible();
    const savedChoiceNext = profilePath.getByRole("button", { name: "Next" });
    await expect(savedChoiceNext).toBeVisible();
    await expect(savedChoiceNext).toHaveClass(/w-36/);
    await expect(
      profilePath.getByTestId("onboarding-exit-section")
    ).toContainText("Set up later, take me to my dashboard");
    await expect(profilePath.getByTestId("onboarding-exit-section")).toHaveCSS(
      "text-align",
      "right"
    );
    await expect(profilePath.locator("form")).toHaveCount(2);
    await savedChoiceNext.click();
    await expect(page).toHaveURL(/\/onboarding\?step=2/);
    await expect(outcomes).toBeVisible();

    // Once setup is underway, the Dashboard remains available and offers a
    // resumable entry point instead of redirecting again.
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("onboarding-resume-card")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Continue setup" })
    ).toHaveAttribute("href", "/onboarding");
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(outcomes).toBeVisible();

    await expect(outcomes.getByTestId("onboarding-focus-icon")).toHaveCount(7);
    const medicalFocus = outcomes.getByLabel("Organize medical records");
    const fitnessFocus = outcomes.getByLabel("Track fitness and training");
    const medicationsFocus = outcomes.getByLabel("Manage medications");
    const exploreFocus = outcomes.getByLabel("Explore everything");
    await expect(medicalFocus).toHaveClass(/rounded-md/);
    await medicalFocus.check();
    await fitnessFocus.check();
    await expect(medicationsFocus).toBeDisabled();
    await expect(exploreFocus).toBeEnabled();
    await exploreFocus.check();
    await expect(medicalFocus).not.toBeChecked();
    await expect(fitnessFocus).not.toBeChecked();
    await expect(outcomes).toContainText(
      "Explore everything replaces narrower priorities."
    );
    await outcomes.getByLabel("Monitor body metrics and labs").check();
    await expect(exploreFocus).not.toBeChecked();
    await expect(outcomes).toContainText("1 of 2 priorities selected.");
    await outcomes.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(/\/onboarding\?step=3/);
    const basics = page.getByTestId("onboarding-basics");
    await expect(basics).toBeVisible();
    await expect(basics).toBeInViewport();
    const timezone = page.getByLabel("Timezone");
    await expect(timezone).toHaveAttribute("role", "combobox");
    await timezone.fill("New York");
    const timezoneList = page.getByRole("listbox");
    await expect(timezoneList).toBeVisible();
    await expect(timezoneList).toContainText("UTC−04:00");
    await timezoneList.getByText("America/New York", { exact: false }).click();
    await expect(
      page.locator('input[type="hidden"][name="timezone"]')
    ).toHaveValue("America/New_York");

    const approximateAge = page.getByLabel("Or approximate age");
    const birthdate = page.getByLabel("Birthdate");
    await approximateAge.fill("38");
    await birthdate.fill("1988-02-03");
    await expect(approximateAge).toHaveValue("");
    await approximateAge.fill("38");
    await expect(birthdate).toHaveValue("");
    await page
      .getByLabel("Sex used for clinical ranges")
      .selectOption("female");
    await page.getByLabel("Weight unit").selectOption("kg");
    await page.getByLabel("Distance unit").selectOption("km");
    await basics.getByRole("button", { name: "Next" }).click();

    const firstValue = page.getByTestId("onboarding-first-value");
    await expect(page).toHaveURL(/\/onboarding\?step=4/);
    await expect(firstValue).toBeVisible();
    await expect(firstValue).toBeInViewport();
    await expect(
      firstValue.getByRole("link", { name: /Connect an app or device/ })
    ).toHaveAttribute("href", "/data?section=import#integrations");
    const dataNext = firstValue.getByRole("button", { name: "Next" });
    await expect(dataNext).toBeVisible();
    await expect(dataNext).toHaveClass(/w-36/);
    await dataNext.click();
    await expect(page).toHaveURL(/\/onboarding\?step=5/);
    await expect(page.getByTestId("onboarding-dashboard")).toBeVisible();
    await page.goto("/onboarding?step=4");
    await expect(firstValue).toBeVisible();

    // The remaining outcome-branch checks are viewport-independent; return to
    // the standard desktop viewport after pinning the mobile progression.
    await page.setViewportSize({ width: 1280, height: 720 });

    async function chooseOutcome(
      label: string,
      actionName: RegExp,
      href: string
    ) {
      await page.goto("/onboarding?step=2");
      await expect(outcomes).toBeVisible();
      const checkboxes = outcomes.locator('input[name="focus"]');
      for (let i = 0; i < (await checkboxes.count()); i += 1) {
        if (await checkboxes.nth(i).isChecked()) {
          await checkboxes.nth(i).uncheck();
        }
      }
      await outcomes.getByLabel(label).check();
      await outcomes.getByRole("button", { name: "Next" }).click();
      await expect(page).toHaveURL(/\/onboarding\?step=4/);
      await expect(firstValue).toBeVisible();
      await expect(
        firstValue.getByRole("link", { name: actionName })
      ).toHaveAttribute("href", href);
    }

    for (const [label, actionName, href] of [
      [
        "Organize medical records",
        /Import a health record/,
        "/data?section=import",
      ],
      ["Manage medications", /Add a medication/, "/medications"],
      [
        "Track fitness and training",
        /Log a recent workout/,
        "/training?tab=log",
      ],
      [
        "Stay ahead of appointments and preventive care",
        /Add an appointment/,
        "/encounters",
      ],
      ["Help care for a family member", /View the household/, "/household"],
      [
        "Explore everything",
        /Explore ways to add data/,
        "/data?section=import",
      ],
      [
        "Monitor body metrics and labs",
        /Record a starting metric/,
        "/trends?tab=body",
      ],
    ] as const) {
      await chooseOutcome(label, actionName, href);
      if (label === "Track fitness and training") {
        const routineStarter = firstValue.getByTestId(
          "onboarding-routine-starter"
        );
        await expect(routineStarter).toBeVisible();
        const templates = routineStarter.getByTestId(
          "onboarding-routine-template"
        );
        await expect(templates).toHaveCount(3);
        await expect(templates.first()).toContainText("Bodyweight 3×/week");
        await routineStarter
          .getByRole("button", { name: "Use Bodyweight 3×/week" })
          .click();
        await expect(page).toHaveURL(/\/onboarding\?step=5/);
        await expect(page.getByTestId("onboarding-dashboard")).toBeVisible();
      }
    }

    await firstValue
      .getByRole("link", { name: /Record a starting metric/ })
      .click();
    await expect(page).toHaveURL(/\/trends\?tab=body/);
    const returnBanner = page.getByTestId("onboarding-return-banner");
    await expect(returnBanner).toBeVisible();

    await page.getByLabel("Weight (kg)").fill("72.4");
    await page.getByRole("button", { name: "Save entry" }).click();
    await expect(page.getByText("Entry saved")).toBeVisible();

    await returnBanner.getByRole("link", { name: "Continue setup" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const dashboard = page.getByTestId("onboarding-dashboard");
    await expect(dashboard).toBeVisible();
    await expect(dashboard).toContainText("Health patterns worth noticing.");
    await expect(dashboard).not.toContainText(
      "A calm rollup of the observational patterns"
    );
    await expect(
      dashboard.getByTestId("onboarding-dashboard-preview")
    ).toContainText("Weight trend");
    await expect(dashboard.locator('input[name="widget"]').first()).toHaveClass(
      /rounded-md/
    );
    const dashboardNext = dashboard.getByRole("button", { name: "Next" });
    const widgetChoices = dashboard.locator('input[name="widget"]');
    for (let i = 0; i < (await widgetChoices.count()); i += 1) {
      if (await widgetChoices.nth(i).isChecked()) {
        await widgetChoices.nth(i).uncheck();
      }
    }
    await expect(dashboardNext).toBeDisabled();
    await dashboard.getByLabel("Weight trend").check();
    await expect(dashboardNext).toBeEnabled();
    await dashboardNext.click();

    const notifications = page.getByTestId("onboarding-notifications");
    await expect(page).toHaveURL(/\/onboarding\?step=6/);
    await expect(notifications).toBeVisible();
    await expect(notifications).toBeInViewport();
    await expect(
      notifications.getByRole("radio", {
        name: /^Daily guidance Medication/,
      })
    ).toBeVisible();
    await expect(
      notifications.getByRole("radio", {
        name: /^Daily guidance \+ upcoming care/,
      })
    ).toBeVisible();
    await expect(notifications).toContainText(
      "workout reminders on your training schedule"
    );
    await expect(notifications).toContainText(
      "plus advance reminders for appointments and preventive care"
    );
    await expect(notifications).toContainText(
      "including if you connect a delivery channel later"
    );
    const notificationsNext = notifications.getByRole("button", {
      name: "Next",
    });
    await expect(notificationsNext).toBeDisabled();
    await notifications.getByLabel("No notifications").check();
    await expect(notificationsNext).toBeEnabled();
    await notificationsNext.click();

    const finish = page.getByTestId("onboarding-finish");
    await expect(page).toHaveURL(/\/onboarding\?step=7/);
    await expect(finish).toBeInViewport();
    await expect(finish).toContainText("Monitor body metrics and labs");
    await expect(finish).toContainText("Starting data added");
    await expect(finish.getByRole("link", { name: "Exit setup" })).toHaveCount(
      0
    );
    await page.getByRole("button", { name: "View dashboard" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("onboarding-resume-card")).toHaveCount(0);
    const checklist = page.getByTestId("onboarding-checklist");
    await expect(checklist).toBeVisible();
    await expect(checklist).toContainText("A few useful next steps");
    await expect(checklist).not.toContainText("Import medical data");
    await expect(checklist).toContainText("Add emergency details");
    await expect(
      checklist.getByRole("link", { name: /Add emergency details/ })
    ).toHaveAttribute("href", "/settings/profile#emergency-card");
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(checklist).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(checklist).toBeVisible();
    await checklist
      .getByRole("button", { name: "Hide these suggestions" })
      .click();
    await expect(checklist).toHaveCount(0);
    await expect(
      page.getByTestId("dashboard-widget-weight-trend")
    ).toBeVisible();
    await expect(page.getByTestId("weight-starting-point")).toContainText(
      "Add another observation before Allos describes a trend"
    );
    await expect(
      page.getByTestId("dashboard-widget-next-appointment")
    ).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("a granted login receives existing-profile orientation, not empty setup", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_ORIENTATION,
    password: E2E_MEMBER_PASSWORD,
  });

  try {
    const orientation = page.getByTestId("profile-orientation-card");
    await expect(orientation).toBeVisible();
    await expect(orientation).toContainText("read-only access");
    await expect(orientation).toContainText("metrics or labs");
    await expect(page.getByTestId("onboarding-resume-card")).toHaveCount(0);
    await orientation.getByRole("button", { name: "Got it" }).click();
    await expect(orientation).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

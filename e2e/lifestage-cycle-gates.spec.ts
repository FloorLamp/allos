import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_CHILD,
  E2E_LOGIN_CYCLE_PREGNANT,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Life-stage and cycle-state gating (issues #2801 / #2807). Two bugs of one shape: a
// surface stating something about a profile that the profile's OWN recorded state
// contradicts — a cycle day for someone 20 weeks pregnant, a PHQ-9 for a 22-month-old.
//
// Every assertion here is an ABSENCE, which is the only way to test a gate. Both
// fixtures are therefore in a KNOWN state that would make the offer appear if the gate
// were missing: the pregnant profile has a real period history (the derivation runs and
// produces "Day 141 · Follicular" without the suspension), and Riley has an ordinary
// records shell (every other specialty pane still renders). A profile with no history
// would pass these tests with the fix reverted.
//
// Fixture hygiene (#868): the pregnancy fixture is dedicated and READ-ONLY — the writes
// under test are the ones that must not be offered, so nothing here mutates it and
// --repeat-each starts from the same place. The toddler half reuses E2E_LOGIN_CHILD
// (the seeded ~18-month-old "Riley (child)" is its sole/active profile), also read-only.

test.describe("a recorded pregnancy suspends the cycle state (#2801)", () => {
  test("the Cycle hero shows the pause instead of a day, a phase, and a period button", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CYCLE_PREGNANT,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/medical/cycles");
      const status = page.getByTestId("cycle-status");
      await expect(status).toBeVisible();

      // THE BUG: this read "Follicular", with "Day 141 · Follicular" under the
      // control, off a period that ended before conception.
      await expect(page.getByTestId("cycle-current-phase")).toHaveText("—");
      await expect(page.getByTestId("cycle-state-line")).toHaveCount(0);
      await expect(page.getByTestId("cycle-state-suspended")).toContainText(
        /paused while a pregnancy is recorded/i
      );

      // And the offer is gone — a full-width "Period started today" is exactly the
      // claim the recorded pregnancy contradicts.
      await expect(page.getByTestId("period-started-button")).toHaveCount(0);
      await expect(page.getByTestId("period-reopen-button")).toHaveCount(0);

      // The forecast card said this all along; the hero now agrees with it.
      await expect(page.getByTestId("cycle-forecast-suspended")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("the dashboard tile syndicates the pause, not a cycle day", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CYCLE_PREGNANT,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      const card = page.getByRole("main").getByTestId("cycle-phase-widget");
      await expect(card).toBeVisible();
      // Not "Cycle day 141 · Follicular", and not the CTA empty state either — the
      // profile has plenty of history, so "log your period to start tracking" would
      // be its own falsehood.
      await expect(card.getByTestId("cycle-phase-value")).toHaveCount(0);
      await expect(card.getByTestId("cycle-phase-empty")).toHaveCount(0);
      await expect(card.getByTestId("cycle-phase-suspended")).toContainText(
        /paused while a pregnancy is recorded/i
      );
      await expect(card.getByTestId("period-started-button")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});

test.describe("life-stage gates past substance use (#2807)", () => {
  test("a toddler cannot reach Longevity or a protocol by direct URL (#3065)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/longevity");
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId("longevity-fitness")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Longevity" })).toHaveCount(
        0
      );

      await page.goto("/protocols/999999");
      await expect(page).toHaveURL(/\/$/);
    } finally {
      await page.context().close();
    }
  });

  test("a toddler is not offered PHQ-9/GAD-7 — the route re-gates like substance use", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // A direct URL is the whole point: the nav gate was cosmetic, so before #2807
      // "the only protection was not knowing the URL".
      await page.goto("/records/specialty/mental-health");
      await expect(page).toHaveURL(/\/records\/specialty\/hearing$/);
      await expect(page.getByTestId("records-mental-health")).toHaveCount(0);
      await expect(page.getByTestId("instruments-form")).toHaveCount(0);
      await expect(
        page.getByTestId("add-mental-health-screening-panel-toggle")
      ).toHaveCount(0);

      // The gate is targeted, not a blanket shutdown of the records shell: the
      // ungated specialty panes still serve this profile.
      await expect(page.getByTestId("records-hearing")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("a toddler gets an explanation on /medical/cycles, never the tracking UI", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/medical/cycles");
      // An empty state rather than the substance-use bounce: "irrelevant" here also
      // covers a profile whose sex simply is not filled in, and bouncing those would
      // leave no way to start tracking. So the page stays, and says why.
      await expect(page.getByTestId("cycle-not-applicable")).toBeVisible();
      // None of the tracking UI renders — least of all the period button.
      await expect(page.getByTestId("period-started-button")).toHaveCount(0);
      await expect(page.getByTestId("cycle-status")).toHaveCount(0);
      await expect(page.getByTestId("cycle-add-panel")).toHaveCount(0);
      await expect(page.getByTestId("cycle-forecast")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});

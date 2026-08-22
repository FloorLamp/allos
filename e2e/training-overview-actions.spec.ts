import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { deleteActivityFromForm } from "./helpers";
import {
  E2E_LOGIN_OVERVIEW_NO_ROUTINE,
  E2E_LOGIN_OVERVIEW_REST,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

async function expectStandingActions(page: Page): Promise<void> {
  const card = page.getByTestId("next-workout-card");
  const answer = card.getByTestId("next-workout-title");
  const actions = card.getByTestId("training-overview-actions");
  const context = card.getByTestId("training-context-chips");

  await expect(answer).toBeVisible();
  await expect(
    actions.getByTestId("training-overview-start-workout")
  ).toBeVisible();
  await expect(
    actions.getByTestId("training-overview-start-workout")
  ).toHaveText("Start workout");
  await expect(
    actions.getByTestId("training-overview-log-activity")
  ).toBeVisible();
  await expect(context).toBeVisible();
  await expect(context.getByTestId("training-context-chip")).toContainText(
    "Legs (Right knee (e2e) injury)"
  );
  expect(
    await card.evaluate((element) => {
      const title = element.querySelector('[data-testid="next-workout-title"]');
      const chips = element.querySelector(
        '[data-testid="training-context-chips"]'
      );
      return Boolean(
        title &&
        chips &&
        title.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    })
  ).toBe(true);
}

// The discard goes through `deleteActivityFromForm` (#3454) — the form unmounting is
// a client `setState` and says nothing about whether `deleteActivity` has run, so the
// old spelling left the live draft racing this spec's own teardown guard.
async function closeEmptyLiveWorkout(page: Page): Promise<void> {
  await deleteActivityFromForm(page);
}

test("a no-routine Overview answers first and keeps both logging doors (#3062)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_OVERVIEW_NO_ROUTINE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");
    await expect(page.getByTestId("todays-session-card")).toHaveCount(0);
    await expectStandingActions(page);

    await page.getByTestId("training-overview-start-workout").click();
    await expect(page.getByTestId("live-workout-panel")).toBeVisible();
    await page.waitForURL(/\/training\/activity\/\d+$/);

    await closeEmptyLiveWorkout(page);

    await page.goto("/training?tab=overview");
    await page.getByTestId("training-overview-log-activity").click();
    await expect(page.getByTestId("activity-form")).toBeVisible();
    await expect(page.getByTestId("live-workout-panel")).toHaveCount(0);
  } finally {
    await page.close();
  }
});

test("a rest recommendation keeps the answer ahead of context and both doors (#3062)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_OVERVIEW_REST,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");
    await expect(page.getByTestId("next-workout-title")).toContainText(/rest/i);
    await expectStandingActions(page);
  } finally {
    await page.close();
  }
});

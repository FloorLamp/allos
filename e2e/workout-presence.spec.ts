import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_PRESENCE,
  E2E_LOGIN_CHILD,
  E2E_MEMBER_PASSWORD,
  PRESENCE_PROFILE,
} from "./fixture-logins";

// Derived workout presence (issue #921), driven end-to-end:
//   • the household presence chip (grants-scoped, active-only),
//   • the app-wide minimized workout dock — hydration on load, reopen, journal
//     suppression, minimize round-trip, and discard-removes.
//
// The seeded PRESENCE_PROFILE carries a LIVE session (a strength activity today
// with a start_time, no end_time, a fresh auto-save timestamp), so its presence
// reads `active`. The read-only tests use that fixture; the interactive test
// creates its own session on the admin profile and cleans it up (repeat-safe).

// Pick an activity in the editor's exercise combobox (same shape-tolerant matcher
// the live-workout spec documents).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

test("household shows a live-workout presence chip, grants-scoped and active-only", async ({
  page,
}) => {
  test.slow();
  // Admin sees every profile, so the seeded live session surfaces on its card.
  await page.goto("/household");
  await expect(page.getByRole("heading", { name: "Household" })).toBeVisible();

  const card = page
    .getByTestId("household-card")
    .filter({ hasText: PRESENCE_PROFILE });
  await expect(card).toHaveCount(1);
  const chip = card.getByTestId("household-presence-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/mid-workout · \d+ min/);
});

test("the workout dock hydrates for an in-progress session, suppressed on the training log", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PRESENCE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // Fresh load on the dashboard → the dock hydrates from the presence gather.
    await page.goto("/");
    const dock = page.getByTestId("workout-dock");
    await expect(dock).toBeVisible();
    await expect(dock).toContainText(/\d+ min/);

    // The training route hosts the inline docked editor, so the bar is suppressed.
    await page.goto("/training");
    await expect(page.getByTestId("workout-dock")).toHaveCount(0);

    // Back on the dashboard, tapping the bar reopens the live editor (the minimize
    // affordance proves the live overlay is up), and minimizing collapses it back.
    await page.goto("/");
    await expect(dock).toBeVisible();
    await page.getByTestId("workout-dock-open").click();
    await expect(page.getByTestId("minimize-workout")).toBeVisible();
    await page.getByTestId("minimize-workout").click();
    await expect(page.getByTestId("workout-dock")).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("a live workout raises the dock, and discarding it removes the dock", async ({
  page,
}) => {
  test.slow();
  // Start a live session on the admin profile (create-and-clean, repeat-safe).
  await page.goto("/training");
  await page.getByRole("main").getByTestId("start-workout").click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  // Log a set so the draft auto-saves (the Delete button confirms the persist) —
  // that INSERT is the active session the dock reads.
  await pickActivity(page, "Barbell Bench Press");
  await page.getByTestId("set1-weight").focus();
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // Minimize → the app-wide bar appears carrying elapsed time.
  await page.getByTestId("minimize-workout").click();
  await expect(page.getByTestId("workout-dock")).toBeVisible();

  // A full reload while active re-hydrates the dock from the presence gather.
  await page.goto("/");
  await expect(page.getByTestId("workout-dock")).toBeVisible();
  await expect(page.getByTestId("workout-dock")).toContainText(/\d+ min/);

  // Reopen from the dock, then discard the draft — presence goes idle, dock gone.
  await page.getByTestId("workout-dock-open").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByTestId("workout-dock")).toHaveCount(0);
});

test("a restricted profile (no live workout mode) never shows the dock", async ({
  browser,
}) => {
  test.slow();
  // Riley is a child (training-restricted) — presence is never gathered, so no dock.
  const page = await loginAs(browser, {
    username: E2E_LOGIN_CHILD,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    await expect(page.getByTestId("workout-dock")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

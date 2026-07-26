import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
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

// ── A COMPLETED manual log is never live (#1441) ─────────────────────────────
//
// "+ Log activity → Walking → Duration 30 → Done" defaults start_time to now and
// leaves end_time NULL. The presence classifier read only end_time, so that row —
// which the form's own validation blesses as FINISHED — held the app-wide dock
// ticking up on every page load and fired the 45-min "Still working out?" nag for
// a session that was already over.
//
// #868 fixture ownership: each test MINTS a uniquely-titled activity on the admin
// profile and deletes it through the UI in a finally, so a --repeat-each run neither
// collides nor leaves a row behind. Nothing counts a shared-seed row.
const COMPLETED_PREFIX = "Completed log presence probe";

function probeCards(page: Page, text: string | RegExp) {
  return page
    .getByRole("main")
    .locator('[id^="activity-"]')
    .filter({ hasText: text });
}

// Delete the probe through the card → editor → confirm path, so the spec leaves the
// shared journal exactly as it found it. Tolerant: a failed run before the row was
// ever created finds nothing to remove.
async function deleteProbe(page: Page, title: string): Promise<void> {
  await page.goto("/training");
  const card = probeCards(page, title);
  if ((await card.count()) === 0) return;
  await card.getByRole("button", { name: title }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await settledClick(
    page,
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
  );
  await expect(probeCards(page, title)).toHaveCount(0);
}

// Open the plain create form on /training and title it. Returns the editor scope.
async function openNewActivity(page: Page, title: string) {
  await page.goto("/training");
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();
  await expect(page.getByTestId("activity-form")).toBeVisible();
  await page.getByRole("textbox", { name: "Activity name" }).fill(title);
}

test("a completed manual log (duration, no end time) never raises the live dock (#1441)", async ({
  page,
}) => {
  test.slow();
  const title = `${COMPLETED_PREFIX} ${Date.now()}-${Math.floor(
    Math.random() * 1e6
  )}`;
  try {
    await openNewActivity(page, title);
    await pickActivity(page, "Walking");
    // The form pre-fills Start with "now" and leaves End blank — the exact shape the
    // repro produces, and the premise of the bug. Pin it so a future default change
    // can't silently retire this test.
    await expect(page.locator("#activity-start-time")).not.toHaveValue("");
    await expect(page.locator("#activity-end-time")).toHaveValue("");
    await page.getByTestId("cardio-duration").fill("30");
    // The Delete button appears only once the auto-save created the row — the same
    // stable persist signal the undo-delete probe uses.
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(probeCards(page, title)).toHaveCount(1);

    // The regression: a fresh load of any page showed the ticking dock. It is a
    // finished session, so presence is never `active` and the dock never mounts.
    await page.goto("/");
    await expect(page.getByTestId("workout-dock")).toHaveCount(0);
    await page.goto("/upcoming");
    await expect(page.getByTestId("workout-dock")).toHaveCount(0);
  } finally {
    await deleteProbe(page, title);
  }
});

test("a completed strength log lands in the finished window, not the live dock (#1441)", async ({
  page,
}) => {
  test.slow();
  const title = `${COMPLETED_PREFIX} strength ${Date.now()}-${Math.floor(
    Math.random() * 1e6
  )}`;
  try {
    await openNewActivity(page, title);
    await pickActivity(page, "Barbell Bench Press");
    await page.getByTestId("set1-weight").fill("60");
    await page.getByTestId("set1-reps-stepper").locator("input").fill("5");
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible();

    // Back-date Start by 40 minutes so start + a 30-minute duration ends in the
    // PAST — the "I just finished my 13:30–14:00 session" entry. Read from the
    // field's own pre-filled value so the arithmetic stays profile-timezone-free.
    const startField = page.locator("#activity-start-time");
    const nowValue = await startField.inputValue();
    const [h, m] = nowValue.split(":").map(Number);
    const minutesOfDay = h * 60 + m;
    // Below 00:40 local the back-date would wrap onto yesterday, which is a
    // different `date` entirely — skip rather than assert against a wrapped clock
    // (the date-boundary class, #1534).
    test.skip(
      minutesOfDay < 40,
      "start back-date would wrap past local midnight"
    );
    const back = minutesOfDay - 40;
    await startField.fill(
      `${String(Math.floor(back / 60)).padStart(2, "0")}:${String(
        back % 60
      ).padStart(2, "0")}`
    );
    await page.getByTestId("activity-duration").fill("30");
    // End stays blank — the whole point: the end instant comes from start + duration.
    await expect(page.locator("#activity-end-time")).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(probeCards(page, title)).toHaveCount(1);

    // Presence reads `finished`, so the dashboard offers the post-session recap
    // (#924) — the row is reclassified, not merely hidden — and no live dock.
    await page.goto("/");
    await expect(page.getByTestId("workout-dock")).toHaveCount(0);
    const recap = page.getByTestId("session-recap-card");
    await expect(recap).toBeVisible();
    await expect(recap).toContainText("Session complete");
  } finally {
    await deleteProbe(page, title);
  }
});

import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_RECAP, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Post-workout session recap (issue #924), driven end-to-end:
//   • live → Finish opens the "Session complete" recap step (the ONLY live-gated
//     renderer); Back returns to the editor; the effort rating round-trips into
//     activities.intensity and re-renders in the main form on edit.
//   • editing an existing activity NEVER shows the step (live-only).
//   • the finished-window dashboard card renders for a just-ended session (the
//     seeded RECAP fixture profile), self-view.
//
// The interactive tests create their own session on the admin profile and clean it
// up (repeat-safe); the dashboard-card test reads the isolated RECAP fixture.

async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first()
    .click();
}

// Start a live session, log one complete working set, and give it a unique title
// so the created row is findable/cleanable. Leaves the live editor open.
async function startLiveSession(page: Page, title: string) {
  await page.goto("/training");
  await page.getByRole("main").getByTestId("start-workout").click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  await pickActivity(page, "Barbell Bench Press");
  await page.getByTestId("set1-weight").fill("60");
  await page.getByTestId("set1-reps-stepper").locator("input").fill("5");
  // A complete set makes the draft savable — the Delete button appears once it
  // persisted (the real saveActivity path).
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();
  await page.getByLabel("Activity name").fill(title);
}

async function deleteOpenDraft(page: Page) {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
}

test("live Finish opens the Session complete recap step; Back returns to the editor (#924)", async ({
  page,
}) => {
  test.slow();
  await startLiveSession(page, "E2E Recap Step");

  // Finish opens the recap step (the only live-gated renderer) — the recap renders
  // with the session's working set, and the live control strip is hidden.
  await page.getByTestId("finish-workout").click();
  const step = page.getByTestId("session-complete-step");
  await expect(step).toBeVisible();
  await expect(step.getByTestId("session-recap")).toBeVisible();
  await expect(step.getByTestId("session-recap")).toContainText("working set");
  await expect(page.getByTestId("live-workout-panel")).toHaveCount(0);

  // Back returns to the editor (the live strip is back) — viewing wrote nothing.
  await page.getByTestId("recap-back").click();
  await expect(page.getByTestId("session-complete-step")).toHaveCount(0);
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  await deleteOpenDraft(page);
});

test("the recap-step effort rating round-trips into activities.intensity (#924)", async ({
  page,
}) => {
  test.slow();
  const title = "E2E Recap Effort";
  await startLiveSession(page, title);

  // Finish → recap step → tap the session effort (Hard) inside the step.
  await page.getByTestId("finish-workout").click();
  const step = page.getByTestId("session-complete-step");
  await expect(step).toBeVisible();
  await step.getByRole("button", { name: "Hard" }).click();
  await expect(step.getByRole("button", { name: "Hard" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // Save collapses to the plain editor; the effort persists (auto-save).
  await page.getByTestId("recap-save").click();
  await expect(page.getByTestId("session-complete-step")).toHaveCount(0);
  await expect(page.getByLabel("Saved").first()).toBeVisible();

  // On EDIT (reopen the saved card), the main Intensity picker shows Hard — proof
  // the recap-step rating round-tripped through activities.intensity to the DB.
  await page.goto("/training?tab=log");
  const card = page
    .locator('[id^="activity-"]')
    .filter({ hasText: title })
    .first();
  await expect(card).toBeVisible();
  await card
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Hard" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  await deleteOpenDraft(page);
});

test("editing an existing activity never shows the recap step (live-only, #924)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  // Open any seeded activity card for editing — a retro/edit surface.
  await page
    .locator('[id^="activity-"]')
    .first()
    .getByRole("button")
    .first()
    .click();
  await expect(page.getByTestId("activity-form")).toBeVisible();
  // No live control strip, no finish button, no recap step on an edit.
  await expect(page.getByTestId("finish-workout")).toHaveCount(0);
  await expect(page.getByTestId("session-complete-step")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("the finished-window dashboard shows the session recap card (#924)", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_RECAP,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const cardEl = page.getByTestId("session-recap-card");
    await expect(cardEl).toBeVisible();
    await expect(cardEl).toContainText("Session complete");
    // The seeded finished session beat its prior week — a Bench Press PR + all
    // targets hit render on the card.
    await expect(cardEl.getByTestId("recap-exercise")).toContainText(
      "Bench Press"
    );
    await expect(cardEl.getByTestId("recap-pr").first()).toBeVisible();
    await expect(cardEl.getByTestId("recap-rollup")).toContainText(
      "All targets hit"
    );
  } finally {
    await page.context().close();
  }
});

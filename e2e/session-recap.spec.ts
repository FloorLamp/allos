import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { comboboxRows, deleteActivityFromForm, followLink } from "./helpers";

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
  await comboboxRows(page)
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

// Start a live session, log one complete working set, and give it a unique title
// so the created row is findable/cleanable. Leaves the live editor open.
async function startLiveSession(page: Page, title: string) {
  await page.goto("/training?tab=log");
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

// Reopen a stored session for EDIT from the Log's slim feed: follow its title to
// the canonical page, then use the page header's Edit action.
async function openRowForEdit(page: Page, row: Locator) {
  await followLink(
    page,
    row.getByTestId("history-row-title"),
    /\/training\/activity\/\d+$/
  );
  await page
    .getByTestId("training-activity-page")
    .getByTestId("activity-page-edit")
    .click();
}

// Both call sites are the LAST statement of their test, so the discard has to be
// settled on the server or the row outlives the test (#3267).
async function deleteOpenDraft(page: Page) {
  await deleteActivityFromForm(page);
}

// Open the PLAIN (non-live) create form via "Add activity", log one complete set,
// and title it, so the plain-form Finish (#1124) can be exercised.
async function startPlainSession(page: Page, title: string) {
  await page.goto("/training?tab=log");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add activity" })
    .click();
  await expect(page.getByTestId("activity-form")).toBeVisible();
  // Not live: no live control strip in the plain create form.
  await expect(page.getByTestId("live-workout-panel")).toHaveCount(0);
  await pickActivity(page, "Barbell Bench Press");
  await page.getByTestId("set1-weight").fill("60");
  await page.getByTestId("set1-reps-stepper").locator("input").fill("5");
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();
  await page.getByLabel("Activity name").fill(title);
}

test("plain-form Finish stamps end and opens the shared Session complete step; effort round-trips (#1124)", async ({
  page,
}) => {
  test.slow();
  const title = "E2E Plain Finish";
  await startPlainSession(page, title);

  // The plain-form Finish button is offered for a today create (not live) — tap it.
  await expect(page.getByTestId("plain-finish-workout")).toBeVisible();
  await page.getByTestId("plain-finish-workout").click();

  // It reaches the SAME SessionCompleteStep the live panel's Finish reaches (#221,
  // the ungating) — one component, two entrypoints.
  const step = page.getByTestId("session-complete-step");
  await expect(step).toBeVisible();
  await expect(step.getByTestId("session-recap")).toContainText("working set");
  await step.getByRole("button", { name: "Hard", exact: true }).click();

  // Save stamps the end time + effort through the plain form's auto-save.
  const saved = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.ok(),
    { timeout: 15000 }
  );
  await page.getByTestId("recap-save").click();
  await expect(page.getByTestId("session-complete-step")).toHaveCount(0);
  await saved;

  // On edit the effort round-tripped to activities.intensity, proving the finish
  // persisted the just-finished session.
  await page.goto("/training?tab=log");
  const row = page
    .getByTestId("history-row")
    .filter({ hasText: title })
    .first(); // first-ok: the activity row THIS spec created (filtered by its unique title)
  await expect(row).toBeVisible();
  await openRowForEdit(page, row);
  await expect(
    page.getByRole("button", { name: "Hard", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  // The plain finish button is create-only: an edit surface never shows it.
  await expect(page.getByTestId("plain-finish-workout")).toHaveCount(0);

  await deleteOpenDraft(page);
});

test("live Finish opens the Session complete recap step; Back returns to the editor (#924)", async ({
  page,
}) => {
  test.slow();
  await startLiveSession(page, "E2E Recap Step");
  const endTime = page.getByTestId("end-time-input");
  await endTime.fill("23:59");

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
  await expect(endTime).toHaveValue("23:59");

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
  await step.getByRole("button", { name: "Hard", exact: true }).click();
  await expect(
    step.getByRole("button", { name: "Hard", exact: true })
  ).toHaveAttribute("aria-pressed", "true");

  // Save collapses to the plain editor and stamps the end time — that final
  // auto-save POST persists title + effort + end. Await it before navigating so
  // the round-trip read below can't race an in-flight save.
  const saved = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.ok(),
    { timeout: 15000 }
  );
  await page.getByTestId("recap-save").click();
  await expect(page.getByTestId("session-complete-step")).toHaveCount(0);
  await saved;

  // On EDIT (reopen the saved session), the main Intensity picker shows Hard —
  // proof the recap-step rating round-tripped through activities.intensity to
  // the DB.
  await page.goto("/training?tab=log");
  const row = page
    .getByTestId("history-row")
    .filter({ hasText: title })
    .first(); // first-ok: the activity row THIS spec created (filtered by its unique title)
  await expect(row).toBeVisible();
  await openRowForEdit(page, row);
  await expect(
    page.getByRole("button", { name: "Hard", exact: true })
  ).toHaveAttribute("aria-pressed", "true");

  await deleteOpenDraft(page);
});

test("editing an existing activity never shows the recap step (live-only, #924)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  // Open any seeded activity for editing — a retro/edit surface.
  await openRowForEdit(
    page,
    // SCOPED TO AN ACTIVITY ROW. The Log renders the whole Training family through
    // the shared substrate now, so an unscoped `.first()` can be a milestone or an
    // endurance event — rows another surface owns, whose title correctly goes there.
    page
      .locator('[data-testid="history-row"][data-history-kind="activity"]')
      .first() // first-ok: any seeded activity row (opening a retro/edit surface) — order-agnostic
  );
  await expect(page.getByTestId("activity-form")).toBeVisible();
  // No live control strip, no finish button, no recap step on an edit.
  await expect(page.getByTestId("finish-workout")).toHaveCount(0);
  await expect(page.getByTestId("session-complete-step")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

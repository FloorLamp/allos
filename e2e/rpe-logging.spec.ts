import { test, expect, type Page } from "@playwright/test";

// Issue #743: the optional per-set RPE selector round-trips through the activity
// form — log a set with a rating, reload the page, reopen the stored session, and
// the selector shows the persisted value. Driven end-to-end against the seeded DB.
//
// The probe creates and then DELETES its own row (a distinctive title, a dialog-
// scoped confirm), so the shared seed DB is left exactly as the harness seeded it.

// Pick an activity in the editor's exercise combobox (same shape-tolerant matcher
// the entry-ergonomics / live-workout specs document).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first()
    .click();
}

test("RPE selector round-trips through the activity form (#743)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // Open a fresh CREATE editor from the journal actions toolbar.
  await page
    .getByTestId("journal-actions")
    .getByRole("button", { name: "New activity" })
    .click();

  const title = "RPE round-trip probe";
  await page.getByRole("textbox", { name: "Activity name" }).fill(title);
  await pickActivity(page, "Bench Press");

  // Fill one complete working set (weight + reps) so the session auto-saves.
  // Retry the fills to ride out the hydration window: a value typed before the
  // form hydrates is silently dropped, which would leave the set incomplete and
  // the session unsaved (the full CI suite is slow enough to hit this).
  const weight = page.getByTestId("set1-weight");
  const reps = page.getByTestId("set1-reps-stepper").locator("input");
  await expect(async () => {
    await weight.fill("100");
    await reps.fill("5");
    await expect(weight).toHaveValue("100");
    await expect(reps).toHaveValue("5");
  }).toPass();

  // The RPE selector is BLANK by default (logging RPE is never required).
  const rpe = page.getByTestId("set1-rpe");
  const rpeValue = page.getByTestId("set1-rpe-value");
  await expect(rpeValue).toHaveText("RPE");

  // Stepping up from blank seeds the default working rating; a second step nudges
  // it a half point.
  await rpe.getByRole("button", { name: "Increase RPE" }).click();
  await expect(rpeValue).toHaveText("8");
  await rpe.getByRole("button", { name: "Increase RPE" }).click();
  await expect(rpeValue).toHaveText("8.5");

  // The complete set auto-saves. Assert on the Delete button appearing — a stable
  // signal that the draft persisted (it stays once the row exists) — rather than
  // the transient "Saved" check, which fades after a few seconds and races the
  // assertion on a loaded CI runner.
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // Close the editor and RELOAD — the persisted rating must survive a fresh load.
  await page.keyboard.press("Escape");
  await page.goto("/training");

  const card = page
    .getByRole("main")
    .locator('[id^="activity-"]')
    .filter({ hasText: title })
    .first();
  await expect(card).toBeVisible();

  // Reopen the stored session for edit by clicking its title.
  await card.getByRole("button", { name: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  // The RPE selector reloaded the persisted half-point value — the round-trip.
  await expect(page.getByTestId("set1-rpe-value")).toHaveText("8.5");

  // Cleanup: delete the probe row from the still-open editor (dialog-scoped
  // confirm), restoring the seed state for order-independent sibling specs.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(card).toHaveCount(0);
});

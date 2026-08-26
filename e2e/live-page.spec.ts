import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { comboboxRows, deleteActivityFromForm, settledBoxes } from "./helpers";

// #2870 step 3 — ONE URL. Starting a workout creates its row up front
// (create-at-start) and stands the tab on the session's canonical page; the
// live overlay opens above that URL, so checking off work, finishing, and
// reading the settled record all happen at one address. This drives the arc
// end-to-end: start → the page URL → a logged set → finish → the record.

// Same shape-tolerant combobox pick the live-workout spec documents.
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await comboboxRows(page)
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

test("live start → set → finish: the record settles at the session's own URL", async ({
  page,
}) => {
  test.slow();
  await page.goto("/training?tab=log");
  await page.getByRole("main").getByTestId("start-workout").click();

  // The in-gym layout is up…
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  const minimize = page.getByRole("button", {
    name: "Minimize workout",
    exact: true,
  });
  await expect(minimize).toBeVisible();
  await expect(minimize).toHaveAttribute("data-button-control", "");
  const header = page.getByTestId("activity-form-header");
  const identity = page.getByTestId("activity-form-identity");
  const [headerBox, identityBox, minimizeBox] = await settledBoxes([
    header,
    identity,
    minimize,
  ]);
  // This action is structurally desktop-only: the phone workspace uses its
  // shared drag handle. Button returns to compact desktop density, stays inside
  // the header that owns its placement, and cannot cover the editable identity.
  expect(minimizeBox.height).toBeLessThan(44);
  expect(minimizeBox.x).toBeGreaterThanOrEqual(headerBox.x);
  expect(minimizeBox.x + minimizeBox.width).toBeLessThanOrEqual(
    headerBox.x + headerBox.width
  );
  expect(identityBox.x + identityBox.width).toBeLessThanOrEqual(minimizeBox.x);
  await expect(page.getByTestId("workout-drag-handle")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Close", exact: true })
  ).toHaveCount(0);
  // …and the tab has moved to the session's canonical page: the row exists
  // BEFORE the first set (create-at-start), so the session has an address.
  await page.waitForURL(/\/training\/activity\/\d+$/);
  const sessionUrl = page.url();

  // Minimize onto the session record. Its in-progress banner is the same
  // resume affordance as the app-wide bar and reopens the shared workspace.
  await minimize.click();
  const inProgress = page.getByTestId("session-in-progress");
  await expect(inProgress).toBeVisible();
  await expect(inProgress).toContainText("Resume");
  await inProgress.click();
  await expect(page.getByTestId("activity-overlay-panel")).toBeVisible();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  // Log one set through the live form (the coached "Use" seeds set 1).
  await pickActivity(page, "Barbell Bench Press");
  await page
    .getByTestId("next-set-card")
    .getByRole("button", { name: "Use" })
    .click();
  await expect(page.getByTestId("set1-weight")).toHaveValue(/^\d/);
  // The auto-save UPDATEs the created-at-start row — the Delete affordance
  // appearing proves a persisted row backs the form.
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // Finish: recap step, save, and the live strip collapses.
  await page.getByTestId("finish-workout").click();
  await expect(page.getByTestId("session-complete-step")).toBeVisible();
  await page.getByTestId("recap-save").click();
  await expect(page.getByTestId("live-workout-panel")).toHaveCount(0);

  // The settled editor has one persistent dismissal action in its footer.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByTestId("activity-form")).toHaveCount(0);
  expect(page.url()).toBe(sessionUrl);
  const record = page.getByTestId("training-activity-page");
  await expect(record).toBeVisible();
  await expect(record.getByText("Barbell Bench Press").first()).toBeVisible(); // first-ok: the logged exercise renders on the record

  // Clean up the row this test created (shared seed DB): edit on the page and
  // delete through the form — the same machinery the log card uses.
  await page.getByTestId("activity-page-edit").click();
  await expect(page.getByTestId("activity-overlay-panel")).toBeVisible();
  await expect(page.getByTestId("activity-form")).toBeVisible();
  await deleteActivityFromForm(page);
});

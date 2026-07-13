import { test, expect } from "@playwright/test";

// Edit-lock badge + "Resume sync updates" affordance (#659). seed-events plants a
// hand-edited (edit-locked) Withings body-metric row on the default profile, so the
// Trends → Body history table renders the badge that states the consequence and the
// button that clears the lock. This drives the badge, opens the confirm, resumes
// sync, and asserts the success toast — proving the clearEditLock action round-trips
// from the UI.
test("edit-locked imported body metric shows the badge and can resume sync (#659)", async ({
  page,
}) => {
  await page.goto("/trends?tab=body");

  // The badge states what the lock does, via the shared EditLockNotice.
  const notice = page.getByTestId("edit-lock-notice").first();
  await expect(notice).toBeVisible();
  await expect(page.getByTestId("edit-lock-badge").first()).toContainText(
    "Imports won’t update this"
  );

  // Resume sync updates → confirm → success toast.
  await notice.getByTestId("edit-lock-resume").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Resume updates" }).click();

  await expect(
    page.getByText("Sync updates resumed for this row.")
  ).toBeVisible();
});

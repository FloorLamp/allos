import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { restoreEditLockRow } from "./edit-lock-fixture";

const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

// Edit-lock badge + "Resume sync updates" affordance (#659). seed-events plants a
// hand-edited (edit-locked) Withings body-metric row on the default profile, so the
// Trends → Body history table renders the badge that states the consequence and the
// button that clears the lock. This drives the badge, opens the confirm, resumes
// sync, and asserts the success toast — proving the clearEditLock action round-trips
// from the UI.
//
// Fixture ownership (#868): the test CONSUMES the lock (its "Resume updates" click
// flips the seeded row's edited flag to 0), so a --repeat-each iteration would find
// the badge already gone. beforeEach restores the lock to its edited=1 state from the
// SAME signature seed-events uses, so every run starts locked — and the seeded row is
// then the ONLY edit-locked body metric on the profile, so the notice/badge locators
// resolve to exactly one element (no positional pick needed). Short-lived connection +
// busy timeout so it never contends with the running server on the WAL DB.
test.beforeEach(() => {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    restoreEditLockRow(db, 1);
  } finally {
    db.close();
  }
});

test("edit-locked imported body metric shows the badge and can resume sync (#659)", async ({
  page,
}) => {
  await page.goto("/trends?tab=body");

  // The badge states what the lock does, via the shared EditLockNotice.
  const notice = page.getByTestId("edit-lock-notice");
  await expect(notice).toBeVisible();
  await expect(page.getByTestId("edit-lock-badge")).toContainText(
    "Sync locked"
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

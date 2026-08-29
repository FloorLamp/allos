import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_WEIGHT_QA,
  WEIGHT_QUICKADD_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import {
  openDashboardAll,
  openMeasurementGroup,
  settledClick,
} from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";

// A weigh-in logged from the app's quick-write surface joins the SAME deduped daily
// series the dashboard's weight family reads and the Trends chart stack draws — one
// write core (`addBodyMetric`), asserted across all three surfaces.
//
// #3366 MOVED THE GESTURE, NOT THE CLAIM. This used to drive the dashboard tail's
// own weight quick-add card (#1042 phase 2). The owner ruling of 2026-08-29 retired
// the tail's generic write cards because the quick logger is the app's one
// quick-write surface, so the spec follows the capability into the sheet: Body →
// "Log measurements". The removal is asserted in the same breath as the offer, so a
// tree where weight logging vanished altogether cannot pass this.
//
// The sheet is reached from the dock puck, which is phone-only chrome — hence the
// explicit phone context; a raw `loginAs` context does not inherit the mobile
// project's viewport.
//
// Fixture hygiene (#868): the dedicated Weight Quickadd profile carries two
// seeded weigh-ins (notes 'e2e:seed-weight'); this spec OWNS every other
// body_metrics row on it and clears them at test start (the smoke.spec direct-DB
// precedent), so --repeat-each starts from the same two-point series every run.

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

function resetQuickAddRows(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `DELETE FROM body_metrics
        WHERE profile_id = (SELECT id FROM profiles WHERE name = ?)
          AND (notes IS NULL OR notes != 'e2e:seed-weight')`
    ).run(WEIGHT_QUICKADD_PROFILE);
  } finally {
    db.close();
  }
}

test("a weigh-in logged from the quick logger persists into the trend (#1042/#3366)", async ({
  browser,
}) => {
  resetQuickAddRows();
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_WEIGHT_QA, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
  try {
    await page.goto("/");
    const dashboardUrl = page.url();

    // THE REMOVAL AND THE OFFER, TOGETHER. The tail no longer carries a weight write
    // of its own; the sheet does. Asserting only the first would pass on a tree where
    // the gesture disappeared instead of moving.
    await openDashboardAll(page);
    await expect(
      page.locator(
        '[data-testid="dashboard-candidate"][data-candidate-id="weight.quick-add"]'
      )
    ).toHaveCount(0);
    // Two seeded points, so the weight family reports the newest as server truth in
    // the login's default display unit.
    const weightFamily = page.locator('[data-standing-family="weight"]');
    await expect(weightFamily).toContainText("70.6");

    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "log-measurements");
    await row.click();
    const overlay = page.getByTestId("quick-entry-sheet");
    const form = overlay.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await openMeasurementGroup(page, form, "body");
    await overlay.locator("#m-weight").fill("71.4");
    await settledClick(
      page,
      overlay.getByRole("button", { name: "Save measurements" })
    );

    // Server truth, read after a reload rather than from the toast: a resolved
    // promise is not a committed row. The dashboard's own weight family is the
    // reader, so this is the deduped daily series and not a second computation.
    await page.reload();
    expect(page.url()).toBe(dashboardUrl);
    await expect(weightFamily).toContainText("71.4");
    await expect(
      weightFamily.getByRole("link", { name: /View trend/ })
    ).toHaveAttribute("href", "/trends#body");

    // And the same value on Trends → Overview → body census: the one-computation
    // check across both surfaces. Read at DESKTOP width — the #1067 tile grid and
    // the classic chart stack are the same series at two breakpoints, and
    // `body-charts-all` is the desktop one.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/trends");
    await expect(
      page
        .getByTestId("body-charts-all")
        .getByText("71.4", { exact: false })
        .first() // first-ok: the 71.4 kg weight THIS test just logged (own fresh context); assert it surfaces on the scoped Trends chart stack
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

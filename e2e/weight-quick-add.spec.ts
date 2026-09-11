import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_WEIGHT_QA,
  WEIGHT_QUICKADD_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import { openMeasurementGroup, settledClick } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";

// A weigh-in logged from the app's quick-write surface joins the SAME deduped daily
// series the dashboard's weight family reads and the Trends chart stack draws — one
// write core (`insertBodyMetric`, behind `addMeasurements`), asserted across all
// three surfaces.
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

    // THE REMOVAL AND THE OFFER, TOGETHER. Home carries no weight write of its own;
    // the sheet does. Asserting only the first would pass on a tree where the gesture
    // disappeared instead of moving — so the control comes first and the absence is
    // asked of the whole page, the tail it used to be asked of having retired with
    // the ranker (#5435 §4).
    expect(await page.locator("[data-candidate-id]").count()).toBeGreaterThan(
      0
    );
    await expect(
      page.locator('[data-candidate-id="weight.quick-add"]')
    ).toHaveCount(0);
    // THE STANDING WEIGHT FAMILY'S READOUT IS NOT ASSERTED HERE ANY MORE. It read the
    // seeded 70.6 back as server truth in the login's display unit; §4 retires the
    // weight latest/trend rows from Home along with the "Log a vital" door, so there
    // is no readout on `/` to check. The same value is read back from the TREND at
    // the end of this test, which is where the write has to land and is the claim the
    // test is named for.

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
    // promise is not a committed row.
    //
    // READ ON TRENDS, WHICH OWNS THE SERIES NOW. Home's own weight family was the
    // reader until #5435 §4 retired it with the rest of Standing, and the trend it
    // doored to is where the value lives — so the reload proves the write committed
    // (the sheet closed and the page re-rendered from the server) and the census
    // below, on the surface that reads the deduped daily series, proves it is THE
    // series rather than a second computation. That census was always in this test;
    // what changed is that it is now the only reader, not a corroborating one.
    await page.reload();
    expect(page.url()).toBe(dashboardUrl);

    // And the same value on Trends → Overview → body census: the one-computation
    // check across both surfaces. Read at DESKTOP width — the #1067 tile grid and
    // the classic chart stack are the same series at two breakpoints, and
    // `body-charts-all` is the desktop one.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/trends");
    await expect(
      // eslint-disable-next-line no-restricted-properties -- first-ok: the 71.4 kg weight THIS test just logged (own fresh context); assert it surfaces on the scoped Trends chart stack
      page
        .getByTestId("body-charts-all")
        .getByText("71.4", { exact: false })
        .first()
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import {
  E2E_LOGIN_CYCLE_CTA,
  CYCLE_CTA_PROFILE,
  E2E_LOGIN_SHELL,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The quick-log sheet's period row (issue #1892 / #1506).
//
// Period start was missing from the sheet entirely — `lib/quick-log.ts` had no entry —
// even though #1506's charter is exactly "logging actions" and day 1 is the app's most
// time-sensitive log. This spec pins the row and the overlay it opens. The shared
// `cycleControlState`/PeriodOfferButton contract is pinned in the renderer suite.
//
// A raw context from loginAs does NOT inherit the `mobile` project's `use` block, so the
// phone viewport has to be restated or this silently runs at desktop width where the
// mobile bar does not render at all (dashboard-now.mobile.spec.ts's documented gotcha).
const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

function clearCycles(profileName: string): void {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    db.prepare(
      `DELETE FROM cycles
        WHERE profile_id = (SELECT id FROM profiles WHERE name = ?)`
    ).run(profileName);
  } finally {
    db.close();
  }
}

test.describe("quick-log sheet: log a period (#1892)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(
      browser,
      { username: E2E_LOGIN_CYCLE_CTA, password: E2E_MEMBER_PASSWORD },
      PHONE_CONTEXT
    );
  });

  test.beforeEach(() => {
    clearCycles(CYCLE_CTA_PROFILE);
  });

  test.afterAll(async () => {
    clearCycles(CYCLE_CTA_PROFILE);
    await page.close();
  });

  test("the sheet carries a period row that opens the offer in place", async () => {
    await page.goto("/");
    const sheet = await openLogSheet(page);
    // The dashboard promotes no particular log, so the sheet opens on Train
    // (#2651). The period row is one segment tap away — a cost this spec now
    // states rather than papers over, and the only thing about it that moved.
    const row = await showLogRow(sheet, "log-period");
    await expect(row).toBeVisible();
    await expect(row).toContainText("Log period");

    await row.click();
    const panel = page.getByTestId("quick-cycle-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    // The verb, not the row label, names the write — and it never predicts.
    await expect(panel.getByTestId("period-started-button")).toHaveText(
      "Period started today"
    );
    await expect(panel).not.toContainText(/next period/i);
  });
});

test.describe("the period row is relevance-gated (#1892/#1042)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(
      browser,
      { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
      PHONE_CONTEXT
    );
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("a profile cycle tracking doesn't apply to never sees it", async () => {
    // The shell fixture's profile has no sex, no cycle rows — cycleTrackingRelevant is
    // false, exactly as for the Cycle nav entry and dashboard control atom. The sheet's
    // other rows are unaffected: the gate is per-entry, not a mode.
    await page.goto("/");
    const sheet = await openLogSheet(page);
    // Both rows the census files under Body, asserted with that segment REVEALED —
    // which is what keeps this an absence proof. On a segmented sheet "the period
    // row is not in the DOM" is true of every unselected segment, so a bare
    // count-0 would now pass for a profile the row is perfectly visible to.
    const period = await showLogRow(sheet, "log-period");
    await expect(period).toHaveCount(0);
    const measurements = await showLogRow(sheet, "log-measurements");
    await expect(measurements).toBeVisible();
  });
});

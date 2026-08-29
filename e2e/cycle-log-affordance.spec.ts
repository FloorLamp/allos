import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { openDashboardAll, settledClick } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { dashboardCandidatePrefix } from "./dashboard-candidate";
import {
  E2E_LOGIN_CYCLE_CTA,
  CYCLE_CTA_PROFILE,
  E2E_LOGIN_CYCLE_GAP,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The quick logger's cycle log action (issue #1892, retargeted by #3366).
//
// THE BUG, in one sentence: the action disappeared whenever no phase was derivable —
// which is exactly the state of someone who has not logged day 1 yet — so the offer
// went blank at the moment logging mattered most, and the only path to it was
// nav → Medical → Cycles. Period start is time-sensitive in a way a weigh-in is not:
// both the phase derivation and the regularity data depend on catching it.
//
// THE GESTURE MOVED, THE CLAIM DID NOT. #1892's affordance was a dashboard-tail card
// until the #3366 ruling of 2026-08-29 retired the tail's generic write cards on the
// grounds that the quick logger is the app's ONE quick-write surface. So the surface
// under test here is the sheet's period overlay, and the removal is asserted beside
// the offer so a tree where the affordance vanished cannot pass.
//
// What this spec pins is that the quick logger's action is a SECOND RENDERER of the
// #1681 control state rather than a second implementation of it — the same three
// verbs, the same windows, the same silences:
//
//   no history      → "Period started today"  (the state that used to show NOTHING)
//   period open     → "Period ended today"    (never withdrawn by duration)
//   just ended      → "Still bleeding"        (the reopen, not a gap-suppressed start)
//   inside the gap  → no button at all        (a tap would mint a back-to-back period)
//
// Fixture hygiene (#868): two dedicated cycle-RELEVANT profiles, each in its own cookie
// context. CTA is spec-owned and MUTATED — its cycles are cleared straight in the worker
// DB before each test rather than driven off through the UI, so --repeat-each starts from
// the same place every time. GAP is read-only.

// Open the sheet's period overlay and return the panel. Asserted at every step by
// `showLogRow`, so it can never silently be a no-op.
async function openPeriodPanel(page: Page) {
  const sheet = await openLogSheet(page);
  const row = await showLogRow(sheet, "log-period");
  await row.click();
  const panel = page.getByTestId("quick-cycle-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

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

test.describe("cycle logging from the quick logger (#1892)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(
      browser,
      { username: E2E_LOGIN_CYCLE_CTA, password: E2E_MEMBER_PASSWORD },
      // The sheet is reached from the dock puck, which is phone-only chrome.
      { viewport: { width: 390, height: 844 }, hasTouch: true }
    );
  });

  test.beforeEach(() => {
    clearCycles(CYCLE_CTA_PROFILE);
  });

  test.afterAll(async () => {
    clearCycles(CYCLE_CTA_PROFILE);
    await page.close();
  });

  test("the quick logger and the Cycle page always agree about the verb on offer", async () => {
    // One state, two renderers. If either grew its own derivation, this is the
    // assertion that would catch it in the browser.
    await page.goto("/");
    // The tail no longer carries a cycle write of its own (#3366) — asserted here
    // rather than only implied, and never alone: the panel below is the offer.
    await openDashboardAll(page);
    await expect(dashboardCandidatePrefix(page, "cycle.control")).toHaveCount(
      0
    );

    const panel = await openPeriodPanel(page);
    await settledClick(page, panel.getByTestId("period-started-button"));

    // The sheet's own renderer, re-opened over the freshly gathered state.
    const reopened = await openPeriodPanel(page);
    await expect(reopened.getByTestId("period-ended-button")).toHaveText(
      "Period ended today"
    );

    await page.goto("/medical/cycles");
    await expect(
      page
        .getByTestId("period-quick-actions")
        .getByTestId("period-ended-button")
    ).toHaveText("Period ended today");
  });

  test("a stale tap is refused with an honest message, never double-logged", async () => {
    // A sheet opened on a tab that has been sitting since yesterday is the surface
    // most likely to be stale. Here a second tab opens a period behind its back.
    await page.goto("/");
    const card = await openPeriodPanel(page);
    await expect(card.getByTestId("period-started-button")).toBeVisible();

    const other = await page.context().newPage();
    try {
      await other.goto("/medical/cycles");
      await settledClick(other, other.getByTestId("period-started-button"));
      await expect(other.getByTestId("period-ended-button")).toBeVisible();

      await settledClick(page, card.getByTestId("period-started-button"));
      const alert = card.getByRole("alert");
      await expect(alert).toBeVisible({ timeout: 20_000 });
      await expect(alert).toContainText(/already open/);

      // One period, not two: the refusal wrote nothing.
      await other.goto("/medical/cycles");
      await expect(other.getByTestId("cycle-history-row")).toHaveCount(1);
    } finally {
      await other.close();
    }
  });
});

test.describe("cycle offer inside the plausible-gap window (#1892)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_CYCLE_GAP,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });
});

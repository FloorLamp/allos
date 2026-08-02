import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
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
// time-sensitive log. This spec pins the row, the overlay it opens, and the property
// that matters most: the sheet and the dashboard card show the SAME verb, because both
// render the same server-resolved `cycleControlState` rather than deciding for
// themselves.
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

// Open the quick-log sheet. The caret is a pure CLIENT toggle, so a pre-hydration tap is
// swallowed with no POST to settle on and no other awaitable open signal — the
// visibility-guarded retry is the only honest wait here (#500/#830).
async function openSheet(page: Page) {
  const sheet = page.getByTestId("quick-log-sheet");
  await expect(async () => {
    if (!(await sheet.isVisible())) {
      await page.getByTestId("quick-log-more").click();
    }
    await expect(sheet).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the caret past the pre-hydration swallow — a client toggle with no POST, visibility-guarded so a late tap can't re-close it
  return sheet;
}

// The verb the sheet's overlay is currently offering, as the write it will perform.
async function sheetVerb(page: Page): Promise<string | null> {
  const sheet = await openSheet(page);
  await sheet.getByTestId("quick-log-log-period").click();
  const panel = page.getByTestId("quick-cycle-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const offer = panel.getByTestId("period-offer-sheet").getByRole("button");
  if ((await offer.count()) === 0) return null;
  return offer.getAttribute("data-period-write");
}

// The verb the dashboard card is offering, same encoding.
async function widgetVerb(page: Page): Promise<string | null> {
  const offer = page
    .getByRole("main")
    .getByTestId("cycle-phase-widget")
    .getByTestId("period-offer-widget")
    .getByRole("button");
  if ((await offer.count()) === 0) return null;
  return offer.getAttribute("data-period-write");
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
    const sheet = await openSheet(page);
    const row = sheet.getByTestId("quick-log-log-period");
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

  test("the sheet and the dashboard card show the SAME verb in every state", async () => {
    test.slow();
    await page.goto("/");
    // No history: both offer the start.
    expect(await widgetVerb(page)).toBe("start");
    expect(await sheetVerb(page)).toBe("start");

    // Log day 1 from the SHEET — the path that did not exist before this issue.
    const panel = page.getByTestId("quick-cycle-panel");
    await settledClick(page, panel.getByTestId("period-started-button"));
    // A transaction with a real end: the overlay closes and leaves you where you were.
    await expect(panel).toHaveCount(0, { timeout: 20_000 });
    await expect(
      page.getByRole("main").getByTestId("cycle-phase-value")
    ).toContainText(/Cycle day 1 · Menstrual/, { timeout: 20_000 });

    // Both surfaces have moved to the same next verb.
    expect(await widgetVerb(page)).toBe("end");
    expect(await sheetVerb(page)).toBe("end");

    // End it from the CARD; the sheet agrees about the recovery that follows.
    await page.keyboard.press("Escape");
    const card = page.getByRole("main").getByTestId("cycle-phase-widget");
    await settledClick(page, card.getByTestId("period-ended-button"));
    await expect(card.getByTestId("period-reopen-button")).toBeVisible({
      timeout: 20_000,
    });
    expect(await widgetVerb(page)).toBe("reopen");
    expect(await sheetVerb(page)).toBe("reopen");
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
    // false, exactly as for the Cycle nav entry and the dashboard card. The sheet's
    // other rows are unaffected: the gate is per-entry, not a mode.
    await page.goto("/");
    const sheet = await openSheet(page);
    await expect(sheet.getByTestId("quick-log-log-period")).toHaveCount(0);
    await expect(sheet.getByTestId("quick-log-log-measurements")).toBeVisible();
  });
});

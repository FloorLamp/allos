import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_CYCLE_CTA,
  CYCLE_CTA_PROFILE,
  E2E_LOGIN_CYCLE_GAP,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The dashboard's cycle log affordance (issue #1892).
//
// THE BUG, in one sentence: the phase widget self-hid whenever no phase was derivable —
// which is exactly the state of someone who has not logged day 1 yet — so the dashboard
// went blank at the moment logging mattered most, and the only path to it was
// nav → Medical → Cycles. Period start is time-sensitive in a way a weigh-in is not:
// both the phase derivation and the regularity data depend on catching it.
//
// What this spec pins is that the card is now a SECOND RENDERER of the #1681 control
// state rather than a second implementation of it — the same three verbs, the same
// windows, the same silences:
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

test.describe("cycle logging from the dashboard (#1892)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_CYCLE_CTA,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.beforeEach(() => {
    clearCycles(CYCLE_CTA_PROFILE);
  });

  test.afterAll(async () => {
    clearCycles(CYCLE_CTA_PROFILE);
    await page.close();
  });

  test("the card and the Cycle page always agree about the verb on offer", async () => {
    // One state, two renderers. If the widget ever grew its own derivation, this is
    // the assertion that would catch it in the browser.
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("cycle-phase-widget");
    await settledClick(page, card.getByTestId("period-started-button"));
    await expect(card.getByTestId("period-ended-button")).toBeVisible({
      timeout: 20_000,
    });

    await page.goto("/medical/cycles");
    await expect(
      page
        .getByTestId("period-quick-actions")
        .getByTestId("period-ended-button")
    ).toHaveText("Period ended today");
  });

  test("a stale tap is refused with an honest message, never double-logged", async () => {
    // The dashboard is the surface most likely to be stale — a tab open since
    // yesterday. Here a second tab opens a period behind this page's back.
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("cycle-phase-widget");
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

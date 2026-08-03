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

  test("a cycle-relevant profile with NO data gets the log CTA, not an empty dashboard", async () => {
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("cycle-phase-widget");
    // The regression: this card used to render nothing at all here.
    await expect(card).toBeVisible();
    await expect(card.getByTestId("cycle-phase-empty")).toContainText(
      /log your period to start tracking/i
    );
    // Nothing is derived, so nothing is claimed — and certainly nothing forecast.
    await expect(card.getByTestId("cycle-phase-value")).toHaveCount(0);
    await expect(card.getByTestId("cycle-phase-forecast")).toHaveCount(0);
    // And the verb names the write it will perform.
    await expect(card.getByTestId("period-started-button")).toHaveText(
      "Period started today"
    );
  });

  test("start → end → reopen: the card offers one verb per state, and only ever the true one", async () => {
    test.slow();
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("cycle-phase-widget");

    // Day 1, logged from the dashboard.
    await settledClick(page, card.getByTestId("period-started-button"));
    await expect(card.getByTestId("cycle-phase-value")).toContainText(
      /Cycle day 1 · Menstrual/,
      { timeout: 20_000 }
    );
    // The offer has flipped to the write that is now true.
    await expect(card.getByTestId("period-ended-button")).toHaveText(
      "Period ended today"
    );
    await expect(card.getByTestId("period-started-button")).toHaveCount(0);

    // End it. The pre-#1681 control flipped straight back to "Period started today",
    // whose tap minted a back-to-back period; the offer here is the RECOVERY.
    await settledClick(page, card.getByTestId("period-ended-button"));
    await expect(card.getByTestId("period-reopen-button")).toHaveText(
      "Still bleeding",
      { timeout: 20_000 }
    );
    // The start offer is suppressed inside the plausible-gap window — the button
    // self-suppresses exactly where a tap would record something implausible.
    await expect(card.getByTestId("period-started-button")).toHaveCount(0);

    // The recovery works, and reopens rather than duplicating.
    await settledClick(page, card.getByTestId("period-reopen-button"));
    await expect(card.getByTestId("period-ended-button")).toBeVisible({
      timeout: 20_000,
    });
    await expect(card.getByTestId("cycle-phase-value")).toContainText(
      /Cycle day 1 · Menstrual/
    );
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

  test("shows the derived phase and offers NOTHING — the silence is the feature", async () => {
    await page.goto("/");
    const card = page.getByRole("main").getByTestId("cycle-phase-widget");
    await expect(card).toBeVisible();
    // The fixture's period ended 5 days ago: derivable phase, no plausible write.
    await expect(card.getByTestId("cycle-phase-value")).toContainText(
      /Cycle day \d+ · (Follicular|Luteal)/
    );
    await expect(card.getByTestId("period-started-button")).toHaveCount(0);
    await expect(card.getByTestId("period-reopen-button")).toHaveCount(0);
    await expect(card.getByTestId("period-ended-button")).toHaveCount(0);
    // The dated form on the Cycle page owns this exception, and the card still links
    // there — reach narrows, it never grows a nudge.
    await expect(
      card.getByRole("link", { name: /View all cycle phase/i })
    ).toHaveAttribute("href", "/medical/cycles");
  });
});

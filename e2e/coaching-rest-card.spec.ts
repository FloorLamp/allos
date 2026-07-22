import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_REST,
  REST_CARD_PROFILE,
  E2E_LOGIN_ROUTINE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// #1148 (multi-reason rest card) + #1150 ("Training anyway" acknowledgment + the
// "Not today" → "Snooze" rename). Driven against the dedicated REST_CARD_PROFILE, which
// the e2e seed (e2e/seed-events.ts) trips with TWO concurrent under-recovery signals: a
// short night (rest-sleep) AND an elevated resting HR (rest-rhr). Its own profile keeps
// this spec's ack/snooze writes off the shared profile-1 coaching state.

// The fixture profile's ack marker + coaching snooze rows, reset before each test so
// --repeat-each starts clean (#868 fixture ownership) — the same pattern smoke.spec uses
// for the coaching snooze. Short-lived connection + busy timeout so it never contends
// with the running server on the WAL DB.
function resetRestCardState(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(REST_CARD_PROFILE) as { id: number } | undefined;
    if (row) {
      db.prepare(
        "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'coaching_rest_ack'"
      ).run(row.id);
      db.prepare(
        "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'coaching:%'"
      ).run(row.id);
    }
  } finally {
    db.close();
  }
}

// The dashboard coaching card (the .card wrapping the Snooze control).
function coachingCard(page: Page) {
  return page.locator(".card", { has: page.getByTestId("coaching-snooze") });
}

test.describe("Coaching rest card — multi-reason + Training anyway (#1148/#1150)", () => {
  test.beforeEach(() => resetRestCardState());

  test("shows the salience primary + an 'Also:' line and both actions", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_REST,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      const card = coachingCard(page);
      await expect(card).toBeVisible();
      // Headline stays the salience-ordered primary (sleep leads).
      await expect(
        card.getByText("Rest or take it easy today", { exact: true })
      ).toBeVisible();
      // The concurrent signal is NAMED before any dismissal (#1148) — the second
      // firing reason (resting HR) rides the "Also:" line.
      const also = card.getByTestId("coaching-also");
      await expect(also).toBeVisible();
      await expect(also).toContainText("resting HR");
      // Both actions present and labelled distinctly (#1150).
      await expect(card.getByTestId("coaching-training-anyway")).toBeVisible();
      await expect(card.getByTestId("coaching-snooze")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("'Training anyway' transforms the card in place into calm training guidance", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_REST,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      const card = coachingCard(page);
      await expect(card).toBeVisible();
      await settledClick(page, card.getByTestId("coaching-training-anyway"));

      // The card TRANSFORMS in place — the rest imperative becomes calm training
      // guidance naming the signal (#1150). It does NOT hide.
      const acked = coachingCard(page);
      await expect(
        acked.getByText("Training today — keep it smart", { exact: true })
      ).toBeVisible();
      await expect(acked.getByText("keep intensity moderate")).toBeVisible();
      // "Training anyway" is spent (already acknowledged); only Snooze remains.
      await expect(acked.getByTestId("coaching-training-anyway")).toHaveCount(0);
      await expect(acked.getByTestId("coaching-snooze")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("'Snooze' hides the rest recommendation for the rest of the day", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_REST,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      const card = coachingCard(page);
      await expect(
        card.getByText("Rest or take it easy today", { exact: true })
      ).toBeVisible();
      await settledClick(page, card.getByTestId("coaching-snooze"));
      // The snoozed rest recommendation is no longer the card's headline.
      await expect(
        page.getByText("Rest or take it easy today", { exact: true })
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("a non-rest (train) coaching card shows only Snooze, no 'Training anyway'", async ({
    browser,
  }) => {
    // The Routine (e2e) profile's top coaching rec is a strength routine day, not a
    // rest rec — so it carries the shared Snooze control but never the rest-only
    // "Training anyway" intent action.
    const page = await loginAs(browser, {
      username: E2E_LOGIN_ROUTINE,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      const card = coachingCard(page);
      await expect(card).toBeVisible();
      await expect(card.getByTestId("coaching-snooze")).toBeVisible();
      await expect(card.getByTestId("coaching-training-anyway")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});

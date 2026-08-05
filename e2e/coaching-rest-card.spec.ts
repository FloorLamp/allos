import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_REST,
  REST_CARD_PROFILE,
  E2E_LOGIN_ROUTINE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";
import { frozenNow, workerDbPath } from "./worker-env";

// #1148 (multi-reason rest card) + #1150 ("Training anyway" acknowledgment + the
// "Not today" → "Snooze" rename). Driven against the dedicated REST_CARD_PROFILE, which
// the e2e seed (e2e/seed-events.ts) trips with TWO concurrent under-recovery signals: a
// short night (rest-sleep) AND an elevated resting HR (rest-rhr). Its own profile keeps
// this spec's ack/snooze writes off the shared profile-1 coaching state.

// The dedicated profile's complete signal state is reset before each test so both
// --repeat-each and the full shared-worker lane start clean (#868 fixture ownership).
// Short-lived connection + busy timeout so it never contends with the running server
// on the WAL DB.
function resetRestCardState(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(REST_CARD_PROFILE) as { id: number } | undefined;
    if (row) {
      const rcToday = frozenNow().toISOString().slice(0, 10);
      const rcPrevNight = shiftDateStr(rcToday, -1);
      db.prepare(
        `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')
         ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
      ).run(row.id);
      db.prepare(
        "DELETE FROM metric_samples WHERE profile_id = ? AND metric = 'sleep_min'"
      ).run(row.id);
      // The #2159 wake-day rule: the overnight window is built through the
      // profile timezone (pinned to UTC just above), never bare `…Z` stamps.
      db.prepare(
        `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
         VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 300)`
      ).run(
        row.id,
        rcToday,
        zonedWallTimeToUtc("UTC", rcPrevNight, "23:00").toISOString(),
        zonedWallTimeToUtc("UTC", rcToday, "04:00").toISOString()
      );
      db.prepare("DELETE FROM body_metrics WHERE profile_id = ?").run(row.id);
      const insertRhr = db.prepare(
        `INSERT INTO body_metrics (profile_id, date, resting_hr, notes)
         VALUES (?, ?, ?, 'e2e:rest-card')`
      );
      insertRhr.run(row.id, rcToday, 62);
      for (let d = 1; d <= 5; d += 1) {
        insertRhr.run(row.id, shiftDateStr(rcToday, -d), 54);
      }
      db.prepare(
        "DELETE FROM activities WHERE profile_id = ? AND external_id = 'e2e:rest-card-context'"
      ).run(row.id);
      db.prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min, intensity, source, external_id)
         VALUES (?, ?, 'strength', 'Rest Card context lift', 40, 'hard', 'manual', 'e2e:rest-card-context')`
      ).run(row.id, shiftDateStr(rcToday, -10));
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
      await expect(acked.getByTestId("coaching-training-anyway")).toHaveCount(
        0
      );
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

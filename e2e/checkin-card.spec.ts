import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { openDashboardAll, settledClick } from "./helpers";
import { createProfileViaFamily, switchToProfile } from "./family-helpers";
import { loginAs } from "./nav";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import {
  E2E_LOGIN_WELLSYM,
  E2E_MEMBER_PASSWORD,
  WELL_SYMPTOM_PROFILE,
} from "./fixture-logins";
import { frozenNow, workerDbPath } from "./worker-env";
import {
  dashboardCandidatePrefix,
  dashboardCandidateWithText,
} from "./dashboard-candidate";

const ADMIN_PROFILE = "admin";

function moodOpeningTimes(): { exact: string; oneMinuteLater: string } {
  const minute = frozenNow().getUTCMinutes();
  return {
    exact: `13:${String(minute).padStart(2, "0")}`,
    oneMinuteLater:
      minute === 59 ? "14:00" : `13:${String(minute + 1).padStart(2, "0")}`,
  };
}

test.afterEach(async ({ page }) => {
  await page.goto("/");
  if (
    (await page.getByTestId("profile-identity-bar").textContent())?.includes(
      ADMIN_PROFILE
    )
  ) {
    return;
  }
  await switchToProfile(page, ADMIN_PROFILE);
});

function resetWellSymptomState(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(WELL_SYMPTOM_PROFILE) as { id: number } | undefined;
    if (row) {
      db.prepare("DELETE FROM symptom_logs WHERE profile_id = ?").run(row.id);
      db.prepare("DELETE FROM mood_logs WHERE profile_id = ?").run(row.id);
      db.prepare(
        "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'coaching:%'"
      ).run(row.id);
    }
  } finally {
    db.close();
  }
}

test("the well-day symptom action logs burden without activating illness", async ({
  browser,
}) => {
  test.slow();
  resetWellSymptomState();
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_WELLSYM, password: E2E_MEMBER_PASSWORD },
    // The sheet is reached from the dock puck, which is phone-only chrome.
    { viewport: { width: 390, height: 844 }, hasTouch: true }
  );
  try {
    await page.goto("/");
    // #3366 MOVED THE GESTURE, NOT THE CLAIM. The well-day bar used to be a card in
    // the dashboard tail; the ruling of 2026-08-29 retired the tail's generic write
    // cards because the quick logger is the app's one quick-write surface. Both
    // halves are asserted, so a tree where well-day logging vanished instead of
    // moving cannot pass: gone from the tail, offered by the sheet's Care segment.
    await openDashboardAll(page);
    await expect(
      dashboardCandidatePrefix(page, "symptom.well-day-log")
    ).toHaveCount(0);

    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "log-symptom");
    await row.click();
    const overlay = page.getByTestId("quick-entry-sheet");
    const bar = overlay.getByTestId("symptom-log-bar");
    await expect(bar).toBeVisible();
    await bar.getByTestId("symptom-add-picker-toggle").click();
    await settledClick(page, bar.getByTestId("symptom-pick-headache"));
    await settledClick(page, bar.getByTestId("symptom-headache-sev-3"));
    await expect(bar.getByTestId("symptom-headache-sev-3")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(bar.getByTestId("symptom-illness-bridge")).toBeVisible();

    await expect(async () => {
      await page.reload();
      await openDashboardAll(page);
      await expect(
        dashboardCandidateWithText(
          page,
          "coaching.recommendation:",
          "severe headache"
        )
      ).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 }); // topass-ok: re-read until the committed symptom log changes coaching
  } finally {
    resetWellSymptomState();
    await page.context().close();
  }
});

function setMoodCheckinState(
  profileName: string,
  count: number,
  eveningTime: string
): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(profileName) as { id: number } | undefined;
    if (!row) throw new Error(`no profile ${profileName}`);
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'mood_checkin_enabled', '1')
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    ).run(row.id);
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'mood_checkin_ignored', ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    ).run(row.id, String(count));
    db.prepare(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'notify_supp_evening_hour', ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
    ).run(row.id, eveningTime);
  } finally {
    db.close();
  }
}

test("a mood check-in crosses from read-only Ahead to actionable Now at its opening minute", async ({
  page,
}) => {
  const aheadProfile = await createProfileViaFamily(page, "checkinahead");
  setMoodCheckinState(aheadProfile, 0, moodOpeningTimes().oneMinuteLater);
  await page.goto("/");

  const aheadMood = dashboardCandidatePrefix(page, "checkin.mood");
  await expect(aheadMood).toBeVisible();
  await expect(aheadMood).toHaveAttribute("data-lane", "ahead");
  await expect(aheadMood.getByRole("button")).toHaveCount(0);

  const openProfile = await createProfileViaFamily(page, "checkinpause");
  setMoodCheckinState(openProfile, 5, moodOpeningTimes().exact);
  await page.goto("/");

  const openMood = dashboardCandidatePrefix(page, "checkin.mood");
  await expect(openMood).toBeVisible();
  await expect(openMood).toHaveAttribute("data-lane", "now");
  await expect(openMood).toContainText("Daily reminders are paused.");
  await expect(openMood.getByRole("button")).not.toHaveCount(0);
});

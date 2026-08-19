import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { createProfileViaFamily, switchToProfile } from "./family-helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_WELLSYM,
  E2E_MEMBER_PASSWORD,
  WELL_SYMPTOM_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import {
  dashboardCandidatePrefix,
  dashboardCandidateWithText,
} from "./dashboard-candidate";

const ADMIN_PROFILE = "admin";

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
  const page = await loginAs(browser, {
    username: E2E_LOGIN_WELLSYM,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const symptom = dashboardCandidatePrefix(page, "symptom.well-day-log");
    await expect(symptom).toBeVisible();
    await expect(symptom).toHaveAttribute("data-kind", "action");

    const bar = symptom.getByTestId("symptom-log-bar");
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

function setIgnoredStreak(profileName: string, count: number): void {
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
  } finally {
    db.close();
  }
}

test("the atomic mood action states when reminders are paused", async ({
  page,
}) => {
  const profile = await createProfileViaFamily(page, "checkinpause");
  setIgnoredStreak(profile, 5);
  await page.goto("/");

  const mood = dashboardCandidatePrefix(page, "checkin.mood");
  await expect(mood).toBeVisible();
  await expect(mood).toContainText("Daily reminders are paused.");
});

test("the atomic mood action omits pause copy while reminders run", async ({
  page,
}) => {
  const profile = await createProfileViaFamily(page, "checkinrunning");
  setIgnoredStreak(profile, 0);
  await page.goto("/");

  const mood = dashboardCandidatePrefix(page, "checkin.mood");
  await expect(mood).toBeVisible();
  await expect(mood).not.toContainText("paused");
});

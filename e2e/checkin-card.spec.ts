import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { appContent, settledClick } from "./helpers";
import { switchToProfile } from "./family-helpers";
import { loginAs } from "./nav";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import {
  E2E_LOGIN_WELLSYM,
  E2E_MEMBER_PASSWORD,
  WELL_SYMPTOM_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import { dashboardCandidatePrefix } from "./dashboard-candidate";

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
    // moving cannot pass: absent from `/`, offered by the sheet's Care segment.
    //
    // The absence is READ AGAINST A RENDERED PAGE (#5435 §4 removed the fold this
    // used to open). A count of 0 is what a 404, a redirect or an unrendered shell
    // also produce, so the Now band is proved on screen first and the absence is
    // only then believed.
    await expect(appContent(page).getByTestId("home-now")).toBeVisible();
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
    // The picker chip SELECTS (#4752 §3); the panel's one save is the write, so
    // that is where the settle is armed.
    await bar.getByTestId("symptom-pick-headache").click();
    await settledClick(page, bar.getByTestId("symptom-picker-save"));
    await settledClick(page, bar.getByTestId("symptom-headache-sev-3"));
    await expect(bar.getByTestId("symptom-headache-sev-3")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(bar.getByTestId("symptom-illness-bridge")).toBeVisible();

    // AND COACHING SAW IT. The committed severity reaches `reportedBurden`, which
    // adds the basis-aware rest tilt ("You logged severe headache today …") to the
    // recommendation's reason. That reason was read off the dashboard's coaching row;
    // Home's next-workout seat carries the TITLE only, so it is read where the reason
    // is printed in full — the Training overview's next-workout card, which renders
    // the same single computation (#221).
    // eslint-disable-next-line no-restricted-properties -- topass-ok: re-read until the committed symptom log changes coaching
    await expect(async () => {
      await page.goto("/training?tab=overview");
      await expect(
        appContent(page).getByTestId("next-workout-card")
      ).toContainText("severe headache", { timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
  } finally {
    resetWellSymptomState();
    await page.context().close();
  }
});

// THE AHEAD→NOW CROSSING WAS THE RANKER'S (#5435 §4).
//
// A test here proved the mood check-in row crosses lanes at its opening minute: before
// it, `data-lane="ahead"` and NO button — a read-only preview of something not yet
// actionable; at it, `data-lane="now"`, the "Daily reminders are paused." sentence for
// a profile that has ignored five, and a control the reader can press.
//
// Both halves of that claim are the ranker's. `checkin.mood` is a
// `dailyCandidates.moodCheckin` candidate, the lanes are the placement canvas's, and
// Home v3 seats fixed kinds (dose, practice, care, training, fast, period) — it builds
// no daily candidates and has no Ahead lane, so the row has no surface to cross on.
//
// WHAT RETIRED: the RENDERED read-only-versus-actionable distinction at the minute
// boundary. What did not: the builder and its lane derivation, which are untouched and
// belong to PR 3 with the rest of the ranker, and the check-in's Telegram half, which
// is covered in lib/__db_tests__/mood-log-store.test.ts and the telegram-commands
// tests. `setMoodCheckinState`, which existed only for this test, went with it.

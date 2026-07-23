// Issue #1151 — Upcoming's "Snoozed & dismissed" section aggregates EVERYTHING
// on the suppression bus: a care snooze (appointment), a coaching dismissal
// (training-obs plateau), and a suggestion dismissal (a med-bridge key) render
// together, grouped, each with a Restore; restoring the suggestion removes it
// from the section. (The med-bridge key has no backing record — post-#1178/092
// the app cannot produce medical_records 'prescription' rows, and a dismissal
// that outlived its record is a real current-state shape the section must still
// label + restore, #1232.)
//
// Fixture ownership (#868): the dedicated SUPPRESSED_PROFILE + member login
// (seed-events.ts); each test re-asserts its own suppression rows directly in
// the DB (the resetDataQualityDismissals pattern) so retries/--repeat-each
// start from the seeded state. Blast radius: only this fixture profile's
// upcoming_dismissals rows.

import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_SUPPRESSED,
  SUPPRESSED_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

const COACHING_KEY = "training-obs:plateau:e2e suppressed lift";
const BRIDGE_KEY = "med-bridge:e2e suppressed rx";

// Re-assert the fixture's three suppression rows (a prior run's Restore removed
// some) so every test starts from the seeded state.
function resetSuppressions(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const prof = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(SUPPRESSED_PROFILE) as { id: number } | undefined;
    if (!prof) throw new Error("suppressed-center fixture profile missing");
    const appt = db
      .prepare(
        "SELECT id FROM appointments WHERE profile_id = ? AND title = 'E2E Suppressed Appointment'"
      )
      .get(prof.id) as { id: number } | undefined;
    if (!appt) throw new Error("suppressed-center fixture appointment missing");
    const del = db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
    );
    const snoozeUntil = db
      .prepare("SELECT date('now', '+3 days') AS d")
      .get() as { d: string };
    del.run(prof.id, `appointment:${appt.id}`);
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until)
       VALUES (?, ?, ?)`
    ).run(prof.id, `appointment:${appt.id}`, snoozeUntil.d);
    for (const key of [COACHING_KEY, BRIDGE_KEY]) {
      del.run(prof.id, key);
      db.prepare(
        `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
         VALUES (?, ?, datetime('now'))`
      ).run(prof.id, key);
    }
  } finally {
    db.close();
  }
}

test("Snoozed & dismissed spans care + coaching + suggestion rows, grouped with Restore (#1151)", async ({
  browser,
}) => {
  resetSuppressions();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SUPPRESSED,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/upcoming");

  const section = page.getByTestId("suppressed-section");
  await expect(section).toBeVisible();
  await section.locator("summary").click();

  // The CARE snooze — richly reconstructed with its real title + snooze date.
  const careRow = section
    .getByTestId("suppressed-row")
    .filter({ hasText: "E2E Suppressed Appointment" });
  await expect(careRow).toBeVisible();
  await expect(careRow).toContainText("Snoozed until");

  // The COACHING dismissal — resolver-labelled from its key's subject.
  const coachingRow = section
    .getByTestId("suppressed-row")
    .filter({ hasText: "Plateau — E2e Suppressed Lift" });
  await expect(coachingRow).toBeVisible();
  await expect(coachingRow).toContainText("Dismissed");

  // The SUGGESTION dismissal — labelled with the drug name.
  const bridgeRow = section
    .getByTestId("suppressed-row")
    .filter({ hasText: "Untracked prescription — E2e Suppressed Rx" });
  await expect(bridgeRow).toBeVisible();

  // Domain group headings render.
  await expect(section).toContainText("Coaching");
  await expect(section).toContainText("Suggestions");

  // Every row carries a Restore.
  await expect(careRow.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(
    coachingRow.getByRole("button", { name: "Restore" })
  ).toBeVisible();
});

test("restoring a suggestion dismissal clears it from the section (#1151)", async ({
  browser,
}) => {
  resetSuppressions();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SUPPRESSED,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/upcoming");

  const section = page.getByTestId("suppressed-section");
  await section.locator("summary").click();
  const bridgeRow = section
    .getByTestId("suppressed-row")
    .filter({ hasText: "Untracked prescription — E2e Suppressed Rx" });
  await expect(bridgeRow).toBeVisible();
  await settledClick(page, bridgeRow.getByRole("button", { name: "Restore" }));
  await expect(bridgeRow).toHaveCount(0);
  // (No origin-surface reappearance to assert: post-#1178/092 the bridge's
  // backing 'prescription' records cannot exist, so Restore's job here is
  // simply clearing the outlived key — the #203 orphan-pruning behavior.)
});

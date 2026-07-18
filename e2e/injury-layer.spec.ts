import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { settledClick } from "./helpers";

// Issue #838 — the injury layer. Logging a user-declared injury makes the shared
// recommendation model TRAIN AROUND the affected region and DISCLOSE why on the card
// ("Avoiding Chest (… injury)"), never silently; resolving the injury restores normal
// coaching. Coaching-tier: no notifications — this is a pure read/log surface.
//
// OWNS ITS FIXTURE (create-and-clean, #868): injuries is a brand-new table with no seed
// rows, and the spec logs its own injury on the default (admin/profile-1) session and
// wipes profile 1's injuries in beforeAll AND afterAll, so it never asserts against a
// shared-seed row and leaves the DB as it found it (the exclusion disclosure is derived
// purely from the active injury the test just logged, independent of seeded history).

function wipeInjuries(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare("DELETE FROM injuries WHERE profile_id = 1").run();
  } finally {
    db.close();
  }
}

test.beforeAll(() => wipeInjuries());
test.afterAll(() => wipeInjuries());

test("log an injury → recommendation avoids the region and names why → resolve → normal (#838)", async ({
  page,
}) => {
  // The injury bar lives on the Training → Overview tab (the Log tab is the default).
  await page.goto("/training?tab=overview");

  const bar = page.getByRole("main").getByTestId("injury-bar");
  await expect(bar).toBeVisible();

  // Open the quick-log form (a pure client toggle — no POST).
  await bar.getByTestId("injury-add-toggle").click();
  const form = bar.getByTestId("injury-form");
  await expect(form).toBeVisible();

  // Log a right-shoulder injury that puts Chest off the table.
  await form.getByTestId("injury-label-input").fill("right shoulder");
  await form.getByTestId("injury-region-Chest").check();
  await settledClick(page, form.getByTestId("injury-submit"));

  // The injury chip is listed as Active, naming Chest.
  const chip = bar
    .getByTestId("injury-chip")
    .filter({ hasText: "right shoulder" });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Active");
  await expect(chip).toContainText("Chest");

  // The recommendation disclosure NAMES the excluded region — never silent.
  const notes = page.getByRole("main").getByTestId("training-context-notes");
  await expect(notes).toBeVisible();
  await expect(page.getByTestId("injury-exclusion-note")).toContainText(
    "Avoiding Chest (right shoulder injury)"
  );

  // Resolve the injury — the record is kept but the exclusion lifts.
  await settledClick(page, chip.getByTestId("injury-set-resolved"));

  // The active chip is gone (resolved injuries drop out of the current list) and the
  // exclusion disclosure no longer names Chest — normal coaching resumes.
  await expect(
    bar.getByTestId("injury-chip").filter({ hasText: "right shoulder" })
  ).toHaveCount(0);
  await expect(page.getByTestId("injury-exclusion-note")).toHaveCount(0);
});

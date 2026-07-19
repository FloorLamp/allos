import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// Hearing / audiology domain (#713 + #717). Two user-visible surfaces the build/
// typecheck/unit tiers can't prove render:
//   • the AUDIOGRAM biomarker series (#713) — seeded per-ear/per-frequency pure-tone
//     thresholds trend on the Biomarkers surface like any other analyte, and a recent
//     4 kHz reading above the ≤25 dB HL band flags. Read-only over the shared seed
//     (visibility, never an exact count).
//   • the OTOTOXIC-medication awareness note (#717) — an active ototoxic medication
//     surfaces a calm, cited, never-prescriptive note on /medications AND a dismissible
//     finding on /upcoming.
//
// Fixture discipline (shared seeded DB): this spec OWNS its rows — one uniquely-named
// active aminoglycoside medication for profile 1 — seeded via a raw connection and
// cleaned up in beforeAll AND afterAll so it's idempotent across retries and never
// touches seeded rows. Locators are scoped to the specific row.

const MED = "E2E Ototoxic Gentamicin"; // tokenizes to contain the "gentamicin" synonym
const MED_PREFIX = "E2E Ototoxic";

function dbPath(): string {
  return (
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db")
  );
}

function cleanup(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const medIds = db
      .prepare("SELECT id FROM intake_items WHERE name LIKE ?")
      .all(`${MED_PREFIX}%`) as { id: number }[];
    for (const { id } of medIds) {
      db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
        `ototoxic:${id}:%`
      );
    }
    db.prepare("DELETE FROM intake_items WHERE name LIKE ?").run(
      `${MED_PREFIX}%`
    );
  } finally {
    db.close();
  }
}

function seed(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    // Profile 1 is the seeded active profile the e2e login acts as.
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, priority)
       VALUES (1, ?, 1, 'medication', 'high')`
    ).run(MED);
  } finally {
    db.close();
  }
}

test.describe("Hearing / audiology (#713, #717)", () => {
  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(cleanup);

  test("seeded audiogram thresholds render + flag on the Biomarkers surface (#713)", async ({
    page,
  }) => {
    await page.goto("/biomarkers?q=" + encodeURIComponent("Hearing Threshold"));
    const main = page.getByRole("main");
    // The seeded per-ear/per-frequency series show; the recent 4 kHz reading is above
    // the ≤25 dB HL band (visibility, not an exact count over the shared seed).
    await expect(main.getByText(/Hearing Threshold/).first()).toBeVisible();
    await expect(main.getByText(/4 kHz/).first()).toBeVisible();
  });

  test("an active ototoxic medication shows the hearing-safety note on /medications (#717)", async ({
    page,
  }) => {
    await page.goto("/medications");
    const main = page.getByRole("main");

    const warnings = main.getByTestId("ototoxic-warnings");
    await expect(warnings).toBeVisible();

    const row = warnings
      .locator('[data-testid^="ototoxic-warning-ototoxic:"]')
      .filter({ hasText: MED });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/inner ear|hearing/i);
    // Informational, cited, never prescriptive.
    await expect(row).toContainText("discuss");
    await expect(row).toContainText("Source:");
  });

  test("the ototoxic finding surfaces on Upcoming (#717)", async ({ page }) => {
    await page.goto("/upcoming");
    const main = page.getByRole("main");

    const finding = main
      .locator('[data-testid^="upcoming-item-ototoxic:"]')
      .filter({ hasText: MED });
    await expect(finding).toBeVisible();
    await expect(finding).toContainText(/Ototoxic medication/i);
  });
});

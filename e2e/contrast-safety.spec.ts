import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// Contrast-safety cross-check (issue #701): an ORDERED/PLANNED contrast imaging study
// (here a care-plan item whose text indicates contrast) meeting a contrast/iodine
// allergy on file must surface (a) an inline note on /care-plan and (b) a dismissible
// finding on Upcoming — the same care-tier shape as the drug–drug interaction / PGx
// safety notes. The note relays the ACR guidance AS INFORMATION; never prescriptive.
//
// Fixture discipline (shared seeded DB): this spec owns its OWN rows — a uniquely
// prefixed care-plan item + an iodinated-contrast allergy — seeded via a raw
// connection and cleaned up in beforeAll AND afterAll so it's idempotent across
// retries and never touches seeded rows. Locators are scoped to the specific note
// (never .first() on the shared surface).

const PREFIX = "E2E CONTRAST";
const CARE_ITEM = `${PREFIX} CT abdomen with contrast`;
const ALLERGEN = `${PREFIX} iodinated contrast`;

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
    const cpIds = db
      .prepare("SELECT id FROM care_plan_items WHERE description LIKE ?")
      .all(`${PREFIX}%`) as { id: number }[];
    for (const { id } of cpIds) {
      db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key LIKE ?").run(
        `contrast:careplan:${id}:%`
      );
    }
    db.prepare("DELETE FROM care_plan_items WHERE description LIKE ?").run(
      `${PREFIX}%`
    );
    db.prepare("DELETE FROM allergies WHERE substance LIKE ?").run(
      `${PREFIX}%`
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
      `INSERT INTO care_plan_items (profile_id, description, status, planned_date)
       VALUES (1, ?, 'active', '2099-03-01')`
    ).run(CARE_ITEM);
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status) VALUES (1, ?, 'active')`
    ).run(ALLERGEN);
  } finally {
    db.close();
  }
}

test.describe("Contrast-safety cross-check (#701)", () => {
  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(cleanup);

  test("shows the iodinated-contrast allergy note inline on /care-plan", async ({
    page,
  }) => {
    await page.goto("/care-plan");
    const notes = page.getByTestId("contrast-safety-notes");
    await expect(notes).toBeVisible();

    const note = notes
      .locator('[data-testid^="contrast-note-contrast:"]')
      .filter({ hasText: "CT abdomen with contrast" });
    await expect(note).toBeVisible();
    await expect(note).toContainText("Iodinated contrast");
    await expect(note).toContainText(
      "confirm premedication with your provider"
    );
    await expect(note).toContainText(
      "does not advise for or against the study"
    );
    await expect(note).toContainText("Source:");
  });

  test("surfaces the contrast finding on Upcoming", async ({ page }) => {
    await page.goto("/upcoming");
    const main = page.getByRole("main");

    const finding = main
      .locator('[data-testid^="upcoming-item-contrast:"]')
      .filter({ hasText: "CT abdomen with contrast" });
    await expect(finding).toBeVisible();
    await expect(finding).toContainText("Iodinated contrast");
  });
});

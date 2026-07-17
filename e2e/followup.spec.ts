import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";

// The finding follow-up loop (#700): an incidental imaging finding → a tracked,
// LEGIBLE follow-up on Upcoming → a resolution OFFER when a later study lands →
// close the loop. Drives the real UI end-to-end across /imaging + /upcoming.
//
// Fixture discipline (#868, shared seeded DB): a unique body-region marker scopes
// every row, and a raw-connection cleanup in beforeAll AND afterAll (deleting the
// linked care_plan_items follow-ups BEFORE the imaging_studies FK parents) makes the
// spec idempotent across CI retries — it only ever touches rows it created. All
// settled interactions go through e2e/helpers.ts (settledClick / followLink).
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const REGION = "E2EFUPCHEST";
const SOURCE_IMPRESSION = "6 mm RLL nodule E2EFUP";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `DELETE FROM care_plan_items
           WHERE source_imaging_study_id IN (
             SELECT id FROM imaging_studies WHERE body_region = ?
           )`
      )
      .run(REGION);
    handle
      .prepare("DELETE FROM imaging_studies WHERE body_region = ?")
      .run(REGION);
  } finally {
    handle.close();
  }
}

// Add one imaging study through the real form.
async function addStudy(
  page: import("@playwright/test").Page,
  opts: { date: string; impression: string }
) {
  await page.goto("/imaging");
  const form = page.getByTestId("imaging-study-form");
  await expect(form).toBeVisible();
  await form.getByLabel("Modality").selectOption("ct");
  await form.getByLabel("Body region").fill(REGION);
  await form.getByLabel("Study date").fill(opts.date);
  await form.getByLabel("Impression").fill(opts.impression);
  await settledClick(
    page,
    form.getByRole("button", { name: "Add", exact: true })
  );
  await expect(page.getByText("Study saved")).toBeVisible();
}

test.describe("Finding follow-up loop — track → legible upcoming → resolve (#700)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("an imaging finding becomes a tracked, resolvable follow-up", async ({
    page,
  }) => {
    test.slow();

    // 1) A source study with an incidental finding, dated well in the past so its
    //    follow-up is OVERDUE (surfaces on Upcoming immediately).
    await addStudy(page, { date: "2024-01-15", impression: SOURCE_IMPRESSION });

    // 2) Track a 3-month follow-up from the study's own row.
    const list = page.getByTestId("imaging-study-list");
    const sourceRow = list
      .getByRole("row")
      .filter({ hasText: SOURCE_IMPRESSION });
    await sourceRow.getByLabel("Follow-up interval").selectOption("91");
    await settledClick(
      page,
      sourceRow.getByRole("button", { name: "Track follow-up" })
    );
    // The study row now shows the tracked follow-up's state.
    await expect(sourceRow.getByText(/Follow-up:/)).toBeVisible();

    // 3) It surfaces on Upcoming — LEGIBLE: named for its source finding (#656 reason).
    await page.goto("/upcoming");
    const item = page
      .locator('[data-testid^="upcoming-item-followup:"]')
      .filter({ hasText: SOURCE_IMPRESSION });
    await expect(item).toBeVisible();
    await expect(item).toContainText("Follow-up CT");
    await expect(item).toContainText(SOURCE_IMPRESSION);
    // No resolution offer yet (no later study on file).
    await expect(
      item.locator('[data-testid^="followup-resolve-"]')
    ).toHaveCount(0);

    // 4) A later matching CT lands → the follow-up now OFFERS the outcome.
    await addStudy(page, {
      date: "2025-11-01",
      impression: "E2EFUP interval follow",
    });
    await page.goto("/upcoming");
    const offering = page
      .locator('[data-testid^="upcoming-item-followup:"]')
      .filter({ hasText: SOURCE_IMPRESSION });
    await expect(offering).toBeVisible();
    const stable = offering.getByRole("button", { name: "Stable" });
    await expect(stable).toBeVisible();

    // 5) Confirm-first resolve closes the loop — the item drops off Upcoming.
    await settledClick(page, stable);
    await expect(
      page
        .locator('[data-testid^="upcoming-item-followup:"]')
        .filter({ hasText: SOURCE_IMPRESSION })
    ).toHaveCount(0);

    // 6) The source study now shows the recorded resolution.
    await page.goto("/imaging");
    await expect(
      page
        .getByTestId("imaging-study-list")
        .getByRole("row")
        .filter({ hasText: SOURCE_IMPRESSION })
        .getByText(/Follow-up: resolved · stable/)
    ).toBeVisible();
  });
});

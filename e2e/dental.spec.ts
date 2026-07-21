import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Dental-record CRUD on the Dental section of /records (#705, folded #1042): add a tooth-anchored procedure through the
// real form, see it in the list with its tooth + status shown, filter by status,
// track a recheck follow-up on a watch finding, edit, then delete. Drives the real UI
// end-to-end.
//
// Fixture discipline (shared seeded DB): a unique tooth marker scopes every action and
// a raw-connection cleanup in beforeAll AND afterAll makes the spec idempotent across
// CI retries — it only ever touches rows it created (dental_procedures + any care-plan
// follow-up it seeds off them).
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const TOOTH = "97"; // out of the 1–32 seeded range → collision-free marker
const NAME = "E2EDentalWatch";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `DELETE FROM care_plan_items
          WHERE source_kind = 'dental'
            AND source_dental_procedure_id IN
              (SELECT id FROM dental_procedures WHERE tooth = ?)`
      )
      .run(TOOTH);
    handle.prepare("DELETE FROM dental_procedures WHERE tooth = ?").run(TOOTH);
  } finally {
    handle.close();
  }
}

test.describe("Dental records — add → view → filter → track recheck → edit → delete (#705)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("stores a tooth-anchored record and shows it factually", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/specialty/dental");
    const form = page.getByTestId("dental-procedure-form");
    await expect(form).toBeVisible();

    // Add a caries WATCH finding on tooth #97 with a recheck interval.
    await form.getByLabel("Procedure / finding").fill(NAME);
    await form.getByLabel("Status").selectOption("watch");
    await form.getByLabel("Tooth").fill(TOOTH);
    await form.getByLabel("Finding / note").fill("Watch for recurrent decay.");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Record saved")).toBeVisible();

    // It appears in the list with its display label, tooth, and a status badge.
    const list = page.getByTestId("dental-procedure-list");
    const row = list.getByRole("row").filter({ hasText: NAME });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`#${TOOTH}`);
    await expect(row).toContainText("watch");

    // Filtering by "Completed" hides it; back to "Watch" shows it again.
    await list.getByLabel("Filter by status").selectOption("completed");
    await expect(list.getByRole("row").filter({ hasText: NAME })).toHaveCount(
      0
    );
    await list.getByLabel("Filter by status").selectOption("watch");
    await expect(list.getByRole("row").filter({ hasText: NAME })).toBeVisible();

    // Track a recheck follow-up on it — the row's control turns into a tracked state.
    const trackForm = page.getByTestId(/^track-dental-followup-/);
    await trackForm
      .locator("select")
      .first()
      .selectOption({ label: "6 months" });
    await trackForm
      .getByRole("button", { name: "Track recheck" })
      .first()
      .click();
    await expect(page.getByTestId(/^dental-followup-state-/)).toContainText(
      "Recheck:",
      { timeout: 15000 }
    );

    // Edit it: change the finding note.
    await list
      .getByRole("row")
      .filter({ hasText: NAME })
      .getByRole("button", { name: "Edit" })
      .click();
    const editForm = list.getByTestId("dental-procedure-form");
    await editForm.getByLabel("Finding / note").fill("Interval stable.");
    await editForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Record updated")).toBeVisible();
    await expect(list.getByRole("row").filter({ hasText: NAME })).toContainText(
      "Interval stable."
    );

    // Delete it and confirm it's gone. The confirm click MUST be scoped to the dialog
    // (every row carries a per-row aria-label="Delete" button).
    const survivor = list.getByRole("row").filter({ hasText: NAME });
    await survivor.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(list.getByRole("row").filter({ hasText: NAME })).toHaveCount(
      0
    );
  });
});

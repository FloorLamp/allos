import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Imaging-study CRUD on /imaging (#702): add a structured study through the real
// form, see it in the list with its modality + contrast shown, filter by modality,
// edit its impression, then delete it. Drives the real UI end-to-end.
//
// Fixture discipline (shared seeded DB): a unique body-region marker scopes every
// action and a raw-connection cleanup in beforeAll AND afterAll makes the spec
// idempotent across CI retries — it only ever touches rows it created.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const REGION = "E2EREGION1";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM imaging_studies WHERE body_region = ?")
      .run(REGION);
  } finally {
    handle.close();
  }
}

test.describe("Imaging studies — add → view → filter → edit → delete (#702)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("stores a structured study and shows it factually", async ({ page }) => {
    test.slow();

    await page.goto("/imaging");
    const form = page.getByTestId("imaging-study-form");
    await expect(form).toBeVisible();

    // Add an MRI with contrast.
    await form.getByLabel("Modality").selectOption("mri");
    await form.getByLabel("Body region").fill(REGION);
    await form.getByLabel("Laterality").selectOption("left");
    await form.getByLabel("Contrast given").check();
    await form.getByLabel("Impression").fill("No acute abnormality.");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Study saved")).toBeVisible();

    // It appears in the list with its factual identity + contrast badge.
    const list = page.getByTestId("imaging-study-list");
    const row = list.getByRole("row").filter({ hasText: REGION });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`MRI Left ${REGION}`);
    await expect(row).toContainText("contrast");

    // Filtering by a different modality hides it; back to MRI shows it again.
    await list.getByLabel("Filter by modality").selectOption("ct");
    await expect(list.getByRole("row").filter({ hasText: REGION })).toHaveCount(
      0
    );
    await list.getByLabel("Filter by modality").selectOption("mri");
    await expect(
      list.getByRole("row").filter({ hasText: REGION })
    ).toBeVisible();

    // Edit it: change the impression.
    await list
      .getByRole("row")
      .filter({ hasText: REGION })
      .getByRole("button", { name: "Edit" })
      .click();
    const editForm = list.getByTestId("imaging-study-form");
    await editForm.getByLabel("Impression").fill("Interval improvement.");
    await editForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Study updated")).toBeVisible();
    await expect(
      list.getByRole("row").filter({ hasText: REGION })
    ).toContainText("Interval improvement.");

    // Delete it and confirm it's gone. The confirm click MUST be scoped to the
    // dialog: the page also carries one per-row aria-label="Delete" button for every
    // study (incl. the seeded rows), so an unscoped getByRole("button", { name:
    // "Delete" }) is a strict-mode collision.
    const survivor = list.getByRole("row").filter({ hasText: REGION });
    await survivor.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(list.getByRole("row").filter({ hasText: REGION })).toHaveCount(
      0
    );
  });
});

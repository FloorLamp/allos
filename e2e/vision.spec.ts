import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Optical-prescription CRUD on /vision (#697): add a structured Rx through the real
// form, see it in the list with its per-eye sphere shown, edit it, then delete it.
// Drives the real UI end-to-end.
//
// Fixture discipline (shared seeded DB, #868): a distinctive marker sphere scopes
// every action and a raw-connection cleanup in beforeAll AND afterAll makes the spec
// idempotent across CI retries — it only ever touches rows it created (a create-and-
// clean block, the same pattern the imaging spec uses). The marker sphere (-6.25) is
// far from any seeded value so it can't collide with the seed's progression rows.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const MARKER = -6.25;

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM optical_prescriptions WHERE od_sphere = ?")
      .run(MARKER);
  } finally {
    handle.close();
  }
}

test.describe("Optical prescriptions — add → view → edit → delete (#697)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("stores a structured prescription and shows it factually", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/vision");
    const form = page.getByTestId("optical-prescription-form");
    await expect(form).toBeVisible();

    // Add a glasses Rx with the marker OD sphere.
    await form.getByLabel("Type").selectOption("glasses");
    await form.getByLabel("Sphere").first().fill(String(MARKER));
    await form.getByLabel("PD (mm)").fill("64");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Prescription saved")).toBeVisible();

    // It appears in the list with its factual per-eye identity.
    const list = page.getByTestId("optical-prescription-list");
    const row = list.getByRole("row").filter({ hasText: "-6.25" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Glasses");

    // Edit it: change the OS (left eye) sphere — the second "Sphere" input — to a
    // distinctive value and confirm the row reflects it. OD stays the -6.25 marker.
    await row.getByRole("button", { name: "Edit" }).click();
    const editForm = list.getByTestId("optical-prescription-form");
    await editForm.getByLabel("Sphere").nth(1).fill("-3.50");
    await editForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Prescription updated")).toBeVisible();
    await expect(
      list.getByRole("row").filter({ hasText: "-6.25" })
    ).toContainText("OS -3.50");

    // Delete it and confirm it's gone. The confirm click MUST be scoped to the
    // dialog — the page carries a per-row Delete button for every seeded Rx too.
    const survivor = list.getByRole("row").filter({ hasText: "-6.25" });
    await survivor.getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(
      list.getByRole("row").filter({ hasText: "-6.25" })
    ).toHaveCount(0);
  });
});

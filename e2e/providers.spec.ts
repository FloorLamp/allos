import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Provider registry pages + duplicate merge (issue #275). The seed plants two
// near-duplicate rows for the same clinician — "Dr. Anita Patel" (NPI) and the
// import-minted "Dr. Anita Patel MD" (no NPI) — the latter linked to a "Follow-up"
// visit and a "Blood pressure check" procedure. We drive: index → detail → (admin)
// merge the duplicate into the survivor → the moved records survive on the survivor
// and the absorbed provider's page 404s.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

function providerId(name: string): number {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT id FROM providers WHERE name = ? ORDER BY id LIMIT 1")
      .get(name) as { id: number } | undefined;
    if (!row) throw new Error(`no seeded provider "${name}"`);
    return row.id;
  } finally {
    db.close();
  }
}

test.describe("Providers registry", () => {
  // The merge test permanently deletes a seeded duplicate, so these run in order
  // in one worker (the detail read must precede the merge that absorbs it).
  test.describe.configure({ mode: "serial" });

  test("index lists providers, searches, and links to a detail page", async ({
    page,
  }) => {
    await page.goto("/providers");
    const list = page.getByTestId("provider-list");
    await expect(list).toBeVisible();
    await expect(
      list.getByText("Dr. Anita Patel", { exact: true })
    ).toBeVisible();
    await expect(list.getByText("Quest Diagnostics")).toBeVisible();

    // Type filter → organizations only drops the individual clinicians.
    await page.getByTestId("provider-type-filter").selectOption("organization");
    await expect(list.getByText("Quest Diagnostics")).toBeVisible();
    await expect(
      list.getByText("Dr. Anita Patel", { exact: true })
    ).toHaveCount(0);

    // Search narrows to a single provider and its detail link works.
    await page.getByTestId("provider-type-filter").selectOption("all");
    await page.getByTestId("provider-search").fill("Quest");
    await expect(
      list.getByText("Dr. Anita Patel", { exact: true })
    ).toHaveCount(0);
    await list.getByText("Quest Diagnostics").click();
    await expect(page).toHaveURL(/\/providers\/\d+$/);
    await expect(page.getByTestId("provider-detail")).toBeVisible();
  });

  test("a provider detail page shows the per-profile activity scope note", async ({
    page,
  }) => {
    await page.goto(`/providers/${providerId("Dr. Anita Patel MD")}`);
    const detail = page.getByTestId("provider-detail");
    await expect(detail).toBeVisible();
    // The activity is explicitly labeled as the active profile's.
    await expect(detail.getByText(/records with this provider/i)).toBeVisible();
    // The duplicate's linked visit + procedure show under Activity.
    await detail.getByTestId("activity-summary-visits").click();
    await expect(detail.getByText("Follow-up")).toBeVisible();
    await detail.getByTestId("activity-summary-procedures").click();
    await expect(detail.getByText("Blood pressure check")).toBeVisible();
  });

  test("admin merges a duplicate; its records survive on the survivor", async ({
    page,
  }) => {
    const survivor = providerId("Dr. Anita Patel");
    const duplicate = providerId("Dr. Anita Patel MD");

    await page.goto(`/providers/${survivor}`);
    const merge = page.getByTestId("provider-merge");
    await expect(merge).toBeVisible();

    // Pick the duplicate and merge; confirm the count-only dialog.
    await page
      .getByTestId("provider-merge-select")
      .selectOption(String(duplicate));
    await page.getByTestId("provider-merge-button").click();
    // Scope to the confirm dialog — the opener button is also named "Merge".
    await page
      .getByLabel(/^Merge into /)
      .getByRole("button", { name: "Merge" })
      .click();

    // Redirects back to the survivor with a merged marker.
    await expect(page).toHaveURL(
      new RegExp(`/providers/${survivor}\\?merged=1`)
    );

    // The absorbed provider's linked records now live on the survivor.
    const detail = page.getByTestId("provider-detail");
    await detail.getByTestId("activity-summary-visits").click();
    await expect(detail.getByText("Follow-up")).toBeVisible();
    await detail.getByTestId("activity-summary-procedures").click();
    await expect(detail.getByText("Blood pressure check")).toBeVisible();

    // The absorbed provider is gone — its detail page 404s.
    const resp = await page.goto(`/providers/${duplicate}`);
    expect(resp?.status()).toBe(404);
  });
});

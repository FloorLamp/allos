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

function withDb<T>(fn: (db: InstanceType<typeof Database>) => T): T {
  const db = new Database(DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Every provider-link column the merge re-points — mirrors PROVIDER_LINK_COLUMNS
// in lib/provider-merge.ts (kept literal here: Playwright specs don't share the
// app's module graph). Used to snapshot/restore the merge test's fixture state.
const PROVIDER_LINKS: { table: string; column: string }[] = [
  { table: "medical_records", column: "provider_id" },
  { table: "immunizations", column: "provider_id" },
  { table: "intake_items", column: "provider_id" },
  { table: "encounters", column: "provider_id" },
  { table: "encounters", column: "location_provider_id" },
  { table: "procedures", column: "provider_id" },
  { table: "care_plan_items", column: "provider_id" },
  { table: "appointments", column: "provider_id" },
];

// Pre-merge snapshot of the absorbed duplicate + its linked row ids, captured by
// the merge test and replayed by its afterAll restore.
let savedDupRow: Record<string, unknown> | undefined;
let savedLinks: { table: string; column: string; ids: number[] }[] = [];

test.describe("Providers registry", () => {
  // The merge test permanently deletes a seeded duplicate, so these run in order
  // in one worker (the detail read must precede the merge that absorbs it).
  test.describe.configure({ mode: "serial" });

  test("index lists providers, searches, and links to a detail page", async ({
    page,
  }) => {
    await page.goto("/providers");
    // ProvidersIndex is a client component (search + type filter); wait for the
    // network to settle so it has hydrated before we click a row's <Link> —
    // clicking pre-hydration swallows the client navigation (the URL never
    // changes), which flaked the detail-link click below.
    await page.waitForLoadState("networkidle");
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
    // The filter is a synchronous client re-render, so target the row's <a>
    // (role=link) and wait for the list to settle to the single match before
    // clicking — clicking the inner text span mid-reconciliation raced the Next
    // Link handler and left the page on /providers (flaky nav).
    const questRow = list.getByRole("link", { name: /Quest Diagnostics/ });
    await expect(questRow).toHaveCount(1);
    await questRow.click();
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

    // Snapshot the duplicate row + every row linked to it, so afterAll can undo
    // the merge (which permanently deletes the duplicate) — a retry of this
    // serial group, and any later spec, must see the original fixture.
    savedDupRow = withDb(
      (db) =>
        db.prepare("SELECT * FROM providers WHERE id = ?").get(duplicate) as
          Record<string, unknown> | undefined
    );
    if (!savedDupRow) throw new Error("duplicate provider fixture missing");
    savedLinks = withDb((db) =>
      PROVIDER_LINKS.map(({ table, column }) => ({
        table,
        column,
        ids: (
          db
            .prepare(`SELECT id FROM ${table} WHERE ${column} = ?`)
            .all(duplicate) as { id: number }[]
        ).map((r) => r.id),
      }))
    );

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

    // The absorbed provider is gone — its detail renders the not-found page.
    // The (app) layout streams through a root loading.tsx, so the HTTP status of
    // the document is always 200 and notFound() can only swap the rendered UI —
    // that rendered outcome is the observable contract, not the status code.
    await page.goto(`/providers/${duplicate}`);
    await expect(page.getByTestId("provider-detail")).toHaveCount(0);
    // #478 replaced the per-page missing-provider message with the shared (app)
    // not-found boundary — assert its stable testid + copy.
    await expect(page.getByTestId("app-not-found")).toBeVisible();
    await expect(
      page.getByText(/doesn.t exist, or you don.t have access/i)
    ).toBeVisible();
  });

  // Undo the merge so retries of this serial group and later specs see the
  // original fixture: re-insert the absorbed provider row verbatim (same id and
  // dedup_key) and point its captured rows back. No-op when the merge test never
  // captured a snapshot (an earlier test failed) or the row still exists.
  test.afterAll(() => {
    if (!savedDupRow) return;
    const row = savedDupRow;
    withDb((db) => {
      const exists = db
        .prepare("SELECT 1 FROM providers WHERE id = ?")
        .get(row.id);
      if (exists) return;
      const cols = Object.keys(row);
      db.prepare(
        `INSERT INTO providers (${cols.join(", ")}) VALUES (${cols
          .map(() => "?")
          .join(",")})`
      ).run(...cols.map((c) => row[c]));
      for (const { table, column, ids } of savedLinks) {
        for (const id of ids) {
          db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(
            row.id,
            id
          );
        }
      }
    });
  });
});

import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { settledClick, followLink } from "./helpers";

// The provider-domain closeout sweep (#1055/#1056/#1057/#1058/#1088), driven as the
// seeded admin against the dedicated "(e2e)" provider fixtures planted by
// e2e/seed-events.ts (Dr. Cora Bell ↔ Bell Cardiology affiliation with a Cardiology
// specialty; a co-occurring Dr. Sam Ng / Ng Family Practice pair with no edge → a
// suggestion; a seeded-archived Retired Clinic). Covers: the grouped directory
// (org card + nested individual + specialty chip), the detail "Practices at" tie-in,
// declining a suggestion, the archive round-trip, and #1088 (a vision form sets a
// provider that then appears in that provider's directory activity).
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

test.describe("Provider registry closeout", () => {
  test.describe.configure({ mode: "serial" });

  test("grouped directory nests an affiliated individual with a specialty chip (#1055/#1056)", async ({
    page,
  }) => {
    await page.goto("/records#providers");
    // The org card for the affiliated practice, with its nested clinician.
    const orgCard = page
      .getByTestId("provider-org-card")
      .filter({ hasText: "Bell Cardiology (e2e)" });
    await expect(orgCard).toBeVisible();
    await expect(orgCard.getByText("Dr. Cora Bell (e2e)")).toBeVisible();
    // The nested individual carries the #1056 specialty chip.
    await expect(
      orgCard
        .getByTestId("provider-specialty-chip")
        .filter({ hasText: "Cardiology" })
    ).toBeVisible();

    // Archived providers sit behind the disclosure, not the main directory.
    const disclosure = page.getByTestId("provider-archived-disclosure");
    await expect(disclosure).toContainText("Archived");
    await expect(disclosure).toContainText("Retired Clinic (e2e)");
  });

  test("individual detail shows Practices at → the affiliated org (#1055)", async ({
    page,
  }) => {
    await page.goto(`/providers/${providerId("Dr. Cora Bell (e2e)")}`);
    const affiliations = page.getByTestId("provider-affiliations");
    await expect(affiliations).toContainText("Practices at");
    await expect(
      affiliations.getByRole("link", { name: /Bell Cardiology \(e2e\)/ })
    ).toBeVisible();
  });

  test("a declined affiliation suggestion stays gone (#1055)", async ({
    page,
  }) => {
    await page.goto(`/providers/${providerId("Dr. Sam Ng (e2e)")}`);
    const suggestions = page.getByTestId("affiliation-suggestions");
    // Repeatable across --repeat-each: on the first run the co-occurrence surfaces a
    // suggestion; decline it. On a later run it is already declined (gone). Either
    // way, the end state asserted is the same: no Ng Family Practice suggestion.
    if (await suggestions.count()) {
      const decline = suggestions.getByTestId("affiliation-decline");
      if (await decline.count()) await settledClick(page, decline.first()); // first-ok: spec-owned Sam Ng fixture, sole suggestion
    }
    await expect(
      page
        .getByTestId("affiliation-suggestions")
        .getByText("Ng Family Practice (e2e)")
    ).toHaveCount(0);
  });

  test("archive → disclosure → unarchive round-trip (#1057)", async ({
    page,
  }) => {
    const id = providerId("Retired Clinic (e2e)");
    await page.goto(`/providers/${id}`);
    // Seeded archived: the badge + Unarchive control are present.
    await expect(page.getByTestId("provider-archived-badge")).toBeVisible();
    await settledClick(page, page.getByTestId("provider-archive-button"));
    await expect(page.getByTestId("provider-archived-badge")).toHaveCount(0);

    // Now it appears in the default directory (search reaches the flat list).
    await page.goto("/records#providers");
    await page.getByTestId("provider-search").fill("Retired Clinic (e2e)");
    await expect(
      page.getByTestId("provider-list").getByText("Retired Clinic (e2e)")
    ).toBeVisible();

    // Restore the seeded state: re-archive so the fixture is idempotent on retry.
    await page.goto(`/providers/${id}`);
    await settledClick(page, page.getByTestId("provider-archive-button"));
    await expect(page.getByTestId("provider-archived-badge")).toBeVisible();
  });

  test("a vision Rx can set a provider that then shows in its directory activity (#1088)", async ({
    page,
  }) => {
    await page.goto("/records#vision");
    const form = page.getByTestId("optical-prescription-form");
    await form.getByLabel("Prescriber").fill("Dr. Vision E2E");
    await settledClick(page, form.getByRole("button", { name: "Add" }));

    // The saved Rx renders the provider as a link into the registry.
    const link = page.getByRole("link", { name: /Dr\. Vision E2E/ }).first(); // first-ok: spec-owned provider just created, any matching row proves the link
    await followLink(page, link, /\/providers\/\d+$/);

    // On the provider's detail, the Rx surfaces under the Vision activity section.
    const detail = page.getByTestId("provider-detail");
    await expect(detail).toContainText("Dr. Vision E2E");
    await detail.getByTestId("activity-summary-vision").click();
    const rxEntry = detail.getByText(/Glasses|Contact lenses/).first(); // first-ok: spec-owned provider's own Rx list
    await expect(rxEntry).toBeVisible();
  });
});

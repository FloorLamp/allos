import { test, expect } from "@playwright/test";
import { followLink } from "./helpers";

// Import detail — type-appropriate presentation per record category + the
// per-document Providers listing (issue #1182). The e2e seed (e2e/seed-events.ts)
// plants document 909: one lab row (analyte — value/unit/reference band) + one
// vitals BP row (non-analyte) + one referenced provider (an organization). The
// browser must render the analyte grid for the lab tab (Panel + Reference
// columns, editable), a read-only value/date table for the vitals tab (no
// Panel/Reference columns, no edit affordance), and a real Providers listing
// whose row links to /providers/[id] — not the old count chip.
const DOC = "/import/909";

test.describe("Import detail: type-appropriate produced panels (#1182)", () => {
  test("vitals panel drops the analyte columns and the edit affordance", async ({
    page,
  }) => {
    await page.goto(`${DOC}?tab=vitals`);

    await expect(page.getByTestId("import-tab-vitals")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(page.getByRole("heading", { name: /^Vitals/ })).toBeVisible();
    // The BP reading renders in the value/date table.
    await expect(
      page.getByRole("cell", { name: /E2E Blood Pressure/ })
    ).toBeVisible();
    await expect(page.getByText("128/82")).toBeVisible();
    // No lab analyte columns for a vitals row — a BP pair has no "Panel" and no
    // reference band — and no editable "Actions" column.
    await expect(
      page.getByRole("columnheader", { name: "Reference", exact: true })
    ).toHaveCount(0);
    await expect(
      page.getByRole("columnheader", { name: "Panel", exact: true })
    ).toHaveCount(0);
    await expect(
      page.getByRole("columnheader", { name: "Actions", exact: true })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Record actions" })
    ).toHaveCount(0);
  });

  test("lab panel keeps the editable analyte grid (Panel + Reference columns)", async ({
    page,
  }) => {
    await page.goto(`${DOC}?tab=lab`);

    await expect(page.getByRole("heading", { name: /^Labs/ })).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Reference", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Panel", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: /E2E Sodium/ })).toBeVisible();
    // The analyte grid keeps its per-row editing affordance.
    await expect(
      page.getByRole("button", { name: "Record actions" }).first() // first-ok: doc 909 is this spec's own fixture (a single lab row)
    ).toBeVisible();
  });

  test("providers tab lists the referenced provider and deep-links to /providers/[id]", async ({
    page,
  }) => {
    await page.goto(`${DOC}?tab=providers`);

    const listing = page.getByTestId("produced-providers");
    await expect(
      listing.getByRole("heading", { name: /^Providers/ })
    ).toBeVisible();
    const row = listing.getByTestId("produced-provider");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("E2E Panels Lab");
    // The individual-vs-organization distinction reads at a glance.
    await expect(row).toContainText("Organization");
    const link = row.getByRole("link");
    await expect(link).toHaveAttribute("href", /^\/providers\/\d+$/);
    // Nav anchor → followLink rides out the pre-hydration swallow (#889 sweep).
    await followLink(page, link, /\/providers\/\d+$/);
    await expect(
      page.getByRole("heading", { name: /E2E Panels Lab/ })
    ).toBeVisible();
  });
});

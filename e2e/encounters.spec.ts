import { test, expect } from "@playwright/test";

// Visit detail + timeline deeplink (#178 Phase B follow-up). The seed (scripts/seed)
// plants a recent "Office Visit" encounter with a chief complaint ("Annual physical")
// and diagnoses ("Essential hypertension; Hyperlipidemia"). We assert a Timeline
// visit entry deep-links to /encounters/[id], and that the detail page renders the
// captured fields (proving the page actually mounts, not just that the route exists).
test.describe("Visit detail page", () => {
  test("a timeline visit entry deep-links to its detail page", async ({
    page,
  }) => {
    // Filter the timeline to visits so the entry is unambiguous.
    await page.goto("/timeline?category=visit");

    // The most recent visit renders as a clickable entry titled by its type, whose
    // link targets the new per-visit detail route (not the old list page).
    const visitLink = page.getByRole("link", { name: "Office Visit" }).first();
    await expect(visitLink).toBeVisible();
    expect(await visitLink.getAttribute("href")).toMatch(/^\/encounters\/\d+$/);

    await visitLink.click();
    await expect(page).toHaveURL(/\/encounters\/\d+$/);

    // The detail page renders the visit's captured detail.
    const detail = page.getByTestId("encounter-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("encounter-reason")).toHaveText(
      "Annual physical"
    );
    await expect(detail.getByTestId("encounter-diagnoses")).toContainText(
      "Essential hypertension"
    );
    // Back-link returns to the Visits list.
    await expect(
      detail.getByRole("link", { name: "Back to visits" })
    ).toBeVisible();
  });

  test("the Visits list row links to the detail page", async ({ page }) => {
    await page.goto("/encounters");
    const rowLink = page.getByRole("link", { name: "Office Visit" }).first();
    await expect(rowLink).toBeVisible();
    await rowLink.click();
    await expect(page).toHaveURL(/\/encounters\/\d+$/);
    await expect(page.getByTestId("encounter-detail")).toBeVisible();
  });
});

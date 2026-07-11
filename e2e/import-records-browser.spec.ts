import { test, expect } from "@playwright/test";

// Import detail — tabbed per-category records browser (issue #271). The e2e seed
// (e2e/seed-events.ts) plants document 908 with produced rows across several
// kinds: 2 labs + 1 prescription (medical_records), a visit, a condition, an
// immunization, and one referenced provider. The browser must expose EVERY
// produced type as a browsable tab (visits & co. used to be invisible), keep the
// counts as the tab labels, link rows category-correctly (the prescription →
// biomarker-page regression), and keep providers a non-link count chip pre-#275.
test.describe("Import detail: tabbed records browser", () => {
  test("tab strip lists every produced type with counts; default = first tab", async ({
    page,
  }) => {
    await page.goto("/import/908");

    const strip = page.getByTestId("import-tab-strip");
    await expect(strip.getByTestId("import-tab-lab")).toHaveText("Labs 2");
    await expect(strip.getByTestId("import-tab-prescription")).toHaveText(
      "Prescriptions 1"
    );
    await expect(strip.getByTestId("import-tab-visits")).toHaveText("Visits 1");
    await expect(strip.getByTestId("import-tab-conditions")).toHaveText(
      "Conditions 1"
    );
    await expect(strip.getByTestId("import-tab-immunizations")).toHaveText(
      "Immunizations 1"
    );
    // Providers are a COUNT CHIP, not a tab (no provider page to land on until
    // #275): rendered as a plain element with no link.
    const chip = page.getByTestId("import-providers-chip");
    await expect(chip).toHaveText("Providers 1");
    expect(await chip.evaluate((el) => el.tagName)).not.toBe("A");

    // Default tab (no ?tab=) is the FIRST non-empty tab — Labs — marked current,
    // and its editable table renders the lab rows.
    await expect(strip.getByTestId("import-tab-lab")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(page.getByRole("heading", { name: /^Labs/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Ferritin/ })).toBeVisible();
    // A canonicalized lab row's name still links to its biomarker series view.
    await expect(
      page.getByRole("link", { name: "Ferritin", exact: true })
    ).toHaveAttribute("href", "/biomarkers/view?name=Ferritin");
    // The lab table keeps its editing affordances inside the tab.
    await page.getByRole("button", { name: "Record actions" }).first().click();
    await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("REGRESSION: prescription rows link to /medicine, never a biomarker page", async ({
    page,
  }) => {
    await page.goto("/import/908?tab=prescription");

    await expect(page.getByTestId("import-tab-prescription")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(
      page.getByRole("heading", { name: /^Prescriptions/ })
    ).toBeVisible();
    const nameLink = page.getByRole("link", {
      name: "E2E Amoxicillin 500 mg",
    });
    await expect(nameLink).toHaveAttribute("href", "/medicine");
    // Nothing in the prescription panel may point at a biomarker series page.
    const biomarkerLinks = page.locator('table a[href^="/biomarkers/view"]');
    await expect(biomarkerLinks).toHaveCount(0);
  });

  test("visits tab lists the visit and deep-links to its detail page", async ({
    page,
  }) => {
    await page.goto("/import/908?tab=visits");

    const listing = page.getByTestId("produced-listing");
    await expect(
      listing.getByRole("heading", { name: /^Visits/ })
    ).toBeVisible();
    const item = listing.getByTestId("produced-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("E2E Browser Visit");
    await expect(item).toContainText("E2E annual physical");
    const link = item.getByRole("link");
    await expect(link).toHaveAttribute("href", /^\/encounters\/\d+$/);
    await link.click();
    await expect(page).toHaveURL(/\/encounters\/\d+$/);
    await expect(page.getByText("E2E annual physical")).toBeVisible();
  });

  test("other produced kinds are browsable too (conditions, immunizations)", async ({
    page,
  }) => {
    await page.goto("/import/908?tab=conditions");
    const conditions = page.getByTestId("produced-listing");
    await expect(conditions.getByTestId("produced-item")).toContainText(
      "E2E Hay fever"
    );
    await expect(
      conditions.getByTestId("produced-item").getByRole("link")
    ).toHaveAttribute("href", "/conditions");

    await page.goto("/import/908?tab=immunizations");
    const imms = page.getByTestId("produced-listing");
    await expect(imms.getByTestId("produced-item")).toContainText("E2E Tdap");
    await expect(
      imms.getByTestId("produced-item").getByRole("link")
    ).toHaveAttribute("href", "/immunizations");

    // An unknown ?tab= falls back to the default (first) tab instead of a
    // broken panel.
    await page.goto("/import/908?tab=bogus");
    await expect(page.getByTestId("import-tab-lab")).toHaveAttribute(
      "aria-current",
      "page"
    );
  });
});

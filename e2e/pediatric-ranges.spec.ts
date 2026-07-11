import { test, expect, type Page } from "@playwright/test";

// Pediatric reference ranges + pediatric BP percentiles (issue #150). For a CHILD
// profile the biomarker detail page interprets labs and vitals by AGE, not the
// adult thresholds:
//   • Alkaline phosphatase 300 U/L reads "Above range" for an adult (ref 40–129)
//     but is NORMAL for a 1-year-old (age-band 140–420) — the canonical false-high.
//   • Blood pressure is judged by the AAP 2017 age/sex/height percentile (Elevated
//     for age) instead of the adult cutoffs, which call the same reading fine.
// The seeded family includes an ~18-month-old child ("Riley (child)") carrying
// both readings. These share ONE authenticated session (active profile is
// server-side state), so they run serially and restore the "admin" profile after.

async function switchProfile(page: Page, name: string) {
  await page.goto("/");
  await page.getByTestId("user-menu-trigger").click();
  await page
    .getByTestId("user-menu-popover")
    .locator("form")
    .filter({ hasText: name })
    .getByRole("button")
    .click();
  await expect(page.getByTestId("user-menu-trigger")).toContainText(name);
}

test.describe.serial("pediatric reference ranges", () => {
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await switchProfile(page, "admin");
    } finally {
      await page.close();
    }
  });

  test("child ALP is judged against the age band, not the adult range", async ({
    page,
  }) => {
    await switchProfile(page, "Riley (child)");
    await page.goto("/biomarkers/view?name=Alkaline%20Phosphatase");

    // The reference range shown is the pediatric age band, labeled by age.
    await expect(page.getByText("age 1–10")).toBeVisible();
    await expect(page.getByText("140–420 U/L")).toBeVisible();

    // 300 U/L is IN the pediatric band, so it is NOT flagged "Above range" — the
    // adult range (40–129) would have.
    await expect(page.getByText("Above range")).toHaveCount(0);
  });

  test("child blood pressure shows an AAP percentile + category", async ({
    page,
  }) => {
    await switchProfile(page, "Riley (child)");
    await page.goto("/biomarkers/view?name=Blood%20Pressure%20Systolic");

    const bp = page.getByTestId("pediatric-bp-context");
    await expect(bp).toBeVisible();
    await expect(bp).toContainText("percentile");
    // Systolic 101 for a 1-year-old is Elevated for age (adult ref 90–120 = fine).
    await expect(page.getByTestId("pediatric-bp-category")).toContainText(
      "Elevated"
    );
  });

  test("adult profile keeps the adult thresholds (no pediatric BP card)", async ({
    page,
  }) => {
    await switchProfile(page, "admin");
    await page.goto("/biomarkers/view?name=Blood%20Pressure%20Systolic");
    // No pediatric BP interpretation for an adult, whatever readings exist.
    await expect(page.getByTestId("pediatric-bp-context")).toHaveCount(0);
  });
});

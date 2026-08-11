import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
// Pediatric reference ranges + pediatric BP percentiles (issue #150). For a CHILD
// profile a reading is interpreted by AGE, not by the adult thresholds:
//   • Alkaline phosphatase 300 U/L reads "Above range" for an adult (ref 40–129)
//     but is NORMAL for a 1-year-old (age-band 140–420) — the canonical false-high.
//   • Blood pressure is judged by the AAP 2017 age/sex/height percentile (Elevated
//     for age) instead of the adult cutoffs, which call the same reading fine.
// Since #1932 the two live on different surfaces — a lab is episodic and stays on
// /results/readings/view; blood pressure is a CONTINUOUS vital and renders on its metric
// detail page, which its pediatric card travelled to. The BP tests below still open
// the old URL on purpose: it proves the stale-bookmark redirect AND the card in one
// navigation.
// The seeded family includes an ~18-month-old child ("Riley (child)") carrying
// both readings. These share ONE authenticated session (active profile is
// server-side state), so they run serially and restore the "admin" profile after.

async function switchProfile(page: Page, name: string) {
  await page.goto("/");
  await page.getByTestId("profile-identity-bar").click();
  await page
    .getByTestId("profile-switcher-panel")
    .locator("form")
    .filter({ hasText: name })
    .getByRole("button")
    .click();
  // Server-truth budget (#1556): the trigger names the new profile only after
  // setActiveProfile's Server Action + refresh round-trip; observed losing the 5s
  // default under CI shard load at retries=0 (2026-07-31, run 30664837925).
  await expect(page.getByTestId("profile-identity-bar")).toContainText(name, {
    timeout: 30_000,
  });
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
    await page.goto("/results/readings/view?name=Alkaline%20Phosphatase");

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
    await page.goto("/results/readings/view?name=Blood%20Pressure%20Systolic");
    await page.waitForURL(/\/trends\/metric\/systolic/);

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
    await page.goto("/results/readings/view?name=Blood%20Pressure%20Systolic");
    await page.waitForURL(/\/trends\/metric\/systolic/);
    // No pediatric BP interpretation for an adult, whatever readings exist.
    await expect(page.getByTestId("pediatric-bp-context")).toHaveCount(0);
  });
});

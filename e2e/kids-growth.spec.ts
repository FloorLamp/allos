import { test, expect, type Page } from "@playwright/test";

// Kids growth trends. For a CHILD profile the Trends → Body tab prioritizes
// height (WHO/CDC growth percentiles + a height/head-circ chart), offers a manual
// height + head-circumference quick-add, and hides body fat %. An ADULT profile is
// unchanged: no growth quick-add, no head-circ affordance, body fat still charted.
// The seeded family includes an ~18-month-old child ("Riley (child)").
//
// These share ONE authenticated session (storageState), so the active profile is
// server-side state; the tests run serially and always restore the "admin" profile
// so no other spec inherits the switch.

async function switchProfile(page: Page, name: string) {
  await page.goto("/");
  await page.getByTestId("user-menu-trigger").click();
  await page
    .locator("form")
    .filter({ hasText: name })
    .getByRole("button")
    .click();
  await expect(page.getByTestId("user-menu-trigger")).toContainText(name);
}

test.describe.serial("kids growth trends", () => {
  test.afterAll(async ({ browser }) => {
    // Restore the default profile for any following spec, even if a test above
    // failed mid-switch.
    const page = await browser.newPage();
    try {
      await switchProfile(page, "admin");
    } finally {
      await page.close();
    }
  });

  test("child profile: growth entry, height prioritized, body fat hidden", async ({
    page,
  }) => {
    await switchProfile(page, "Riley (child)");
    await page.goto("/trends?tab=body");

    // The child-only growth quick-add, with height + head-circumference fields.
    const form = page.getByTestId("growth-quick-add");
    await expect(form).toBeVisible();
    const heightInput = form.getByLabel("Height", { exact: true });
    await expect(heightInput).toBeVisible();
    await expect(
      form.getByLabel("Head circumference", { exact: true })
    ).toBeVisible();

    // Height is charted and the WHO/CDC growth-percentile card renders.
    await expect(
      page.getByRole("heading", { name: "Growth percentiles" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Height", exact: true })
    ).toBeVisible();

    // Body fat % is de-prioritized out of a child's Body tab entirely.
    await expect(page.getByRole("heading", { name: "Body fat" })).toHaveCount(
      0
    );

    // Adding a height persists without error and the form clears.
    await heightInput.fill("82.5");
    await form.getByRole("button", { name: "Save growth" }).click();
    await expect(page.getByText("Growth measurement saved")).toBeVisible();
    await expect(heightInput).toHaveValue("");

    // The height still charts after the write (growth card remains populated).
    await expect(
      page.getByRole("heading", { name: "Growth percentiles" })
    ).toBeVisible();
  });

  test("adult profile: unchanged layout, no growth affordance", async ({
    page,
  }) => {
    await switchProfile(page, "admin");
    await page.goto("/trends?tab=body");

    // No child growth quick-add for an adult.
    await expect(page.getByTestId("growth-quick-add")).toHaveCount(0);

    // Body fat % is still charted; height/head-circ are not surfaced as tiles.
    await expect(page.getByRole("heading", { name: "Body fat" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Head circumference" })
    ).toHaveCount(0);
  });
});

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

// The weight unit is a LOGIN-scoped preference (shared across profiles/specs),
// so a test that flips it MUST restore "kg" so no sibling spec inherits the
// switch. Auto-saves on change (SaveStatus check).
async function setWeightUnit(page: Page, value: "kg" | "lb") {
  await page.goto("/settings");
  const select = page
    .getByRole("main")
    .locator("select")
    .filter({ has: page.locator('option[value="lb"]') })
    .first();
  await select.selectOption(value);
  await expect(page.getByLabel("Saved")).toBeVisible();
}

test.describe.serial("kids growth trends", () => {
  test.afterAll(async ({ browser }) => {
    // Restore the default profile AND weight unit for any following spec, even
    // if a test above failed mid-switch.
    const page = await browser.newPage();
    try {
      await setWeightUnit(page, "kg");
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

  // Issue #194: the growth-percentile card's WEIGHT plot + label must follow the
  // login's weight preference (it used to hardcode kg). For an lb-preference
  // user the weight chart's tooltip reads in lb — proving the bands + points +
  // axis were all converted together at the display boundary (percentiles stay
  // kg-computed upstream). Restores kg at the end so no sibling spec inherits lb.
  test("child profile: growth card weight follows lb preference", async ({
    page,
  }) => {
    await switchProfile(page, "Riley (child)");
    await setWeightUnit(page, "lb");
    try {
      await page.goto("/trends?tab=body");

      // Filter by the card's own <h2> — a bare hasText substring also matches
      // the growth-quick-add form card above it (strict-mode double-match).
      const card = page
        .getByRole("main")
        .locator(".card")
        .filter({
          has: page.getByRole("heading", { name: "Growth percentiles" }),
        });
      await expect(card).toBeVisible();

      // Default metric is Height (unit cm regardless) — switch to Weight, whose
      // unit is the one that must reflect the lb preference.
      await card.getByRole("button", { name: "Weight", exact: true }).click();

      // Hover the weight chart: the recharts tooltip renders values with the
      // display unit suffix. Re-hover on each retry (recharts needs a mousemove).
      const surface = card.locator(".recharts-surface").first();
      const tooltip = card.locator(".recharts-tooltip-wrapper");
      await expect(async () => {
        const box = await surface.boundingBox();
        if (!box) throw new Error("no growth chart surface");
        await page.mouse.move(
          box.x + box.width * 0.5,
          box.y + box.height * 0.5
        );
        await page.mouse.move(
          box.x + box.width * 0.55,
          box.y + box.height * 0.5
        );
        await expect(tooltip).toContainText("lb");
      }).toPass({ timeout: 10_000 });

      // And never kg while lb is the preference.
      await expect(tooltip).not.toContainText("kg");
    } finally {
      await setWeightUnit(page, "kg");
    }
  });
});

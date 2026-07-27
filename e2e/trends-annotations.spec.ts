import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";

test.describe("desktop Trends annotations", () => {
  test("protocol controls filter the full Body charts", async ({ page }) => {
    await page.goto("/trends?tab=body&view=all&range=all");

    const controls = page.getByTestId("trend-annotation-controls");
    await expect(controls).toBeVisible();
    await expect(
      page
        .getByTestId("trends-context-controls")
        .getByTestId("trend-annotation-controls")
    ).toBeVisible();

    const protocols = page.getByRole("button", { name: "Protocols" });
    await expect(protocols).toHaveAttribute("aria-pressed", "true");
    const shaded = page.locator(".recharts-reference-area");
    await expect
      .poll(async () => await shaded.count(), {
        message: "the seeded protocol windows should be shaded to begin with",
      })
      .toBeGreaterThan(0);

    await hydratedClick(page, protocols);
    await expect(protocols).toHaveAttribute("aria-pressed", "false");
    await expect(shaded).toHaveCount(0);

    await hydratedClick(page, protocols);
    await expect(protocols).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => await shaded.count()).toBeGreaterThan(0);
  });

  test("chart annotation labels respect the legibility floor", async ({
    page,
  }) => {
    await page.goto("/trends?tab=body&view=all&range=all");
    await expect
      .poll(async () => await page.locator(".recharts-reference-area").count())
      .toBeGreaterThan(0);

    const sizes = await page
      .locator(".recharts-wrapper svg text")
      .evaluateAll((elements) =>
        elements.map((element) =>
          parseFloat(getComputedStyle(element).fontSize)
        )
      );
    expect(sizes.length, "the charts should be drawing text").toBeGreaterThan(
      0
    );
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10);
  });
});

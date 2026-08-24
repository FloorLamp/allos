import { expect, test } from "./fixtures";

const BOUNDARY_WIDTHS = [1919, 1920, 1921] as const;

test("the live app shell keeps the 1920px boundary at the browser-default 16px initial font size (#3477)", async ({
  page,
}) => {
  await page.goto("/");
  const container = page.getByTestId("app-content-container");
  await expect(container).toBeVisible();

  for (const width of BOUNDARY_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const reading = await container.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        legacyPxMatches: matchMedia("(width >= 1920px)").matches,
        namedRemMatches: matchMedia("(width >= 120rem)").matches,
        maxWidth: getComputedStyle(element).maxWidth,
        rect: { left: rect.left, right: rect.right, width: rect.width },
        viewportWidth: document.documentElement.clientWidth,
      };
    });

    expect(reading.viewportWidth).toBe(width);
    expect(reading.legacyPxMatches).toBe(width >= 1920);
    expect(reading.namedRemMatches).toBe(width >= 1920);
    expect(reading.maxWidth).toBe(width >= 1920 ? "1760px" : "none");
    expect(reading.rect.left).toBeGreaterThanOrEqual(0);
    expect(reading.rect.right).toBeLessThanOrEqual(width);
    expect(reading.rect.width).toBeGreaterThan(0);
  }
});

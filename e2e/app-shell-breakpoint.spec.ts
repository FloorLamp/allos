import { expect, test } from "./fixtures";

const BOUNDARY_WIDTHS = [1919, 1920, 1921] as const;

test("the live app shell keeps the exact legacy 1920px boundary (#3477)", async ({
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
        rootFontSize: getComputedStyle(document.documentElement).fontSize,
        viewportWidth: document.documentElement.clientWidth,
      };
    });

    expect(reading.rootFontSize).toBe("16px");
    expect(reading.viewportWidth).toBe(width);
    expect(reading.namedRemMatches).toBe(reading.legacyPxMatches);
    expect(reading.maxWidth).toBe(reading.legacyPxMatches ? "1760px" : "none");
    expect(reading.rect.left).toBeGreaterThanOrEqual(0);
    expect(reading.rect.right).toBeLessThanOrEqual(width);
    expect(reading.rect.width).toBeGreaterThan(0);
  }
});

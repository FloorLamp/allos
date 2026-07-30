import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";
import { TREND_ANNOTATION_VISIBILITY_KEY } from "../lib/trend-annotation-visibility";

test.describe("desktop Trends annotations", () => {
  test("protocol controls persist across reloads and detail navigation", async ({
    page,
  }) => {
    await page.goto("/trends?view=all&range=all");

    const controls = page.getByTestId("trend-annotation-controls");
    await expect(controls).toBeVisible();
    await expect(
      page
        .getByTestId("trends-context-controls")
        .getByTestId("trend-annotation-controls")
    ).toBeVisible();

    const rangeRow = page.getByTestId("trends-chip-row");
    const [rangeBox, eventBox] = await Promise.all([
      rangeRow.boundingBox(),
      controls.boundingBox(),
    ]);
    expect(rangeBox).not.toBeNull();
    expect(eventBox).not.toBeNull();
    const rangeCenter = rangeBox!.y + rangeBox!.height / 2;
    const eventCenter = eventBox!.y + eventBox!.height / 2;
    expect(
      Math.abs(rangeCenter - eventCenter),
      "Events should share the desktop row with the range controls"
    ).toBeLessThanOrEqual(2);

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
    await expect
      .poll(() =>
        page.evaluate(
          (key) => window.localStorage.getItem(key),
          TREND_ANNOTATION_VISIBILITY_KEY
        )
      )
      .toContain('"protocol"');

    await page.reload();
    const reloadedProtocols = page.getByRole("button", { name: "Protocols" });
    await expect(reloadedProtocols).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".recharts-reference-area")).toHaveCount(0);

    // The metric detail page mounts a fresh provider but reads the same durable
    // per-browser preference.
    await page.goto("/trends/metric/weight?range=all");
    const detailProtocols = page.getByRole("button", { name: "Protocols" });
    await expect(detailProtocols).toHaveAttribute("aria-pressed", "false");

    // Restore the default so this persistent-state test remains repeat-safe.
    await hydratedClick(page, detailProtocols);
    await expect(detailProtocols).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() =>
        page.evaluate(
          (key) => window.localStorage.getItem(key),
          TREND_ANNOTATION_VISIBILITY_KEY
        )
      )
      .toBe('{"disabled":[]}');
  });

  test("metric detail shares the range row with its event controls", async ({
    page,
  }) => {
    await page.goto("/trends/metric/weight?range=all");

    const controls = page.getByTestId("trend-annotation-controls");
    const rangeRow = page.getByTestId("metric-chip-row");
    await expect(controls).toBeVisible();
    await expect(page.getByRole("button", { name: "Protocols" })).toHaveCount(
      1
    );

    const [rangeBox, eventBox] = await Promise.all([
      rangeRow.boundingBox(),
      controls.boundingBox(),
    ]);
    expect(rangeBox).not.toBeNull();
    expect(eventBox).not.toBeNull();
    expect(
      Math.abs(
        rangeBox!.y +
          rangeBox!.height / 2 -
          (eventBox!.y + eventBox!.height / 2)
      ),
      "Metric-detail Events should share the desktop range row"
    ).toBeLessThanOrEqual(2);
  });

  test("chart annotation labels respect the legibility floor", async ({
    page,
  }) => {
    await page.goto("/trends?view=all&range=all");
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

    // Point-event names live in the hover tooltip, not permanently across the
    // top of every plot where several labels form an unreadable text band.
    await expect(
      page
        .locator(".recharts-wrapper svg text")
        .filter({ hasText: "Sertraline" })
    ).toHaveCount(0);
    await expect(
      page.locator(".recharts-wrapper svg text").filter({ hasText: "Creatine" })
    ).toHaveCount(0);
    await expect(
      page
        .locator(".recharts-wrapper svg text")
        .filter({ hasText: "Red light" })
    ).toHaveCount(0);
  });
});

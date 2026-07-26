import { test, expect, type Page } from "@playwright/test";

// TEMPORARY measurement harness (#1485 F acceptance). Deleted before commit.

async function measure(page: Page, url: string, label: string) {
  await page.goto(url);
  const panel = page.locator("[role='tabpanel']");
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  const chart = page.locator(".recharts-surface").first(); // first-ok: measurement harness
  let chartTop: number | null = null;
  if ((await chart.count()) > 0) {
    await expect(chart).toBeVisible();
    chartTop = (await chart.boundingBox())?.y ?? null;
  }
  const pageH = await page.evaluate(() => document.body.scrollHeight);
  console.log(
    `MEASURE ${label}: panelTop=${panelBox?.y} firstChartTop=${chartTop} pageHeight=${pageH}`
  );
}

test("measure overview", async ({ page }) => {
  test.slow();
  await measure(page, "/trends", "overview");
});

test("measure body", async ({ page }) => {
  test.slow();
  await measure(page, "/trends?tab=body", "body");
});

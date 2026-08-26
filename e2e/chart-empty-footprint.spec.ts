import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PHONE = { width: 390, height: 844 };

function plot(card: Locator): Locator {
  return card.getByTestId("chart-card-plot");
}

async function expectSquareFootprint(card: Locator) {
  const box = await plot(card).boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(1);
  return box!;
}

test("chart absences release the 390px plot footprint while chart states retain it", async ({
  page,
}: {
  page: Page;
}) => {
  await page.setViewportSize(PHONE);
  await page.goto("/e2e-fixtures/chart-empty");

  const emptyCards = [
    ["ordinary-empty-card", "No data yet"],
    ["no-overlap-empty-card", "No overlapping data in this range"],
    ["no-paired-empty-card", "No paired data yet"],
  ] as const;

  for (const [testid, message] of emptyCards) {
    const card = page.getByTestId(testid);
    const empty = plot(card).locator(":scope > [data-empty-state]");
    await expect(empty).toHaveText(message);
    const box = await plot(card).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(box!.width / 2);
  }

  const populated = page.getByTestId("populated-card");
  await expect(plot(populated).getByRole("application")).toBeVisible();
  await expectSquareFootprint(populated);

  const loading = page.getByTestId("loading-card");
  await expect(loading.getByText("Loading chart…")).toBeAttached();
  await expectSquareFootprint(loading);

  const error = page.getByTestId("error-card");
  await expect(error.getByText(/Chart unavailable/)).toBeVisible();
  await expectSquareFootprint(error);
});

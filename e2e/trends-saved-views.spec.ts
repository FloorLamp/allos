import { test, expect } from "./fixtures";
import { hydratedClick, settledClick, settledFill } from "./helpers";

const VIEW_NAME = "saved view roundtrip";
const LEGACY_VIEW_NAME = "saved view legacy vocab";

function applyButton(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

async function saveCurrentView(
  page: import("@playwright/test").Page,
  name: string
) {
  await hydratedClick(page, page.getByRole("button", { name: "Save current" }));
  await settledFill(page, page.getByPlaceholder("View name…"), name);
  await settledClick(
    page,
    page.getByRole("button", { name: "Save", exact: true })
  );
  await expect(applyButton(page, name)).toBeVisible();
}

async function deleteView(page: import("@playwright/test").Page, name: string) {
  await page.goto("/trends");
  const del = page.getByRole("button", { name: `Delete view ${name}` });
  if (await del.isVisible().catch(() => false)) {
    await settledClick(page, del);
    await expect(del).toHaveCount(0);
  }
}

test.describe("desktop saved views capture the whole Trends state", () => {
  test.afterEach(async ({ page }) => {
    await deleteView(page, VIEW_NAME);
    await deleteView(page, LEGACY_VIEW_NAME);
  });

  test("save on Body / tiles / a one-day window, reopen, identical state", async ({
    page,
  }) => {
    const day = "2026-01-15";
    await page.goto(`/trends?tab=body&view=tiles&from=${day}&to=${day}`);
    await expect(page.getByTestId("body-tiles-view")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save current" })
    ).toBeVisible();
    await saveCurrentView(page, VIEW_NAME);

    await page.goto("/trends?range=all");
    await settledClick(page, applyButton(page, VIEW_NAME));

    await expect(page).toHaveURL(
      new RegExp(`tab=body.*from=${day}.*to=${day}.*view=tiles`)
    );
    await expect(page.getByTestId("body-tiles-view")).toBeVisible();
    await expect(page.getByTestId("body-charts-all")).toBeHidden();
  });

  test("a view saved under the retired Vitals vocabulary still resolves", async ({
    page,
  }) => {
    await page.goto("/trends?tab=vitals&range=all");
    await expect(page.getByTestId("trends-body")).toBeVisible();
    await saveCurrentView(page, LEGACY_VIEW_NAME);

    await page.goto("/trends");
    await settledClick(page, applyButton(page, LEGACY_VIEW_NAME));

    await expect(page).toHaveURL(/tab=vitals/);
    await expect(page.getByTestId("trends-body")).toBeVisible();
  });
});

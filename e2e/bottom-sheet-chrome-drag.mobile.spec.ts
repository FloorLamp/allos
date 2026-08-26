import { expect, test } from "./fixtures";
import { awaitHydrated, hydratedClick, touchSwipeFrom } from "./helpers";
import type { Page } from "@playwright/test";

// BottomSheet's handle is the visible affordance for one sheet-wide gesture,
// not the only draggable pixels (#3721). The fixture is necessary because the
// primitive's `description` prop has no product caller; it runs through the real
// authenticated app shell and the same production build as every other spec.

async function openHarness(page: Page, guarded = false) {
  await page.goto(`/e2e-fixtures/bottom-sheet?guarded=${guarded ? "1" : "0"}`);
  const sheet = page.getByTestId("gesture-contract-sheet");
  await awaitHydrated(sheet);
  return sheet;
}

test("title and description chrome each dismiss with a real touch drag", async ({
  page,
}) => {
  let sheet = await openHarness(page);
  await touchSwipeFrom(
    page,
    sheet.getByRole("heading", { name: "Gesture contract" }),
    { dy: 260 }
  );
  await expect(sheet).toHaveCount(0);
  await expect(
    page.getByTestId("bottom-sheet-gesture-harness")
  ).toHaveAttribute("data-outcome", "gesture");

  sheet = await openHarness(page);
  await touchSwipeFrom(
    page,
    sheet.getByText(
      "The visible handle enables drag dismissal across this sheet chrome."
    ),
    { dy: 260 }
  );
  await expect(sheet).toHaveCount(0);
  await expect(
    page.getByTestId("bottom-sheet-gesture-harness")
  ).toHaveAttribute("data-outcome", "gesture");
});

test("a dirty Close tap stays targeted while a Close drag asks before discard", async ({
  page,
}) => {
  let sheet = await openHarness(page, true);
  await sheet.getByLabel("Draft value").fill("unsaved");
  await hydratedClick(page, sheet.getByRole("button", { name: "Close" }));
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(
    page.getByTestId("bottom-sheet-gesture-harness")
  ).toHaveAttribute("data-outcome", "close");

  sheet = await openHarness(page, true);
  await sheet.getByLabel("Draft value").fill("unsaved");
  await touchSwipeFrom(page, sheet.getByRole("button", { name: "Close" }), {
    dy: 260,
  });

  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(sheet).toBeVisible();
  await expect(
    page.getByTestId("bottom-sheet-gesture-harness")
  ).toHaveAttribute("data-outcome", "gesture");
});

test("a body drag starting below scroll top remains native scrolling", async ({
  page,
}) => {
  const sheet = await openHarness(page);
  const content = sheet.locator("[data-sheet-content]");
  const starting = await content.evaluate((node) => {
    const available = node.scrollHeight - node.clientHeight;
    node.scrollTop = Math.min(160, available);
    return { available, scrollTop: node.scrollTop };
  });
  expect(starting.available).toBeGreaterThanOrEqual(80);
  expect(starting.scrollTop).toBeGreaterThan(0);

  await touchSwipeFrom(page, content, { dy: 260 }, { stepDelayMs: 20 });

  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(
    page.getByTestId("bottom-sheet-gesture-harness")
  ).toHaveAttribute("data-outcome", "");
  await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
});

test("md-and-up chrome cannot arm while the responsive handle has no box", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  const sheet = await openHarness(page);
  await expect(sheet.getByTestId("sheet-drag-handle")).toBeHidden();
  const panel = sheet.locator("[data-sheet-panel]");

  await touchSwipeFrom(
    page,
    sheet.getByRole("heading", { name: "Gesture contract" }),
    { dy: 260 }
  );

  await expect(sheet).toBeVisible();
  await expect(
    page.getByTestId("bottom-sheet-gesture-harness")
  ).toHaveAttribute("data-outcome", "");
  await expect(panel).not.toHaveClass(/overlay-settle/);
  await expect(panel).toHaveCSS("transform", "none");
});

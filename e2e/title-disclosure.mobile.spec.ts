import { expect, test } from "./fixtures";
import { hydratedClick, settledBoxes, settledFill } from "./helpers";
import { apiTokenScopeSummary } from "../lib/api-token-format";

const SCOPE_DETAIL = apiTokenScopeSummary("upload:documents");

test("a registered detail works by touch and keyboard without covering its trigger", async ({
  page,
}) => {
  test.slow();
  const name = `title disclosure ${Date.now()}`; // eslint-disable-line no-restricted-properties -- clock-ok: uniqueness for this spec-owned token only
  await page.goto("/settings/tokens");
  await settledFill(page, page.getByTestId("api-token-name"), name);
  await hydratedClick(page, page.getByTestId("api-token-create"));

  // eslint-disable-next-line no-restricted-properties -- first-ok: this spec's name is unique
  const row = page
    .getByTestId("api-token-row")
    .filter({ hasText: name })
    .first();
  await expect(row).toBeVisible();
  await hydratedClick(page, page.getByTestId("api-token-secret-dismiss"));

  const trigger = row.getByTestId("api-token-scope-detail");
  const [triggerBox] = await settledBoxes([trigger]);
  await page.touchscreen.tap(
    triggerBox.x + triggerBox.width / 2,
    triggerBox.y + triggerBox.height / 2
  );

  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText(SCOPE_DETAIL);
  const [tooltipBox] = await settledBoxes([tooltip]);
  expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(390);
  const overlaps = !(
    tooltipBox.x + tooltipBox.width <= triggerBox.x ||
    tooltipBox.x >= triggerBox.x + triggerBox.width ||
    tooltipBox.y + tooltipBox.height <= triggerBox.y ||
    tooltipBox.y >= triggerBox.y + triggerBox.height
  );
  expect(overlaps).toBe(false);

  const [headingBox] = await settledBoxes([
    page.getByRole("heading", { name: /API tokens$/ }),
  ]);
  await page.touchscreen.tap(
    headingBox.x + headingBox.width / 2,
    headingBox.y + headingBox.height / 2
  );
  await expect(tooltip).toHaveCount(0);

  await trigger.focus();
  await expect(trigger).toBeFocused();
  await expect(tooltip).toHaveText(SCOPE_DETAIL);
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(trigger).not.toBeFocused();

  await hydratedClick(page, row.getByTestId("api-token-revoke"));
  await expect(row).toHaveCount(0);
});

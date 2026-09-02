import { expect, test } from "./fixtures";
import { hydratedClick, settledBoxes, settledFill } from "./helpers";

const SCOPE_DETAIL =
  "Add medical documents to the profiles this login can write to. It cannot read anything back.";

test("a registered detail works by touch and keyboard without covering its trigger", async ({
  page,
}) => {
  test.slow();
  const name = `title disclosure ${Date.now()}`; // clock-ok: uniqueness for this spec-owned token only
  await page.goto("/settings/tokens");
  await settledFill(page, page.getByTestId("api-token-name"), name);
  await hydratedClick(page, page.getByTestId("api-token-create"));

  const row = page
    .getByTestId("api-token-row")
    .filter({ hasText: name })
    .first(); // first-ok: this spec's name is unique
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

// GONE WITH ITS SUBJECT (#4419 rule 1): "a sync timestamp discloses beside its
// whole-card destination" drove the info button inside the Data › Import connected
// card. That button was the last production instance of a disclosure nested in an
// OverlayDestination — every one of them came from `SyncTimestamp relativeOnly`, and
// the absolute stamp now lives on the surface each card links to.
//
// SO THERE IS NO REAL PAGE LEFT TO DRIVE, and that — not a coverage trade — is why
// this test went and did not come back somewhere else. The COMPOSITION it guarded (a
// detail control that is a SIBLING of the whole-surface link, tappable without
// navigating) is still asserted, on a synthetic fixture that needs no production
// instance, in components/__tests__/overlay-destination.test.tsx. Do not read the
// synthetic-only guarantee as a gap and restore an e2e for it: an e2e would first
// have to invent the very composition the placement rule removed. If a real instance
// ever comes back, THAT is when a page-level test is worth writing again.

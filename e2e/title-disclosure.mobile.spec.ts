import { expect, test } from "./fixtures";
import {
  expectControlBoxHeight,
  expectNoClippedContent,
  expectPhoneTapTargets,
  hydratedClick,
  settledBoxes,
  settledFill,
} from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

const SCOPE_DETAIL =
  "Add medical documents to the profiles this login can write to. It cannot read anything back.";

test("visualization details expand in flow by touch and keyboard", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");
  const card = page.getByTestId("training-week");
  const details = card.getByTestId("week-spine-details");
  const summary = details.locator("summary");
  await summary.scrollIntoViewIfNeeded();

  const [summaryBox] = await settledBoxes([summary]);
  // The control box, with the 44 supplied as reach around it (#3938).
  await expectPhoneTapTargets(page, "week spine disclosure", [summary]);
  await page.touchscreen.tap(
    summaryBox.x + summaryBox.width / 2,
    summaryBox.y + summaryBox.height / 2
  );
  await expect(details).toHaveAttribute("open", "");
  await expect(details.locator("li")).toHaveCount(7);

  const [cardBox, detailsBox, targetsBox] = await settledBoxes([
    card,
    details,
    card.getByText("Weekly targets", { exact: true }),
  ]);
  expect(detailsBox.x).toBeGreaterThanOrEqual(cardBox.x);
  expect(detailsBox.x).toBeGreaterThanOrEqual(0);
  expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(
    cardBox.x + cardBox.width + 1
  );
  expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(390);
  expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(
    targetsBox.y + 1
  );
  expect(
    await details.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true);
  await expectNoClippedContent(page);

  await page.touchscreen.tap(
    summaryBox.x + summaryBox.width / 2,
    summaryBox.y + summaryBox.height / 2
  );
  await expect(details).not.toHaveAttribute("open", "");
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
});

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

test("a sync timestamp discloses beside its whole-card destination", async ({
  page,
}) => {
  await page.goto("/data?section=import");
  const connected = page.getByTestId("grid-connected");
  const timestamp = connected.getByTestId("sync-timestamp-compact").first(); // first-ok: every connected timestamp uses the same registered composition
  const trigger = timestamp.getByRole("button");
  await expect(trigger).toBeVisible();
  const content = trigger.locator(
    "xpath=ancestor::*[@data-overlay-destination-content]"
  );
  const destination = content.locator("..").getByRole("link");
  await expect(destination.getByRole("button")).toHaveCount(0);

  const initialUrl = page.url();
  await trigger.scrollIntoViewIfNeeded();
  const [triggerBox] = await settledBoxes([trigger]);
  await page.touchscreen.tap(
    triggerBox.x + triggerBox.width / 2,
    triggerBox.y + triggerBox.height / 2
  );
  await expect(page.getByRole("tooltip")).toBeVisible();
  expect(page.url()).toBe(initialUrl);

  await page.keyboard.press("Escape");
  await destination.focus();
  await expect(destination).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).not.toHaveURL(initialUrl);
});

test("standing history fits a touch tablet and discloses by touch and keyboard", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_DAILY, password: E2E_MEMBER_PASSWORD },
    { viewport: { width: 768, height: 900 }, hasTouch: true }
  );
  try {
    await page.goto("/");
    const details = page.getByTestId("standing-sparkline-details").first(); // first-ok: any seeded standing series proves the shared composition
    const summary = details.locator("summary");
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAccessibleName(/.+ history details$/);

    const [summaryBox, detailsBox] = await settledBoxes([summary, details]);
    // 768px is above `sm`, and #3938 retired the step: `button-control` is the
    // same control box here as at 390. `< 44` would pass on 34, on 26 and on 12,
    // so it is not that — but this summary is `whitespace-normal` and WRAPS at
    // this width, so it is not a flat equality either: it is the box plus whole
    // line boxes. (Measured: 54 here, which is 34 + one 20px line.)
    await expectControlBoxHeight(summary, "standing history summary at 768");
    expect(detailsBox.x).toBeGreaterThanOrEqual(0);
    expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(768);
    await page.touchscreen.tap(
      summaryBox.x + summaryBox.width / 2,
      summaryBox.y + summaryBox.height / 2
    );
    await expect(details).toHaveAttribute("open", "");
    await expect(details.locator("li")).not.toHaveCount(0);
    const [openDetailsBox] = await settledBoxes([details]);
    expect(openDetailsBox.x).toBeGreaterThanOrEqual(0);
    expect(openDetailsBox.x + openDetailsBox.width).toBeLessThanOrEqual(768);
    // WHAT FITS IS THE CONTENT, MEASURED AS ELEMENT RECTANGLES. `scrollWidth` also
    // counts the coarse-pointer HIT REGION the summary now carries (#3938) — an
    // invisible `::after` reaching 6px past its edges — so a 2px "overflow" here
    // was a phantom that no reader could see and no scrollbar could reach. Element
    // rectangles exclude pseudo-elements, so this asks the question the test
    // means: does anything DRAWN inside spill past the box.
    expect(
      await details.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll("*")).filter((child) => {
          const rect = child.getBoundingClientRect();
          return (
            rect.right > bounds.right + 0.5 || rect.left < bounds.left - 0.5
          );
        }).length;
      })
    ).toBe(0);
    await expectNoClippedContent(page);

    await page.touchscreen.tap(
      summaryBox.x + summaryBox.width / 2,
      summaryBox.y + summaryBox.height / 2
    );
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
  } finally {
    await page.context().close();
  }
});

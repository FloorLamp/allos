import { test, expect } from "./fixtures";
import { type Browser, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { expandUpcomingAggregates } from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_UPCOMING_AGG } from "./fixture-logins";

// The phone half of the Upcoming display aggregation (#1504).
//
// The audit that opened the issue was a MEASUREMENT: 7,145px and 58 rows at 390×844,
// with the genuinely attention-worthy items lost in routine. The desktop spec asserts
// the contract (counts, safety pins, identity); this one asserts the thing the fold
// was actually built to buy — vertical cost — at the viewport where it hurt.
//
// Self-relative, not an absolute page budget: the claim is "collapsed is materially
// shorter than the same page expanded", which stays true and meaningful as the fixture
// grows, where a hard pixel ceiling would only measure how many rows the fixture has.
// The fixture profile is spec-owned (seedUpcomingAggregate), so both measurements are
// over exactly the rows this file put there.

// The document's full scrollable height, in CSS px.
async function pageHeight(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollHeight);
}

async function openUpcoming(browser: Browser): Promise<Page> {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_UPCOMING_AGG,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/upcoming");
  await expect(page.getByTestId("upcoming-total")).toBeVisible();
  return page;
}

test("the collapsed planning page is materially shorter than its expanded self (#1504)", async ({
  browser,
}) => {
  const page = await openUpcoming(browser);

  // Collapsed is what a visit costs: stateless, so this is the height on EVERY visit,
  // not just the first.
  const collapsed = await pageHeight(page);

  // Both aggregates carry rows, so both are on screen with their counts stated — the
  // compaction never hid a class, it priced one.
  await expect(page.getByTestId("upcoming-aggregate-dose")).toBeVisible();
  await expect(page.getByTestId("upcoming-aggregate-med-safety")).toBeVisible();

  await expandUpcomingAggregates(page.getByRole("main"));
  const expanded = await pageHeight(page);

  // The whole point: opting in to the rows costs real vertical space, and not opting
  // in saves it. A generous margin — this asserts the direction and a meaningful
  // magnitude, never a pixel-exact layout.
  expect(expanded).toBeGreaterThan(collapsed + 200);
});

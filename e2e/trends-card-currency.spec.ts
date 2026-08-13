import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_CURRENCY,
  TRENDS_CURRENCY_BODY_FAT_PCT,
} from "./fixture-logins";

// WHAT A BODY-CENSUS CHART CARD MAY CLAIM (#2615 item 3).
//
// Two cards, two states, one fixture profile that owns both (see the constants'
// header in e2e/logins/trends.ts — each state is an ABSENCE, which no shared profile
// can hold for long).
//
//   1. A HEADLINE IS A CLAIM ABOUT NOW. The weight card headlines its latest reading
//      in large type beside the title. When that reading is past the metric's
//      presentation floor the number is still true and still shown — the freshness
//      doctrine's rule is about what the card CLAIMS, never what it hides — so it
//      gains the day it was read.
//   2. ONE READING IS NOT A TREND. The body-fat card has exactly one, and used to
//      spend a 90-day band on a single dot clipped against the y-axis. It degrades
//      to the same single-reading mark the Overview tiles have drawn since #1485 G.
//
// Read-only: this spec navigates, and writes nothing anywhere.

// The classic full-chart stack — the surface that carries these headlines. Desktop
// only by design (#2152), which is why this spec has no mobile twin.
const STACK_URL = "/trends?view=all";

test("a stale headline states the day it was read, and keeps its value (#2615)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_TRENDS_CURRENCY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto(STACK_URL);
    const weight = page.getByTestId("body-chart-weight");
    await expect(weight).toBeVisible();

    // The value is NOT withdrawn — it is the most recent weigh-in there is, and
    // hiding it would be the opposite of the fix.
    const headline = weight.getByTestId("chart-card-headline");
    await expect(headline).toContainText(/\d/);

    // …and it no longer claims to be today's. The stamp names a day, never an age:
    // "2 weeks ago" beside a number reads as a second quantity.
    const asOf = weight.getByTestId("chart-card-headline-asof");
    await expect(asOf).toBeVisible();
    await expect(asOf).toHaveText(/^as of \S/);
    await expect(asOf).not.toHaveText(/ago/);
    // The shared glance-age treatment, naming the interval that was crossed —
    // weight's own floor, not a global one.
    await expect(asOf).toHaveAttribute(
      "title",
      "Older than six weeks — still your latest reading, but not a current one"
    );

    // The card is otherwise untouched: it still plots its two weigh-ins.
    await expect(weight.getByTestId("chart-card-plot")).toBeVisible();
    await expect(weight.getByTestId("chart-card-single-reading")).toHaveCount(
      0
    );
  } finally {
    await page.context().close();
  }
});

test("a card with one reading draws the mark, not a near-empty band (#2615)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_TRENDS_CURRENCY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto(STACK_URL);
    const bodyFat = page.getByTestId("body-chart-bodyfat");
    await expect(bodyFat).toBeVisible();

    // The tiles' own words, on the card that taps through to the same data.
    const mark = bodyFat.getByTestId("chart-card-single-reading");
    await expect(mark).toBeVisible();
    await expect(mark.getByTestId("single-reading-caption")).toHaveText(
      /^Single reading · \S/
    );
    // The reading it names is still the card's headline — the degrade is about the
    // PLOT, and it takes no value away.
    await expect(bodyFat.getByTestId("chart-card-headline")).toContainText(
      String(TRENDS_CURRENCY_BODY_FAT_PCT)
    );
    // A recent reading, so this card makes no currency claim to withdraw — which is
    // what keeps the two claims in this file independent of each other.
    await expect(bodyFat.getByTestId("chart-card-headline-asof")).toHaveCount(
      0
    );
    // No chart was drawn behind it.
    await expect(bodyFat.locator(".recharts-wrapper")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

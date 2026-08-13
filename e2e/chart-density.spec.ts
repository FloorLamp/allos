import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_SPARSE,
  TRENDS_SPARSE_WEIGH_IN_DAYS,
  TRENDS_SPARSE_WEIGHT_CAPTION,
} from "./fixture-logins";

// WHAT A THIN SERIES MAY DRAW (#2653 state 5).
//
// A line asserts the space BETWEEN its points. Three weigh-ins five hundred days
// apart got the same confident 2px stroke a series measured every morning gets, so
// almost every pixel on the plot was assertion and none of it said so.
//
// Two cards, two densities, ONE fixture profile that owns both (see the constants'
// header in e2e/logins/trends.ts), on ONE page load — the demotion and its control
// are read from the same render, so "always demote" cannot pass this file.
//
// Read-only: this spec navigates, and writes nothing anywhere.

// The classic full-chart stack over an ALL-TIME window: the weigh-ins straddle
// three years, so a 90-day default would only ever show the last of them.
const STACK_URL = "/trends?view=all&range=all";

// The demoted stroke's exact treatment, pinned as the values the reader actually
// sees rather than as a reference to the constants that produced them — a test that
// reads the same tokens the component reads passes with the feature removed.
const SPARSE_DASH = "2 5";
const SPARSE_OPACITY = "0.4";
const SPARSE_WIDTH = "1";
const CONFIDENT_WIDTH = "2";

test("a thin series demotes its stroke and states its count (#2653)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_TRENDS_SPARSE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto(STACK_URL);
    const weight = page.getByTestId("body-chart-weight");
    await expect(weight).toBeVisible();

    // The count and the span, in the reader's own words. No adjective, no chip,
    // no verdict — the caption exists so a reader can price the stroke, and a
    // badge saying "sparse" would make the card read as more considered than the
    // confident line it replaced.
    await expect(weight.getByTestId("chart-sparse-note")).toHaveText(
      TRENDS_SPARSE_WEIGHT_CAPTION
    );

    // The stroke itself is visibly LESS than a line: thinner, dashed, and part
    // transparent. All three, because any one of them alone still reads as a
    // deliberate kind of line.
    const curve = weight.locator("path.recharts-line-curve");
    await expect(curve).toHaveAttribute("stroke-dasharray", SPARSE_DASH);
    await expect(curve).toHaveAttribute("stroke-opacity", SPARSE_OPACITY);
    await expect(curve).toHaveAttribute("stroke-width", SPARSE_WIDTH);

    // Nothing was hidden and no point moved: all three readings are still drawn,
    // and now they are the heaviest ink on the plot.
    await expect(weight.locator("circle.recharts-line-dot")).toHaveCount(
      TRENDS_SPARSE_WEIGH_IN_DAYS.length
    );

    // The degrade is about the PLOT. This card has three readings, so it is not
    // the one-reading mark (#2671) wearing a different name.
    await expect(weight.getByTestId("chart-card-single-reading")).toHaveCount(
      0
    );
    // …and the headline still carries the latest weigh-in.
    await expect(weight.getByTestId("chart-card-headline")).toContainText(/\d/);
  } finally {
    await page.context().close();
  }
});

test("a measured series on the same page keeps its confident stroke (#2653)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_TRENDS_SPARSE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto(STACK_URL);
    const bodyFat = page.getByTestId("body-chart-bodyfat");
    await expect(bodyFat).toBeVisible();

    // Twenty consecutive days, same window, same card grammar. The treatment is
    // earned by the data or it is decoration.
    await expect(bodyFat.getByTestId("chart-sparse-note")).toHaveCount(0);

    const curve = bodyFat.locator("path.recharts-line-curve");
    await expect(curve).toHaveAttribute("stroke-width", CONFIDENT_WIDTH);
    await expect(curve).not.toHaveAttribute("stroke-dasharray", SPARSE_DASH);
  } finally {
    await page.context().close();
  }
});

import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_SLEEP_WAITING,
  E2E_LOGIN_SLEEP_INPROGRESS,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { expectNoClippedContent } from "./helpers";

// The morning waiting window (#2097), rendered.
//
// Both fixtures carry 14 synced nights ending YESTERDAY and nothing on today's
// wake-day — last night is not in hand, and something is still expected. Which side
// of the wake anchor the render lands on is fixed by each fixture's MEDIAN WAKE
// TIME against the suite's pinned 13:mm local clock, so neither assertion depends on
// the hour CI happens to start.
//
// What both tests are really pinning is an ABSENCE: no headline duration for a night
// nobody asked about. Before this, the surface filled the gap with the most recent
// recorded night — dated honestly since #2099, but still a large number the reader
// had to discount.

test("inside the arrival window, the sleep surfaces NAME the wait instead of showing an older night (#2097)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SLEEP_WAITING,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/sleep");
    const headline = page.getByTestId("sleep-waiting-headline");
    await expect(headline).toBeVisible();
    await expect(headline).toHaveAttribute("data-kind", "waiting");
    await expect(headline).toHaveText("Waiting for last night's sleep");

    // The hero it REPLACES is gone — the whole point is that no duration figure for
    // a different night is on screen under a headline.
    await expect(page.getByTestId("sleep-hero")).toHaveCount(0);
    // …and this is NOT the four-night "not synced" dead end either.
    await expect(page.getByTestId("sleep-stale")).toHaveCount(0);
    await expectNoClippedContent(page);

    // The dashboard tile says the same thing — one decision, three surfaces.
    await page.goto("/");
    const tile = page.getByTestId("sleep-waiting-widget");
    await expect(tile).toBeVisible();
    await expect(tile.getByTestId("sleep-waiting-headline")).toHaveText(
      "Waiting for last night's sleep"
    );
    await expect(page.getByTestId("sleep-last-night-duration")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("before the wake anchor, it names the night in progress and says nothing about the reader (#2097)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SLEEP_INPROGRESS,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/sleep");
    const headline = page.getByTestId("sleep-waiting-headline");
    await expect(headline).toBeVisible();
    await expect(headline).toHaveAttribute("data-kind", "in-progress");
    await expect(headline).toHaveText("Tonight's sleep is still in progress");

    // The state is about the DATA. Nothing on this surface may comment on the hour
    // the reader is keeping — the app cannot know why anyone is awake, and a line
    // about when they are "usually asleep" would only mean anything as an implied
    // should.
    const card = page.getByTestId("sleep-waiting");
    await expect(card).not.toContainText("usually asleep", { ignoreCase: true });
    await expect(card).not.toContainText("you're", { ignoreCase: true });
    await expect(page.getByTestId("sleep-hero")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

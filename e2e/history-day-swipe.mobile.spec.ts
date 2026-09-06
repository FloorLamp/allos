import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import { hydratedClick, touchSwipe } from "./helpers";

// The record's day-view swipe (issue #1425).
//
// On the single-day view a horizontal swipe walks to the adjacent day, using the
// SAME `historyDayHref` destinations the arrows beside it link to — one pair of
// hrefs, built on the server, so the gesture can never land on a different day
// than the control does. The other half of the contract is what the gesture must
// NOT do: vertical scrolling always wins, and a swipe that begins at the screen
// edge belongs to the nav drawer.
//
// The dates below are fixed literals, not derived from "today": this asserts
// day ARITHMETIC and navigation, which must hold on any day the suite runs, and
// a day with nothing logged is a perfectly good (indeed the most interesting)
// case — swiping past a quiet day is exactly when you want the gesture.
const DAY = "2026-03-15";
const NEXT_DAY = "2026-03-16";
const PREV_DAY = "2026-03-14";

function dayUrl(date: string): string {
  return `/history?day=${date}`;
}

// A swiped day change is a CLIENT navigation: the URL only commits once the RSC
// payload for the destination day arrives, and the record is one of the app's
// heaviest server renders (a cold day can take several seconds under `next
// start`). The gesture is not what is slow — the page is — so the assertion gets
// a real budget rather than the 5s default, which fails on the first, coldest
// navigation of a run and passes on every one after it.
const NAV_TIMEOUT = 20_000;

async function landedOn(page: Page, date: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`day=${date}`), {
    timeout: NAV_TIMEOUT,
  });
}

// Gestures are client-only, so a swipe before hydration is swallowed exactly
// like a pre-hydration tap — and unlike a tap it cannot simply be retried, since
// a second day-swipe would skip a day. The shell chrome publishes the moment its
// client listener exists, which is the one deterministic gate available here.
async function hydrated(page: Page): Promise<void> {
  await expect(page.getByTestId("shell-chrome")).toHaveAttribute(
    "data-ready",
    "true"
  );
}

test("swiping left lands on the next day, swiping right on the previous one", async ({
  page,
}) => {
  await page.goto(dayUrl(DAY));
  await hydrated(page);
  await expect(page.getByTestId("timeline-day-nav")).toBeVisible();

  // Left: the day slides away and the next one arrives.
  await touchSwipe(page, { x: 320, y: 520 }, { x: 110, y: 526 });
  await landedOn(page, NEXT_DAY);

  // Right, twice over, back past where we started.
  await touchSwipe(page, { x: 110, y: 520 }, { x: 320, y: 514 });
  await landedOn(page, DAY);
  await touchSwipe(page, { x: 110, y: 520 }, { x: 320, y: 514 });
  await landedOn(page, PREV_DAY);
});

test("the arrows and the swipe reach the same day", async ({ page }) => {
  // The gesture is a shortcut, never the only route: the visible controls carry
  // the same destinations, which is what keeps the day view usable with a
  // keyboard, a mouse, or a screen reader.
  await page.goto(dayUrl(DAY));
  await hydrated(page);

  // hydratedClick, not followLink — the arrows are RELATIVE controls, and since
  // #2869 they are also ANSWERED ones. followLink's retry loop exists to survive
  // a tap swallowed before hydration; it re-clicks until the URL moves, and on a
  // relative control a re-click that lands just after the first navigation
  // commits walks a second day forward (measured: 03-15 → 03-17). The arrow now
  // shows pending from the first frame and absorbs the repeat itself, so there
  // is nothing left for a retry loop to rescue — one click, then assert.
  await hydratedClick(page, page.getByTestId("timeline-day-next"));
  await landedOn(page, NEXT_DAY);
  await expect(page.getByTestId("timeline-day-nav")).toBeVisible();
  await hydratedClick(page, page.getByTestId("timeline-day-prev"));
  await landedOn(page, DAY);
});

test("a mostly-vertical drag scrolls and never changes the day", async ({
  page,
}) => {
  await page.goto(dayUrl(DAY));
  await hydrated(page);

  // The axis lock refuses anything that is not decisively horizontal — a 45°
  // drag reads as a scroll on purpose, because an ambiguous gesture that
  // navigates is a gesture that fires when you meant to read.
  await touchSwipe(page, { x: 200, y: 640 }, { x: 232, y: 300 });
  await expect(page).toHaveURL(new RegExp(`day=${DAY}`));

  await touchSwipe(page, { x: 200, y: 640 }, { x: 300, y: 540 });
  await expect(page).toHaveURL(new RegExp(`day=${DAY}`));
});

test("a swipe from the screen edge opens the drawer instead of changing the day", async ({
  page,
}) => {
  // Two gestures share the rightward swipe. Without the edge carve-out you would
  // land on yesterday with the navigation drawer open over it.
  await page.goto(dayUrl(DAY));
  await hydrated(page);

  await touchSwipe(page, { x: 2, y: 520 }, { x: 230, y: 524 });
  await expect(page.getByTestId("mobile-drawer")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`day=${DAY}`));
});

test("the day view is the only place the swipe is armed", async ({ page }) => {
  // The scrolling record has no single "adjacent day", so there is no nav and no
  // gesture — a horizontal swipe across the feed does nothing. (`/timeline?from=…`
  // used to be this case; the record is navigated rather than windowed, so the
  // multi-day view IS the unfiltered feed.)
  await page.goto("/history");
  await hydrated(page);
  await expect(page.getByTestId("timeline-day-nav")).toHaveCount(0);

  await touchSwipe(page, { x: 320, y: 520 }, { x: 110, y: 526 });
  await expect(page).toHaveURL(/\/history$/);
});

// ── TODAY HAS NO NEXT DAY, AND NEITHER CONTROL PRETENDS IT DOES (#4918) ──────
//
// The arrow shipped pointing at `dayNavHref(day)` — today's own href — while the
// comment above it said "on today it is not drawn at all", and the leftward swipe
// pushed the same href unconditionally. So the most-repeated navigation on a phone
// reloaded the page it was on, and the bar read "‹ Sep 2 · Sep 3 ›".
//
// REACHED THROUGH A FUTURE `?day=` THAT CLAMPS, so the test names no date: whatever
// day the run is on, `clampHistoryDay` lands it on today, which is the state under
// test. The URL after the swipe is compared against the URL BEFORE it — a literal
// would be asserting the clamp rather than the gesture.
test("on today there is no next arrow and a leftward swipe changes nothing", async ({
  page,
}) => {
  await page.goto("/history?day=2099-01-01");
  await hydrated(page);
  await expect(page.getByTestId("timeline-day-nav")).toBeVisible();

  // The bar still NAMES the day it clamped to — the empty-day case #4918 defect 1
  // is about, where the retired per-group header rendered nothing at all.
  const name = page.getByTestId("timeline-day-name");
  await expect(name).toContainText(/record/);
  await expect(page.getByTestId("history-day-link")).toHaveCount(0);

  await expect(page.getByTestId("timeline-day-next")).toHaveCount(0);
  // The prev arrow is untouched: an absence assertion that could not tell "today has
  // no next" from "the bar lost its controls" would pass on both worlds.
  await expect(page.getByTestId("timeline-day-prev")).toBeVisible();

  // THE URL CANNOT SEE THIS DEFECT, and that is why the probe is what it is. The
  // shipped bar passed `dayNavHref(day)` — TODAY'S OWN href — so a leftward swipe on
  // the broken tree pushed a navigation to the page it was already on and the URL
  // was identical either way. What differs is whether a navigation STARTS: the bar
  // announces one through its own `role="status"` slot ("Opening …", #2869) for as
  // long as the transition runs, and a heavy day render keeps that up for a real
  // window. So the assertion is the absence of that announcement across a window in
  // which the broken tree would have made it.
  const before = page.url();
  const announced = page.getByTestId("timeline-day-nav").getByRole("status");
  await touchSwipe(page, { x: 320, y: 520 }, { x: 110, y: 526 });
  await page.waitForTimeout(3_000); // eslint-disable-line no-restricted-properties -- waitfortimeout-ok: the assertion IS an absence — no day change may start in the window one would have been announced in
  await expect(announced).toHaveCount(0);
  expect(page.url(), "a leftward swipe on today must not navigate").toBe(
    before
  );

  // The opposite swipe must reach the previous day. Its loading announcement
  // can finish before touchSwipe returns, so assert the navigation outcome.
  await touchSwipe(page, { x: 110, y: 520 }, { x: 320, y: 514 });
  // NOT a bare `day=\d{4}-…` shape: the clamp is the SERVER's, so the browser URL
  // still reads `day=2099-01-01` and a date-shaped pattern matches it before any
  // navigation happens — which is how this assertion first passed over a swipe that
  // had not landed yet. It names the day that must go instead.
  await expect(page).not.toHaveURL(/day=2099-01-01/, { timeout: NAV_TIMEOUT });
  expect(page.url()).not.toBe(before);
});

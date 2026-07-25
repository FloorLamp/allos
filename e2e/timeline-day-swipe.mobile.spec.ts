import { expect, test, type Page } from "@playwright/test";
import { followLink, touchSwipe } from "./helpers";

// Timeline day-swipe (issue #1425).
//
// On the single-day view a horizontal swipe walks to the adjacent day, using the
// SAME `timelineDayHref` destinations the arrows beside it link to — one pair of
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
  return `/timeline?from=${date}&to=${date}`;
}

// A swiped day change is a CLIENT navigation: the URL only commits once the RSC
// payload for the destination day arrives, and the Timeline is one of the app's
// heaviest server renders (a cold day can take several seconds under `next
// start`). The gesture is not what is slow — the page is — so the assertion gets
// a real budget rather than the 5s default, which fails on the first, coldest
// navigation of a run and passes on every one after it.
const NAV_TIMEOUT = 20_000;

async function landedOn(page: Page, date: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`from=${date}`), {
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

  await followLink(
    page,
    page.getByTestId("timeline-day-next"),
    new RegExp(`from=${NEXT_DAY}`)
  );
  await expect(page.getByTestId("timeline-day-nav")).toBeVisible();
  await followLink(
    page,
    page.getByTestId("timeline-day-prev"),
    new RegExp(`from=${DAY}`)
  );
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
  await expect(page).toHaveURL(new RegExp(`from=${DAY}`));

  await touchSwipe(page, { x: 200, y: 640 }, { x: 300, y: 540 });
  await expect(page).toHaveURL(new RegExp(`from=${DAY}`));
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
  await expect(page).toHaveURL(new RegExp(`from=${DAY}`));
});

test("the day view is the only place the swipe is armed", async ({ page }) => {
  // A multi-day range has no single "adjacent day", so there is no nav and no
  // gesture — a horizontal swipe across the feed does nothing.
  await page.goto("/timeline?from=2026-03-01&to=2026-03-31");
  await hydrated(page);
  await expect(page.getByTestId("timeline-day-nav")).toHaveCount(0);

  await touchSwipe(page, { x: 320, y: 520 }, { x: 110, y: 526 });
  await expect(page).toHaveURL(/from=2026-03-01/);
});

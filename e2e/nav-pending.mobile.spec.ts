import { test, expect } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import { touchSwipe } from "./helpers";

// The day swipe answers the gesture too (issue #2869).
//
// The arrows beside it get their pending state from `useLinkStatus`, which only
// exists inside a `<Link>`. The swipe is a bare `router.push`, so it had none:
// the finger left the screen and nothing happened at all until the next day
// committed — on the most-repeated navigation on a phone, over the connection
// the #2869 report was made on.
//
// It is now pushed inside the component's own transition, and the pending state
// takes the SAME chevron slot the arrow would use rather than inventing a second
// place to look. Held here for the same reason #1956 held its navigation: on an
// idle box the swipe commits too fast to observe, and racing it would make this
// spec a coin flip rather than a contract.

const DAY = "2026-03-15";
const NEXT_DAY = "2026-03-16";

function heldNavigation(): {
  release: () => void;
  handler: (route: Route) => Promise<void>;
  navRequests: () => number;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let navRequests = 0;
  return {
    release,
    navRequests: () => navRequests,
    handler: async (route) => {
      const req = route.request();
      const isPrefetch = !!req.headers()["next-router-prefetch"];
      const isRsc = !!req.headers()["rsc"];
      if (isPrefetch || !isRsc) {
        await route.continue();
        return;
      }
      navRequests += 1;
      await gate;
      await route.continue();
    },
  };
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

test("a day swipe reports pending in the day bar, and a second swipe is dropped (#2869)", async ({
  page,
}) => {
  const nav = heldNavigation();
  await page.route("**/history?*", nav.handler);

  await page.goto(`/history?day=${DAY}`);
  await hydrated(page);
  const next = page.getByTestId("timeline-day-next");
  await expect(next).toBeVisible();

  await touchSwipe(page, { x: 320, y: 520 }, { x: 110, y: 526 });

  // The chevron the arrow would have spun is the slot the swipe spins too.
  await expect(next.getByTestId("nav-link-pending")).toBeVisible();
  await expect(
    page.getByTestId("timeline-day-nav").getByRole("status")
  ).toHaveText(/Opening /);
  expect(new URL(page.url()).searchParams.get("day")).toBe(DAY);

  // A second swipe while the first is in flight is dropped, not dispatched — a
  // fresh push would discard the render already running, which is what turned
  // "slow" into "stuck" in #1956's measurements.
  await touchSwipe(page, { x: 320, y: 520 }, { x: 110, y: 526 });

  nav.release();
  await expect(page).toHaveURL(new RegExp(`day=${NEXT_DAY}`), {
    timeout: 20_000,
  });
  expect(
    nav.navRequests(),
    "a swipe during a pending day change must be absorbed, not dispatched"
  ).toBe(1);
});

test("a slow day swipe raises the top-edge indicator (#2869)", async ({
  page,
}) => {
  // The swipe has a slot of its own now, but the floor still has to cover it:
  // the day bar can be scrolled out of view under the shell chrome, and a
  // gesture answered only where you are not looking is not answered.
  const nav = heldNavigation();
  await page.route("**/history?*", nav.handler);

  await page.goto(`/history?day=${DAY}`);
  await hydrated(page);
  await expect(page.getByTestId("timeline-day-nav")).toBeVisible();

  await touchSwipe(page, { x: 320, y: 520 }, { x: 110, y: 526 });

  await expect(page.getByTestId("nav-progress")).toBeVisible();

  nav.release();
  await expect(page).toHaveURL(new RegExp(`day=${NEXT_DAY}`), {
    timeout: 20_000,
  });
  await expect(page.getByTestId("nav-progress")).toHaveCount(0);
});

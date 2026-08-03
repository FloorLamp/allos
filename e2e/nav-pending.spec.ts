import { test, expect } from "./fixtures";
import type { Route } from "@playwright/test";

// The sidebar answers the tap (issue #1956).
//
// The bug this covers was reported as "every sidebar link swallows taps for
// 6–12 seconds". Instrumenting the click path showed the taps were never
// swallowed: `<Link>` intercepted them and the App Router requested the
// destination's RSC payload within ~20ms every single time. What was missing was
// any VISIBLE consequence — `(app)` ships no `loading.tsx` on purpose (issue
// #530), so the transition has no Suspense boundary to reveal and the old page
// stays untouched until the whole destination has rendered. People read that as
// a frozen app and tapped again, and each extra tap dispatched a FRESH
// navigation that discarded the render already in flight, so impatience was the
// thing keeping the navigation from landing (measured: 5 taps → 5 RSC requests
// and 10.1s, versus 7.1s from a single tap on the same box).
//
// Both halves of that are asserted here, and neither can be asserted against a
// navigation that is allowed to finish at its own speed — on an idle box it
// commits in a few hundred milliseconds, which is too fast to observe and would
// make this spec a race. So the destination's navigation RSC response is HELD by
// a route handler until the test itself releases it. That is not an artificial
// slowdown: it is exactly the window the issue measured, made deterministic.
//
// The hold targets the NAVIGATION's request only. The same URL is also fetched
// by `<Link>` prefetching, which carries `next-router-prefetch` and must not be
// held — holding it would stall the sidebar rather than the navigation, and the
// two are only distinguishable by that header.

const DESTINATION = "/timeline";

/** A promise the test resolves to let the held navigation complete. */
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

test("a sidebar tap shows the row is opening before the destination arrives (#1956)", async ({
  page,
}) => {
  const nav = heldNavigation();
  await page.route(`**${DESTINATION}?*`, nav.handler);

  await page.goto("/");
  const link = page.locator(`aside nav a[href="${DESTINATION}"]`);
  await expect(link).toBeVisible();

  // One tap, and only one. `followLink` is deliberately NOT used: its retry loop
  // exists to survive the pre-hydration window, and re-tapping is precisely the
  // behaviour this fix makes unnecessary — a retrying helper could not tell a
  // tap that was answered from one that was not.
  await link.click();

  // The row says it heard, while the destination is still being held.
  await expect(link.getByTestId("nav-link-pending")).toBeVisible();
  await expect(link.getByRole("status")).toHaveText(/Opening Timeline/);
  // …and the page has NOT moved yet, so this really is the silent window.
  expect(new URL(page.url()).pathname).toBe("/");

  nav.release();
  await expect(page).toHaveURL(new RegExp(`${DESTINATION}$`));
  await expect(link.getByTestId("nav-link-pending")).toHaveCount(0);
});

test("tapping a pending sidebar row again does not restart its navigation (#1956)", async ({
  page,
}) => {
  const nav = heldNavigation();
  await page.route(`**${DESTINATION}?*`, nav.handler);

  await page.goto("/");
  const link = page.locator(`aside nav a[href="${DESTINATION}"]`);
  await expect(link).toBeVisible();

  await link.click();
  await expect(link.getByTestId("nav-link-pending")).toBeVisible();

  // The impatient taps that used to restart the navigation. Each one is a real
  // click on a real, enabled anchor — the row is not disabled, and a disabled
  // row would be the wrong fix (it would also refuse a cmd-click, which opens
  // the route beside this page and never touches this navigation).
  for (let i = 0; i < 4; i += 1) await link.click();

  nav.release();
  await expect(page).toHaveURL(new RegExp(`${DESTINATION}$`));

  // Five taps, ONE navigation. Before the fix this was five, and the fifth is
  // what the URL finally committed from.
  expect(
    nav.navRequests(),
    "a repeat tap on a pending row must be absorbed, not dispatched"
  ).toBe(1);
});

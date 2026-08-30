import { test, expect } from "./fixtures";
import { followLink, hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRAINING_ROLLUP,
} from "./fixture-logins";
import type { Page, Route } from "@playwright/test";

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

// A TOP-LEVEL row. #3079 moved Timeline, which this used to tap, into the
// collapsed "Plan & review" group — a row inside a closed disclosure is not in the
// DOM at all, so the locator below would have failed as "link never visible",
// which reads like a PendingNavLink regression and is not one. What #1956 is about
// is the tap→acknowledgement window on a sidebar row; any row exercises it, and
// /settings has no redirect of its own to confuse the held navigation.
const DESTINATION = "/settings";

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
  //
  // `hydratedClick` is not that, and is required here. It retries only the
  // HYDRATION PROBE and then clicks exactly once, so the one-tap claim survives
  // intact. Without it these specs are self-defeating: a click landing before
  // React attaches the anchor's handler is not intercepted by `<Link>` at all,
  // so the browser issues a full-document GET with no `?_rsc=` query — which
  // means `page.route("**…?*")` never matches it, the navigation is never held,
  // and the window this whole file exists to observe does not happen. It fails
  // as "indicator never appeared", which reads like a product bug and is not
  // one. Observed on CI at 1-in-4 on a loaded 2-core runner while passing 8/8
  // on an idle box, which is the CPU-contention signature #500 describes.
  await hydratedClick(page, link);

  // The row says it heard, while the destination is still being held.
  await expect(link.getByTestId("nav-link-pending")).toBeVisible();
  await expect(link.getByRole("status")).toHaveText(/Opening Settings/);
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

  await hydratedClick(page, link);
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

// ── The guarantee outside the nav chrome (issue #2869) ───────────────────────
//
// #1956 closed the window for nav ROWS. The report that produced #2869 was that
// everything else is still silent on spotty internet, and that a navigation
// whose fetch dies takes the working page with it. Both halves are asserted
// below with the same hold technique — the destination's navigation RSC response
// held until the test releases it — because neither can be observed against a
// navigation allowed to finish at its own speed.

/** Records whether the top-edge indicator was EVER on screen, not whether it is
 *  now. A navigation that commits under the threshold must paint nothing at all,
 *  and "nothing at all" is a claim about the whole window, not about one moment
 *  after it. */
async function watchIndicator(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __allosNavProgressSeen?: boolean };
    w.__allosNavProgressSeen = !!document.querySelector(
      '[data-testid="nav-progress"]'
    );
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="nav-progress"]')) {
        w.__allosNavProgressSeen = true;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  return async () =>
    page.evaluate(
      () =>
        (window as unknown as { __allosNavProgressSeen?: boolean })
          .__allosNavProgressSeen === true
    );
}

/** True while this document has never been reloaded. A hard navigation — Next's
 *  "fall back to browser navigation" — is exactly what destroys it, so this is
 *  how the spec tells a soft navigation that stayed from a page that was torn
 *  down and rebuilt at the same URL. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (
      window as unknown as { __allosSameDocument?: boolean }
    ).__allosSameDocument = true;
  });
  return async () =>
    page.evaluate(
      () =>
        (window as unknown as { __allosSameDocument?: boolean })
          .__allosSameDocument === true
    );
}

const CARD_DESTINATION = "/settings/account";

test("a card link with no slot of its own is answered by the top-edge indicator (#2869)", async ({
  page,
}) => {
  // A settings group card is the shape most of this app navigates by: a whole
  // card, a table row, a drill-down. There is nowhere sensible to put a spinner
  // inside it, which is the entire argument for a floor.
  const nav = heldNavigation();
  await page.route(`**${CARD_DESTINATION}?*`, nav.handler);

  await page.goto("/settings");
  const card = page.getByTestId("settings-group-account");
  await expect(card).toBeVisible();
  const indicatorSeen = await watchIndicator(page);

  await hydratedClick(page, card);

  await expect(page.getByTestId("nav-progress")).toBeVisible();
  await expect(page.getByTestId("nav-progress-status")).toHaveText(
    /Still loading/
  );
  // …and the page has NOT moved, so this is the silent window the report named.
  expect(new URL(page.url()).pathname).toBe("/settings");
  await expect(page.getByTestId("settings-index")).toBeVisible();

  nav.release();
  await expect(page).toHaveURL(new RegExp(`${CARD_DESTINATION}$`));
  await expect(page.getByTestId("nav-progress")).toHaveCount(0);
  expect(await indicatorSeen()).toBe(true);
});

// NOT asserted here: "the indicator never appears when the navigation commits
// under the threshold". That negative is a claim about WALL TIME — it holds only
// if the whole server render plus client commit finishes inside 300ms — and this
// suite runs against `next start` on a shard whose load it does not control, so
// the assertion would be measuring the box rather than the rule. The rule itself
// is pure and is tested as one (lib/__tests__/nav-progress.test.ts: a navigation
// that settles before the threshold emits `waiting` then `idle`, and never
// `slow`). What IS asserted here is the half that depends on the browser: the
// indicator clears at commit, above.

test("a day arrow shows the day opening, and five taps dispatch one navigation (#2869)", async ({
  page,
}) => {
  // The most-repeated navigation on a phone, and until #2869 the one with the
  // least feedback: a plain <Link> with no pending state and no repeat-tap
  // guard, on a control whose whole purpose is being tapped again and again.
  const DAY = "2026-03-15";
  const nav = heldNavigation();
  await page.route("**/history?*", nav.handler);

  await page.goto(`/history?day=${DAY}`);
  const prev = page.getByTestId("timeline-day-prev");
  await expect(prev).toBeVisible();

  await hydratedClick(page, prev);
  await expect(prev.getByTestId("nav-link-pending")).toBeVisible();
  await expect(prev.getByRole("status")).toHaveText(/Opening /);
  expect(new URL(page.url()).searchParams.get("day")).toBe(DAY);

  // The impatient taps. Each is a real click on a real, enabled anchor — a
  // disabled arrow would also refuse a cmd-click, which opens the day beside
  // this page and never touches this navigation.
  for (let i = 0; i < 4; i += 1) await prev.click();

  nav.release();
  await expect(page).toHaveURL(/day=2026-03-14/);
  expect(
    nav.navRequests(),
    "a repeat tap on a pending day arrow must be absorbed, not dispatched"
  ).toBe(1);
});

test("a pager step shows pending in its own label, and absorbs repeat taps (#2869)", async ({
  page,
}) => {
  // "Next, next, next" through a paged history is the same cadence #1956
  // measured turning a slow navigation into a stuck one. The step has no icon,
  // so its own label is the slot: it stays put and legible with the spinner over
  // it, which is why the assertion below is on the anchor rather than its text.
  const nav = heldNavigation();

  // Entered TWICE on purpose. A first visit to /whats-new mounts
  // <MarkWhatsNewSeen>, whose action revalidates the layout (#1421) — and that
  // revalidation evicts the router cache, so the pager's prefetch of page 2 is
  // gone and the navigation has to read the route tree AND its segments: two
  // RSC requests for one tap, which would read here as a repeat tap that was not
  // absorbed. The marker only mounts when something is unseen, so the second
  // entry fires nothing and the count means what it says. The dot clearing is
  // the settle point for the first visit's write.
  await page.goto("/whats-new");
  await expect(page.getByTestId("whats-new-dot")).toHaveCount(0);
  await page.goto("/whats-new");

  await page.route("**/whats-new?page=2*", nav.handler);
  const pager = page.getByTestId("whats-new-pagination");
  await expect(pager).toBeVisible();
  const next = pager.locator('a[href*="page=2"]');
  await expect(next).toBeVisible();

  await hydratedClick(page, next);
  await expect(next.getByTestId("nav-link-pending")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("page")).toBeNull();

  for (let i = 0; i < 4; i += 1) await next.click();

  nav.release();
  await expect(page).toHaveURL(/\/whats-new\?page=2$/);
  expect(
    nav.navRequests(),
    "a repeat tap on a pending pager step must be absorbed, not dispatched"
  ).toBe(1);
});

// RE-POINTED FROM THE RANGE PILL, WHICH #3958 DELETED. This drove
// `timeline-pill-30D`, one of the 7D/30D/90D chips the record rules out entirely
// ("no 7D/30D/90D chips, no From/To card") — so the control is gone, not renamed.
// What #2869 is actually about survives unchanged: a FILTER CHIP that navigates
// shows its pending state in place and absorbs repeat taps. The record's family
// chips are the same `TimelineFilterLink` over the same `PendingLink`, so the
// behaviour under test is identical and the assertion moves to a control that
// exists.
test("a record filter chip shows pending in place, and absorbs repeat taps (#2869)", async ({
  page,
}) => {
  const nav = heldNavigation();
  await page.route("**/history?*", nav.handler);

  await page.goto("/history");
  const chip = page.getByTestId("history-chip-family-logs");
  await expect(chip).toBeVisible();

  await hydratedClick(page, chip);
  await expect(chip.getByTestId("nav-link-pending")).toBeVisible();
  await expect(chip.getByRole("status")).toHaveText(/Opening Logs/);

  for (let i = 0; i < 4; i += 1) await chip.click();

  nav.release();
  await expect(page).toHaveURL(/family=logs/);
  expect(
    nav.navRequests(),
    "a repeat tap on a pending filter chip must be absorbed, not dispatched"
  ).toBe(1);
});

/** A navigation whose RSC read cannot reach the server, until the test says it
 *  can. `abort` is the shape a dropped connection actually takes: `fetch`
 *  rejects, which is the rejection Next turns into a hard document load. */
function deadNavigation(): {
  restore: () => void;
  handler: (route: Route) => Promise<void>;
} {
  let alive = false;
  return {
    restore: () => {
      alive = true;
    },
    handler: async (route) => {
      const req = route.request();
      const isPrefetch = !!req.headers()["next-router-prefetch"];
      const isRsc = !!req.headers()["rsc"];
      if (isPrefetch || !isRsc || alive) {
        await route.continue();
        return;
      }
      await route.abort("failed");
    },
  };
}

// The bounded retry budget (lib/nav-fetch-guard.ts) is ridden out before the ask
// appears, so this waits longer than the default.
const CONCEDE_TIMEOUT = 20_000;

test("a navigation whose fetch dies resolves in the app, and the page keeps working (#2869)", async ({
  page,
}) => {
  // The retry budget is deliberately spent before conceding, so this test is
  // legitimately long rather than slow-for-no-reason.
  test.slow();
  const dead = deadNavigation();
  await page.route(`**${CARD_DESTINATION}?*`, dead.handler);

  await page.goto("/settings");
  await expect(page.getByTestId("settings-group-account")).toBeVisible();
  const sameDocument = await markDocument(page);

  await hydratedClick(page, page.getByTestId("settings-group-account"));

  const failed = page.getByTestId("nav-load-failed");
  await expect(failed).toBeVisible({ timeout: CONCEDE_TIMEOUT });
  await expect(failed).toContainText("check your connection");

  // The three things that must NOT have happened. This document was never torn
  // down, the URL never moved, and the precached offline shell — which is right
  // for a cold start with no page to stay on and wrong as the answer to one lost
  // fetch mid-session — was never served.
  expect(await sameDocument()).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/settings");
  await expect(page.getByText("You're offline")).toHaveCount(0);

  // …and the page under it is still a working page, not a screenshot of one.
  await expect(page.getByTestId("settings-index")).toBeVisible();
  await expect(page.getByTestId("settings-group-display")).toBeVisible();
});

test("retry lands the navigation once the connection is back (#2869)", async ({
  page,
}) => {
  test.slow();
  const dead = deadNavigation();
  await page.route(`**${CARD_DESTINATION}?*`, dead.handler);

  await page.goto("/settings");
  await expect(page.getByTestId("settings-group-account")).toBeVisible();
  const sameDocument = await markDocument(page);

  await hydratedClick(page, page.getByTestId("settings-group-account"));
  await expect(page.getByTestId("nav-load-failed")).toBeVisible({
    timeout: CONCEDE_TIMEOUT,
  });

  dead.restore();
  await page.getByTestId("nav-load-retry").click();

  // The tap they already made is the tap that lands — the held navigation
  // resumes rather than being started over.
  await expect(page).toHaveURL(new RegExp(`${CARD_DESTINATION}$`));
  await expect(page.getByTestId("nav-load-failed")).toHaveCount(0);
  expect(await sameDocument()).toBe(true);
});

// ── Training's navigation surfaces (issue #2983) ─────────────────────────────
//
// Training was fenced for the owner while #2869's sweep ran, so its controls
// kept the global indicator and never got the in-control half. Two classes are
// asserted below.
//
// The first is a CORRECTNESS one and does not belong to the pending doctrine at
// all: four in-app destinations were reached through a raw `<a href>`, which is
// a full document load. That throws away the running client — the exact thing
// #2869's invariant forbids — and no amount of pending treatment applies to a
// navigation the router never sees. `markDocument` is what tells the two apart:
// a soft navigation keeps the document it started in, a hard one does not.
//
// The second is the ordinary in-control half, on the shape training has most of:
// a drill-down into one record, and a stepper that walks the ledger.

const STRENGTH_ANALYZE =
  "/training?tab=analyze&kind=strength&item=Back%20Squat";

test("a training drill-down that was a raw anchor stays in the app, and answers its own tap (#2983)", async ({
  page,
}) => {
  // `StatBox`'s linked value — the Analyze panel's "Last trained" tile, and the
  // door into a session's activity page and into a ride. It was a raw <a>, so
  // this tap used to tear the document down and rebuild the whole app shell.
  const nav = heldNavigation();

  await page.goto(STRENGTH_ANALYZE);
  const tile = page.getByTestId("exercise-last-trained");
  await expect(tile).toBeVisible();
  const link = tile.getByRole("link");
  await expect(link).toBeVisible();
  const sameDocument = await markDocument(page);

  // Held only now: arriving above is itself an RSC navigation.
  await page.route("**/training/activity/*", nav.handler);
  await hydratedClick(page, link);

  // The tile says it heard, in its own slot, while the page has not moved.
  await expect(link.getByTestId("nav-link-pending")).toBeVisible();
  await expect(link.getByRole("status")).toHaveText(/Opening last trained/);
  expect(new URL(page.url()).pathname).toBe("/training");

  nav.release();
  await expect(page).toHaveURL(/\/training\/activity\/\d+$/);
  // The whole point: a SOFT navigation. A raw anchor would have replaced this
  // document, and the marker set before the tap would be gone.
  expect(
    await sameDocument(),
    "an in-app destination must not be reached by a full document load"
  ).toBe(true);
});

test("the activity ledger's ‹older› shows the step, and five taps dispatch one navigation (#2983)", async ({
  page,
}) => {
  // The same shape as the timeline's day arrows, and the same cadence: a review
  // session walks back through activities one tap at a time. The spinner takes
  // the chevron's own box, and the repeat taps are absorbed.
  await page.goto(STRENGTH_ANALYZE);
  await followLink(
    page,
    page.getByTestId("analyze-sessions").getByRole("link").first(), // first-ok: the newest seeded session; the ledger step is what's under test
    /\/training\/activity\/\d+$/
  );
  const older = page.getByTestId("activity-older-link");
  await expect(older).toBeVisible();
  const startedAt = new URL(page.url()).pathname;

  const nav = heldNavigation();
  await page.route("**/training/activity/*", nav.handler);

  await hydratedClick(page, older);
  await expect(older.getByTestId("nav-link-pending")).toBeVisible();
  await expect(older.getByRole("status")).toHaveText(/Opening older activity/);
  expect(new URL(page.url()).pathname).toBe(startedAt);

  // The impatient taps. A real click on a real, enabled anchor each time — a
  // disabled step would also refuse a cmd-click, which opens the neighbour
  // beside this page and never touches this navigation.
  for (let i = 0; i < 4; i += 1) await older.click();

  nav.release();
  await expect(page).not.toHaveURL(new RegExp(`${startedAt}$`));
  // The ledger walks every activity in (date, id) order; every kind now lands
  // in the same canonical detail shell.
  await expect(page.getByTestId("training-activity-page")).toBeVisible();
  expect(
    nav.navRequests(),
    "a repeat tap on a pending ledger step must be absorbed, not dispatched"
  ).toBe(1);
});

test("the training overview's next-workout CTA is a soft navigation that answers its tap (#2983)", async ({
  browser,
}) => {
  // The worst of the four surfaces #2983 named, and the only CORRECTNESS one:
  // this CTA was a raw <a href> inside the app shell, so tapping it discarded
  // the running client and rebuilt the whole app from the server. It is also
  // the `?tab=` navigation the issue names — the card's action lands on Analyze.
  //
  // The shared seed forces profile 1's recommendation to REST, which is not an
  // actionable one, so the CTA does not render there. The training-rollup
  // fixture has ordinary strength history and no routine, so its recommendation
  // is a real "train X" with an action.
  const page = await loginAs(browser, {
    username: E2E_LOGIN_TRAINING_ROLLUP,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    const nav = heldNavigation();

    await page.goto("/training?tab=overview");
    const cta = page.getByTestId("next-workout-details");
    await expect(cta).toBeVisible();
    const sameDocument = await markDocument(page);

    await page.route("**/training?*", nav.handler);
    await hydratedClick(page, cta);

    // The button says it heard, in its own label, while the tab has not moved.
    await expect(cta.getByTestId("nav-link-pending")).toBeVisible();
    await expect(cta.getByRole("status")).toHaveText(/Opening workout details/);
    expect(new URL(page.url()).searchParams.get("tab")).toBe("overview");

    nav.release();
    await expect(page).toHaveURL(/tab=analyze/);
    expect(
      await sameDocument(),
      "the next-workout CTA must not reload the document"
    ).toBe(true);
  } finally {
    await page.context().close();
  }
});

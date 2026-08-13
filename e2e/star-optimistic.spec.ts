import { test, expect } from "./fixtures";
import { type Page, type Request, type Response } from "@playwright/test";
import { loginAs } from "./nav";
import { hydratedClick, settledClick } from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TRENDS_PIN } from "./fixture-logins";

// The ★ paints its tap in the same frame (#2641).
//
// `StarButton` used to be a bare Server-Action `<form>`: the star could not move
// until the write returned, five routes had revalidated and the page had
// re-rendered. This proves the two halves of replacing that with `useOptimistic`,
// and it proves them by CONTROLLING the write's fate from the test rather than by
// timing anything:
//
//   1. the star flips while its Server Action POST is still HELD OPEN, so the paint
//      demonstrably does not depend on the round-trip;
//   2. a write that never lands leaves NOTHING painted — the star returns to its
//      server state and the failure is said out loud.
//
// EVERY STEP SYNCHRONISES ON THE WRITE, NEVER ON THE PAINT. That is not tidiness:
// the first version of this spec asserted the OPTIMISTIC value and then acted on
// the next line, which is a race it introduced itself. The optimistic value is true
// before the write is DISPATCHED, so a POST counter read there could still be 0;
// and it is true before the write RETURNS, so a reload could be answered by this
// single-threaded server ahead of the very POST it was meant to verify — measured
// on a deliberately loaded box as "saved_items rows = 1, star = false", i.e. the
// write landed and the reload simply read the state from before it. So the request
// is awaited before the paint is asserted (which is also what proves the hold is
// real), and the RESPONSE is awaited before anything reads server-rendered state.
//
// Fixture (#868): the #1643 ★-pin member, whose profile seeds `steps` UNSTARRED.
// Both tests leave it that way; test 1 stars and unstars within itself, test 2
// never completes a write at all.
const PIN = { username: E2E_LOGIN_TRENDS_PIN, password: E2E_MEMBER_PASSWORD };
const STEPS_DETAIL = "/trends/metric/steps";

// A Server Action posts to the page it was fired from, so this is the star's write
// and nothing else. GETs on the same path (the router's own refetches) pass
// straight through.
function onThisPage(url: URL): boolean {
  return url.pathname === STEPS_DETAIL;
}

function isStarWrite(request: Request): boolean {
  return (
    request.method() === "POST" &&
    new URL(request.url()).pathname === STEPS_DETAIL
  );
}

// Put the fixture back the way the seed left it, whatever the test did to it.
async function restoreUnstarred(page: Page): Promise<void> {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.goto(STEPS_DETAIL);
  const star = page.getByTestId("star-toggle");
  if ((await star.getAttribute("aria-pressed")) === "true") {
    await settledClick(page, star);
    await expect(star).toHaveAttribute("aria-pressed", "false");
  }
}

test("the ★ flips while its write is still in flight (#2641)", async ({
  browser,
}) => {
  const page = await loginAs(browser, PIN);
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Whether a write is out there, so the cleanup below knows whether it has to wait
  // for one before reading the fixture's state — and never waits when there is none.
  const write = { posts: 0 };
  let settled: Promise<unknown> = Promise.resolve();
  try {
    await page.goto(STEPS_DETAIL);
    const star = page.getByTestId("star-toggle");
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await expect(star).toHaveText("☆Star");

    await page.route(onThisPage, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      write.posts += 1;
      await held;
      await route.continue();
    });
    // Both armed BEFORE the click, so neither can miss its event. `dispatched`
    // resolves when the browser issues the POST — at which point the handler above
    // owns it and it cannot have reached the server; `settled` resolves when the
    // released write actually returns.
    const dispatched = page.waitForRequest(isStarWrite, { timeout: 20_000 });
    settled = page.waitForResponse((r: Response) => isStarWrite(r.request()), {
      timeout: 30_000,
    });

    await hydratedClick(page, star);
    await dispatched;

    // The write is out and HELD, so it cannot have landed — and the star has moved
    // anyway. Both halves are pinned to literals rather than to anything the
    // component derives, so a gutted optimistic path cannot satisfy them by
    // accident.
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(star).toHaveText("★Starred");

    // …and once the held write is let through and has RETURNED, the star stays
    // starred through a reload: the optimistic paint was a preview of a real write,
    // not a substitute for one. The reload comes after `settled` because the server
    // is single-threaded — issued before it, the reload can be answered ahead of
    // the write it is checking.
    release();
    await settled;
    expect(write.posts).toBe(1);
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByTestId("star-toggle")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  } finally {
    release();
    // Never read the fixture's state while its own write is still in flight — the
    // same race the body avoids. Skipped entirely when no POST was ever dispatched,
    // so a failure before the click cannot add this wait to the run.
    if (write.posts > 0) await settled.catch(() => {});
    await restoreUnstarred(page);
    await page.context().close();
  }
});

test("a ★ whose write never lands reverts and says so (#2641)", async ({
  browser,
}) => {
  const page = await loginAs(browser, PIN);
  try {
    await page.goto(STEPS_DETAIL);
    const star = page.getByTestId("star-toggle");
    await expect(star).toHaveAttribute("aria-pressed", "false");

    await page.route(onThisPage, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.abort("failed");
    });

    await hydratedClick(page, star);

    // The optimistic star is never a claim: the write failed, so the control is
    // back where the server left it and the reader is told, rather than being
    // shown a star over a save that did not happen.
    await expect(page.getByTestId("toast")).toContainText(
      "Couldn't complete that action. Try again."
    );
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await expect(star).toHaveText("☆Star");

    // And nothing was written: a reload shows the seed state. Safe to read at once
    // — the write was aborted in the BROWSER, so no request to this server exists
    // for the reload to race.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.reload();
    await expect(page.getByTestId("star-toggle")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  } finally {
    await restoreUnstarred(page);
    await page.context().close();
  }
});

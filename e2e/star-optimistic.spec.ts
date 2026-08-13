import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
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
  try {
    await page.goto(STEPS_DETAIL);
    const star = page.getByTestId("star-toggle");
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await expect(star).toHaveText("☆Star");

    let posts = 0;
    await page.route(onThisPage, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts += 1;
      await held;
      await route.continue();
    });

    await hydratedClick(page, star);

    // The write CANNOT have landed — its response is still held above — and the
    // star has moved anyway. Both halves are pinned to literals rather than to
    // anything the component derives, so a gutted optimistic path cannot satisfy
    // them by accident.
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(star).toHaveText("★Starred");
    expect(posts).toBe(1);

    // …and once the held write is let through, the star stays starred: the
    // optimistic paint was a preview of a real write, not a substitute for one.
    release();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByTestId("star-toggle")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  } finally {
    release();
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

    // And nothing was written: a reload shows the seed state.
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

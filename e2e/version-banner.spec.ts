import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { followLink } from "./helpers";

// The deploy notice is an INLINE BANNER, not a floating toast (issue #1520).
//
// VersionWatcher polls /api/version and, when the server reports a commit that
// isn't the one this tab was served with, says so. It used to say it with a
// `duration: null` toast — a permanent card pinned over the bottom-right corner,
// covering page content (and the workout dock) until dismissed by hand. It now
// renders in the content flow, in the same slot OnboardingReturnBanner uses.
//
// Fixture discipline (#868): this spec WRITES NOTHING. It intercepts the version
// endpoint in its own page context (page.route is per-page, so no other spec sees
// it) and asserts on chrome the shared seed doesn't own.

// A commit that can never be the running build's (the app resolves a real 7-char
// git sha), so the watcher always reads it as a new deploy.
const DEPLOYED = { sha: "1520abc", commitMessage: "e2e deploy notice" };

async function interceptVersion(page: Page) {
  await page.route("**/api/version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEPLOYED),
    })
  );
}

// The watcher checks on its 60s interval AND whenever the tab becomes visible —
// the second is the hook a test can pull. Dispatching before the effect's listener
// is attached does nothing, so re-dispatch until the banner lands; `check()` is
// guarded by its own prompt-once ref, so extra dispatches are no-ops.
async function provokeVersionCheck(page: Page) {
  await expect(async () => {
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await expect(page.getByTestId("version-update-banner")).toBeVisible({
      timeout: 1500,
    });
  }).toPass({ timeout: 25_000, intervals: [300, 700, 1500] }); // topass-ok: re-dispatches the visibility check past the hydration window — the listener only exists once the watcher's effect has run, and there is no POST or navigation to settle on

  return page.getByTestId("version-update-banner");
}

test("a new deploy renders an inline banner in the content flow, with no toast (#1520)", async ({
  page,
}) => {
  await interceptVersion(page);
  await page.goto("/equipment");

  const banner = await provokeVersionCheck(page);
  await expect(banner).toContainText(DEPLOYED.commitMessage);

  // It is PAGE CONTENT: inside the shared content container and statically
  // positioned, so it scrolls with the page instead of floating over it. (The
  // accepted #1520 tradeoff: someone scrolled deep won't see it until they scroll
  // back up — there is deliberately no sticky/fixed fallback to assert.)
  await expect(
    page
      .getByTestId("app-content-container")
      .getByTestId("version-update-banner")
  ).toBeVisible();
  expect(await banner.evaluate((el) => getComputedStyle(el).position)).toBe(
    "static"
  );

  // …and the notice does NOT arrive as a toast any more.
  await expect(page.getByTestId("toast")).toHaveCount(0);

  // It survives client-side navigation: the watcher lives in the persistent app
  // layout, so the banner rides along instead of being re-prompted per page.
  await followLink(
    page,
    page.locator("aside nav").getByRole("link", { name: "Timeline" }),
    /\/timeline/
  );
  await expect(banner).toBeVisible();
  await expect(page.getByTestId("toast")).toHaveCount(0);

  // The Refresh action reloads the tab — the whole point of the notice. A window
  // sentinel proves a real document load, not just a router transition.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__preRefresh = true;
  });
  await page.getByTestId("version-update-refresh").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as Record<string, unknown>).__preRefresh
        ),
      { timeout: 20_000 }
    )
    .toBeUndefined();
});

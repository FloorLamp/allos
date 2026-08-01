import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { followLink } from "./helpers";

// ONE update notice per deploy (issue #1795), driven through the FALLBACK detector.
//
// What this replaces: e2e/version-banner.spec.ts, which pinned a second surface for
// this same event — an inline banner raised by a `/api/version` sha poll, alongside
// the service worker's "Update ready" bar, in different vocabulary, each with its own
// reload button. The poll survives as a detector; the banner does not. So the
// assertions migrate rather than disappear: the deploy is still simulated the same
// way, and it is still the notice's own reload that must reload the tab.
//
// WHY THE FALLBACK PATH IS THE ONE TESTED HERE. The worker path already has its
// end-to-end drive in e2e/sw-update.spec.ts (a second worker generation registered
// against an open page). The half that had no coverage is the context with no worker
// at all — private mode, an unsupported browser, a failed registration — where the
// sha poll IS the detector and must feed the SAME bar rather than a second one.
// `serviceWorkers: "block"` is that context, exactly: registration never yields a
// worker, so the app falls back.
//
// Fixture discipline (#868): this spec WRITES NOTHING. It intercepts the version
// endpoint in its own page context (page.route is per-page, so no other spec sees
// it) and asserts on chrome the shared seed doesn't own.

test.use({ serviceWorkers: "block" });

// A commit that can never be the running build's (the app resolves a real 7-char git
// sha), so the fallback detector always reads it as a new deploy.
const DEPLOYED = { sha: "1795abc", commitMessage: "e2e deploy notice" };

// The retired surface. Asserting its testid is GONE is the point of the migration:
// the incoherence was two notices, so "one" only means something if the other one
// cannot come back.
const RETIRED_BANNER = "version-update-banner";

async function interceptVersion(page: Page) {
  await page.route("**/api/version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEPLOYED),
    })
  );
}

// The detector checks on its 60s interval AND whenever the tab becomes visible — the
// second is the hook a test can pull. Dispatching before the effect's listener is
// attached does nothing (and the listener only exists once registration has reported
// that there is no worker), so re-dispatch until the bar lands; the detector settles
// after the first mismatch, so extra dispatches are no-ops.
async function provokeVersionCheck(page: Page) {
  await expect(async () => {
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await expect(page.getByTestId("update-ready-bar")).toBeVisible({
      timeout: 1500,
    });
  }).toPass({ timeout: 25_000, intervals: [300, 700, 1500] }); // topass-ok: re-dispatches the visibility check past the hydration window — the listener only exists once the registrar's effect has settled, and there is no POST or navigation to settle on

  return page.getByTestId("update-ready-bar");
}

test("a deploy with no service worker raises exactly one notice, and it names the build (#1795)", async ({
  page,
}) => {
  await interceptVersion(page);
  await page.goto("/equipment");

  const bar = await provokeVersionCheck(page);

  // ONE notice — not the bar plus a banner, which is what a single deploy used to
  // produce when two detectors owned two surfaces.
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(1);
  await expect(page.getByTestId(RETIRED_BANNER)).toHaveCount(0);
  await expect(page.getByTestId("toast")).toHaveCount(0);

  // It carries the bar's posture (#1700) and the banner's one genuinely better
  // detail: what was deployed.
  await expect(bar).toContainText("Update ready");
  await expect(bar.getByTestId("update-ready-commit")).toHaveText(
    DEPLOYED.commitMessage
  );

  // It survives client-side navigation: the notice lives in the root layout, so it
  // rides along instead of being re-prompted per page.
  await followLink(
    page,
    page.locator("aside nav").getByRole("link", { name: "Timeline" }),
    /\/timeline/
  );
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(1);
  await expect(page.getByTestId(RETIRED_BANNER)).toHaveCount(0);

  // Dismissible, and it stays dismissed across navigation — an offer, not a nag.
  await bar.getByTestId("update-ready-dismiss").click();
  await expect(bar).toHaveCount(0);
  await followLink(
    page,
    page.locator("aside nav").getByRole("link", { name: "Upcoming" }),
    /\/upcoming/
  );
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);
});

test("the notice's reload reloads the tab, and nothing re-offers the update afterwards (#1795)", async ({
  page,
}) => {
  await interceptVersion(page);
  await page.goto("/equipment");

  const bar = await provokeVersionCheck(page);

  // A window sentinel proves a real document load, not just a router transition.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__preRefresh = true;
  });
  // The deploy is over from here on: drop the interception so the reloaded page reads
  // the sha it was actually served with, the way a tab that took a real update does.
  await page.unroute("**/api/version");
  await bar.getByTestId("update-ready-reload").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as Record<string, unknown>).__preRefresh
        ),
      { timeout: 20_000 }
    )
    .toBeUndefined();

  // …and the update the user just took is not offered again. The settle point is the
  // detector's own read: once the reloaded page has asked the server for its commit
  // and been told it is already on it, nothing is left that could raise a bar.
  await expect(async () => {
    const answered = page.waitForResponse(
      (res) => res.url().includes("/api/version"),
      { timeout: 2000 }
    );
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await answered;
  }).toPass({ timeout: 25_000, intervals: [300, 700, 1500] }); // topass-ok: same re-dispatch as above — the listener is attached asynchronously after load, and the response being waited for IS the settle point rather than a timeout
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);
  await expect(page.getByTestId(RETIRED_BANNER)).toHaveCount(0);
});

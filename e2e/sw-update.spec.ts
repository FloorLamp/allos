import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";

// Deferred service-worker activation (issue #1700), driven against the real worker.
//
// The regression: `skipWaiting()` in install plus `clients.claim()` on activate meant
// a deploy took over already-open tabs and dropped the shell cache the loaded
// document was built against — the reported symptom being a workout in progress
// vanishing when the app updated. What must hold now:
//
//   * a NEW worker version installs and WAITS. The open page keeps its controller,
//     keeps running, and keeps every character the user has typed.
//   * the page offers the update instead of taking it: a small, dismissible bar.
//   * the reload happens on the tap, once, and lands on the new build.
//
// The e2e server runs `next start` (NODE_ENV=production), which is the only mode in
// which the app registers a worker at all — see components/ServiceWorkerRegister.

// The app's own registration lands as ?v=<sha|dev>; the spec registers a DIFFERENT
// version against the same scope, which is exactly what a deploy does.
const NEXT_VERSION = "sw-update-spec";
// Registration + install of a second worker generation is a browser-paced sequence
// with no server round-trip to key off. Named ceiling per the e2e-hygiene census.
const SW_SETTLE_MS = 20_000;

async function waitForController(page: Page) {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, {
    timeout: SW_SETTLE_MS,
  });
}

async function controllerScript(page: Page): Promise<string> {
  return page.evaluate(
    () => navigator.serviceWorker.controller?.scriptURL ?? ""
  );
}

test("a new build waits instead of taking over the open page (#1700)", async ({
  page,
}) => {
  test.slow();
  // Count loads in the page itself, so "reloaded exactly once" is measurable rather
  // than inferred from a sleep.
  await page.addInitScript(() => {
    const n = Number(sessionStorage.getItem("swSpecLoads") ?? "0");
    sessionStorage.setItem("swSpecLoads", String(n + 1));
  });

  await page.goto("/training");
  await waitForController(page);
  const before = await controllerScript(page);
  expect(before).toContain("/sw.js?v=");

  // Type into a form and leave it unsaved — the state a takeover used to destroy.
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();
  const title = page.getByLabel("Activity name");
  await title.fill("Kept across the update");

  // Deploy, as the browser sees one: a worker script at a new URL, same scope.
  await page.evaluate(
    (v) => navigator.serviceWorker.register(`/sw.js?v=${v}`),
    NEXT_VERSION
  );

  // The offer appears…
  const bar = page.getByTestId("update-ready-bar");
  await expect(bar).toBeVisible({ timeout: SW_SETTLE_MS });
  await expect(bar).toContainText("Update ready");

  // …and NOTHING else happened. The page did not reload, the new worker did not
  // claim it, and the half-typed workout is still on screen.
  expect(await page.evaluate(() => sessionStorage.getItem("swSpecLoads"))).toBe(
    "1"
  );
  expect(await controllerScript(page)).toBe(before);
  await expect(title).toHaveValue("Kept across the update");

  // The bar is an offer, not a nag: dismissing it leaves the page alone.
  await bar.getByTestId("update-ready-dismiss").click();
  await expect(bar).toHaveCount(0);
  expect(await controllerScript(page)).toBe(before);
  await expect(title).toHaveValue("Kept across the update");
});

test("the update lands on the user's tap, exactly once (#1700)", async ({
  page,
}) => {
  test.slow();
  await page.addInitScript(() => {
    const n = Number(sessionStorage.getItem("swSpecLoads") ?? "0");
    sessionStorage.setItem("swSpecLoads", String(n + 1));
  });

  await page.goto("/training");
  await waitForController(page);

  await page.evaluate(
    (v) => navigator.serviceWorker.register(`/sw.js?v=${v}`),
    NEXT_VERSION
  );
  const bar = page.getByTestId("update-ready-bar");
  await expect(bar).toBeVisible({ timeout: SW_SETTLE_MS });

  await Promise.all([
    page.waitForLoadState("load"),
    bar.getByTestId("update-ready-reload").click(),
  ]);

  // The tap activated the waiting worker and reloaded onto it.
  await waitForController(page);
  await expect
    .poll(() => controllerScript(page), {
      timeout: SW_SETTLE_MS,
      message: "the requested build to take control after the reload",
    })
    .toContain(NEXT_VERSION);

  // Exactly one reload. The app re-registers its own version on this fresh load,
  // which becomes the next WAITING worker — the bar returning is both the proof
  // that the deferred posture still holds and a real settle point to re-check the
  // load counter against (no sleep involved).
  await expect(page.getByTestId("update-ready-bar")).toBeVisible({
    timeout: SW_SETTLE_MS,
  });
  expect(await page.evaluate(() => sessionStorage.getItem("swSpecLoads"))).toBe(
    "2"
  );
  expect(await controllerScript(page)).toContain(NEXT_VERSION);
});

import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { UPDATE_PENDING_KEY } from "@/lib/sw-update";

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

// A real deploy moves the SERVER's sha together with the worker's URL; the harness
// can only move the second. So the specs move the first themselves: intercepting
// /api/version to name a build this page is not on makes the simulated deploy read
// as a real one. Without it, the update would (rightly) never be offered — a
// waiting worker for the build the page already runs is consumed silently (#1905).
const DEPLOYED = { sha: "1700abc", commitMessage: "e2e worker deploy" };

async function interceptVersion(page: Page) {
  await page.route("**/api/version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEPLOYED),
    })
  );
}

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

  await interceptVersion(page);
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
  await page.addInitScript((pendingKey) => {
    const n = Number(sessionStorage.getItem("swSpecLoads") ?? "0");
    sessionStorage.setItem("swSpecLoads", String(n + 1));
    // Record when THIS document raises the update-pending marker (#1906), so the
    // back half can require the raise-then-consume ORDER. Sampling the marker
    // alone cannot: the reloaded page inherits the tapped page's marker, clears
    // it on mount, and only then re-raises it for its own worker generation — a
    // poll could land in that gap and read "consumed" before anything was raised.
    let raised = false;
    const original = sessionStorage.setItem.bind(sessionStorage);
    sessionStorage.setItem = (key: string, value: string) => {
      if (key === pendingKey) raised = true;
      original(key, value);
    };
    (window as unknown as Record<string, unknown>).__swSpecPendingRaised = () =>
      raised;
  }, UPDATE_PENDING_KEY);

  await interceptVersion(page);
  await page.goto("/training");
  await waitForController(page);

  await page.evaluate(
    (v) => navigator.serviceWorker.register(`/sw.js?v=${v}`),
    NEXT_VERSION
  );
  const bar = page.getByTestId("update-ready-bar");
  await expect(bar).toBeVisible({ timeout: SW_SETTLE_MS });

  // The deploy is over from here on: drop the interception so the reloaded page
  // reads the sha it was actually served with, the way a tab that took a real
  // update does.
  await page.unroute("**/api/version");
  await bar.getByTestId("update-ready-reload").click();

  // Assert the OUTCOME (the page loaded a second time) rather than catching the
  // `load` event: the reload is triggered from inside the page on a worker
  // handshake, so polling the page's own load counter is both the honest question
  // and the one that survives the navigation it is watching.
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(() =>
            sessionStorage.getItem("swSpecLoads")
          );
        } catch {
          return null; // mid-navigation: the execution context is being replaced
        }
      },
      {
        timeout: SW_SETTLE_MS,
        message: "the tap to reload the page exactly once",
      }
    )
    .toBe("2");

  // The reload is proof of the message contract end to end: this page reloads ONLY
  // because the tap asked it to, and it lands on a worker-controlled page.
  await waitForController(page);
  expect(await controllerScript(page)).toContain("/sw.js?v=");

  // The fresh load re-registers the app's OWN version, which becomes the next
  // WAITING worker — for the build this page is already running, because the page's
  // own registration is what discovered it. That is the #1905 refresh shape, and
  // the fixed contract is that it is consumed SILENTLY: the page posts the
  // skip-waiting handshake, clears its pending state, raises no bar and reloads
  // nothing.
  //
  // The settle point is the page's own pending state (#1906) — raised for the new
  // generation, then cleared — NOT the worker reaching `active` (#2155). Chrome may
  // hold a skip-waiting activation until the outgoing worker is idle: observed
  // stalls on an idle page outlast any reasonable ceiling, and nothing but the next
  // navigation un-sticks them, so the activation instant is the platform's
  // bookkeeping, not this app's contract. What IS the app's contract: the pending
  // state its own generation raised was consumed rather than offered, and the
  // generation is still held by the registration (waiting, or already active) —
  // nothing ping-ponged it back into a bar.
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ specVersion, pendingKey }) => {
            const reg = await navigator.serviceWorker.getRegistration();
            if (!reg) return "no registration";
            const appGeneration = [reg.active, reg.waiting].some(
              (sw) => sw && !sw.scriptURL.includes(specVersion)
            );
            if (!appGeneration) return "app generation not registered yet";
            const raised = (
              window as unknown as Record<string, () => boolean>
            ).__swSpecPendingRaised();
            if (!raised) return "pending state not raised yet";
            if (sessionStorage.getItem(pendingKey) !== null)
              return "pending state not consumed yet";
            return "consumed silently";
          },
          { specVersion: NEXT_VERSION, pendingKey: UPDATE_PENDING_KEY }
        ),
      {
        timeout: SW_SETTLE_MS,
        message: "the app's own worker generation to be consumed silently",
      }
    )
    .toBe("consumed silently");
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("swSpecLoads"))).toBe(
    "2"
  );
});

import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { spendAutoReloadRation } from "./helpers";
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
//
// EVERY TEST HERE SPENDS THE #2471 RATION FIRST. Since that issue the bar is not the
// first answer to a pending update — converging on the new build by itself is — so a
// tab with the automatic attempt still available reloads rather than offering. What
// these tests are about is unchanged and still real: the WORKER contract (installs
// and waits, claims nobody, hands over on the handshake) and the DETECTION contract
// (#2329's open controlled tab). Both are reached through the fallback bar, which is
// the affordance a tab in that state genuinely renders. The automatic path's own
// drive is e2e/update-notice.spec.ts and e2e/stale-build-save.spec.ts.

// The app's own registration lands as ?v=<sha|dev>; the two #1700 specs below
// register a DIFFERENT version against the same scope by hand.
//
// THAT IS NOT WHAT A DEPLOY DOES (issue #2329), and the sentence that used to claim
// it was is the premise that hid a dead update bar for a week. Nothing in the app
// calls register() twice: an open tab registered once, with the sha it was served
// with, and public/sw.js reads its version from its own URL — so a deploy changes
// none of its bytes and produces no waiting worker for a document that is already
// open. What a hand-registered second version genuinely drives is the RESOLUTION
// path — the wait-then-offer posture and the skip-waiting handshake, which are real
// and are what these two tests are about. The DETECTION path, which is what an open
// tab actually experiences, is driven by the #2329 tests at the bottom of this file.
const NEXT_VERSION = "sw-update-spec";
// Registration + install of a second worker generation is a browser-paced sequence
// with no server round-trip to key off. Named ceiling per the e2e-hygiene census.
const SW_SETTLE_MS = 20_000;

// A real deploy moves the SERVER's sha together with the worker's URL; the harness
// can only move the second. So the specs move the first themselves: intercepting
// /api/version to name a build this page is not on makes the simulated deploy read
// as a real one. Without it, the update would (rightly) never be offered — a
// waiting worker for the build the page already runs is consumed silently (#1905).
//
// INSTALLED BEFORE goto, ARMED LATER — both halves load-bearing.
//
// Armed later, because the sha read is the DETECTOR now (#2329): the mount read
// must be answered HONESTLY (the page really is on the served build), or the bar
// rises off the poll before a test's hand-registered worker even exists, and the
// #1700 tests would assert the resolution mechanic against a bar it did not raise.
// While disarmed the route passes through, which answers that read from the real
// server.
//
// Installed before goto, because `page.route` installed into a page ALREADY
// CONTROLLED by a service worker sometimes never applies to that page — and the
// miss is permanent for the page's lifetime, so no retry can recover it. When it
// struck, the "deploy" un-happened mid-test: the re-armed sha read reached the
// real server, answered "you are on the deployed build", and the plan silently
// consumed the spec's worker (:123) or detected nothing at all (:308) — the bar
// then had no path to render inside any ceiling. Reproduced outside the harness
// at ~8–13% per cold-started browser, with the route seeing ZERO requests in
// every failing run; routes registered before navigation predate the worker and
// were hit in 15/15. See the diagnosis on the PR.
const DEPLOYED = { sha: "1700abc", commitMessage: "e2e worker deploy" };

async function interceptVersion(
  page: Page
): Promise<{ arm: () => void; disarm: () => void }> {
  let armed = false;
  await page.route("**/api/version", (route) => {
    if (!armed) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEPLOYED),
    });
  });
  return {
    arm: () => {
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
  };
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

  await spendAutoReloadRation(page);
  const deploy = await interceptVersion(page);
  await page.goto("/training");
  await waitForController(page);
  const before = await controllerScript(page);
  expect(before).toContain("/sw.js?v=");
  deploy.arm();

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

  await spendAutoReloadRation(page);
  const deploy = await interceptVersion(page);
  await page.goto("/training");
  await waitForController(page);
  deploy.arm();

  await page.evaluate(
    (v) => navigator.serviceWorker.register(`/sw.js?v=${v}`),
    NEXT_VERSION
  );
  const bar = page.getByTestId("update-ready-bar");
  await expect(bar).toBeVisible({ timeout: SW_SETTLE_MS });

  // The deploy is over from here on: disarm, so the reloaded page's reads pass
  // through to the sha it was actually served with, the way a tab that took a
  // real update does. Disarm rather than unroute — the pre-installed route must
  // survive for the reloaded page, where installing a new one could miss again.
  deploy.disarm();
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

// ── A DEPLOY UNDER AN OPEN TAB (issue #2329) ─────────────────────────────────
//
// The shape neither spec in this file nor e2e/update-notice.spec.ts covered, and the
// one production actually has: a tab that is open, worker-registered and controlled,
// while the SERVER moves to a new build. Nothing registers a second worker, because
// nothing in the app ever does — only a fresh document calls register(), and this
// document is not fresh. The two existing tests above hand-register one; the fallback
// spec blocks service workers entirely. Between them they described every context
// except the one the bar exists for, and the bar was dead in it from Aug 1 to this
// issue.
//
// On main today both of these fail at the bar never appearing: with a worker active
// the sha poll was switched off, the worker could not notice the deploy, and `pending`
// was false forever.

// The detector reads on mount and on the shared cadence, and additionally whenever
// the tab regains focus — the third is the hook a test can pull, since the deploy
// here happens AFTER the mount read has already been answered honestly. Dispatching
// before the listener is attached does nothing, so re-dispatch until the bar lands;
// the read settles on the first mismatch, so extra dispatches are no-ops.
async function provokeVersionCheck(page: Page) {
  await expect(async () => {
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await expect(page.getByTestId("update-ready-bar")).toBeVisible({
      timeout: 1500,
    });
  }).toPass({ timeout: 25_000, intervals: [300, 700, 1500] }); // topass-ok: re-dispatches the visibility check until the registrar's effect has attached its listener — there is no POST or navigation to settle on

  return page.getByTestId("update-ready-bar");
}

async function waitingWorkerCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.waiting ? 1 : 0;
  });
}

test("a deploy under a controlled tab raises the bar, with no second worker (#2329)", async ({
  page,
}) => {
  test.slow();
  await spendAutoReloadRation(page);
  const deploy = await interceptVersion(page);
  await page.goto("/training");
  await waitForController(page);
  expect(await controllerScript(page)).toContain("/sw.js?v=");

  // Nothing is pending yet: this tab is on the build the server is running.
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);

  // The deploy, exactly as an open tab experiences it: the server now reports a
  // commit this document was not served with. No new script, no register() call, no
  // waiting worker — the document is already open, and only a fresh one ever
  // discovers a worker.
  deploy.arm();
  const bar = await provokeVersionCheck(page);

  await expect(bar).toContainText("Update ready");
  await expect(bar.getByTestId("update-ready-commit")).toHaveText(
    DEPLOYED.commitMessage
  );
  // ONE notice, and it came from the sha read: there is no waiting worker anywhere
  // in this registration, which is what makes this the detection path rather than
  // the resolution path the two tests above drive.
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(1);
  expect(await waitingWorkerCount(page)).toBe(0);
  expect(await controllerScript(page)).toContain("/sw.js?v=");
});

test("that bar's Reload loads the document, and nothing re-offers (#2329)", async ({
  page,
}) => {
  test.slow();
  await spendAutoReloadRation(page);
  const deploy = await interceptVersion(page);
  await page.goto("/training");
  await waitForController(page);

  deploy.arm();
  const bar = await provokeVersionCheck(page);

  // A window sentinel proves a real document load, not just a router transition.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__preRefresh = true;
  });
  // The deploy is over from here on: disarm (not unroute — the pre-installed route
  // must survive for the reloaded page), so it reads the sha it was actually served
  // with, the way a tab that took a real update does.
  deploy.disarm();
  await bar.getByTestId("update-ready-reload").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as Record<string, unknown>).__preRefresh
        ),
      { timeout: SW_SETTLE_MS }
    )
    .toBeUndefined();

  // There was no waiting worker to hand over to, so `reloadPlanFor` took the plain
  // reload — which is right: navigations are network-first (public/sw.js never caches
  // HTML), so this lands on the new build's document and its fresh chunk URLs.
  await waitForController(page);
  expect(await controllerScript(page)).toContain("/sw.js?v=");

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
});

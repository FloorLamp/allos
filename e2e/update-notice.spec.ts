import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { followLink, spendAutoReloadRation } from "./helpers";
import {
  UPDATE_PENDING_KEY,
  UPDATE_PENDING_MARKER,
  UPDATE_TAKEN_KEY,
  UPDATE_TAKEN_MESSAGE,
} from "@/lib/sw-update";

// ONE notice per deploy (#1795), now on the OTHER side of the event (#2471), driven
// through the FALLBACK detector.
//
// WHAT CHANGED. Until #2471 a deploy asked before it did anything: a bar, a tap, a
// reload. The ruling is that the tab should schedule that itself, so the ordinary
// answer to a deploy is now — reload at the first provably-safe moment, then say so
// once. The bar survives only as the rationed-failure fallback: the automatic attempt
// has been spent and the tab is still stale, or work on screen would not survive a
// reload. Both halves are driven here, and the split is deliberate: the first two
// tests take the automatic path, the last two spend the ration first and assert the
// old contract, unchanged, in the state that still reaches it.
//
// WHY THE FALLBACK PATH (no worker) IS THE ONE TESTED HERE. The worker path has its
// end-to-end drive in e2e/sw-update.spec.ts. The half that had no coverage is the
// context with no worker at all — private mode, an unsupported browser, a failed
// registration — where the sha poll IS the detector and must feed the SAME one
// notice rather than a second one. `serviceWorkers: "block"` is that context exactly.
//
// Fixture discipline (#868): this spec WRITES NOTHING. It intercepts the version
// endpoint in its own page context (page.route is per-page, so no other spec sees
// it) and asserts on chrome the shared seed doesn't own.

test.use({ serviceWorkers: "block" });

// A commit that can never be the running build's (the app resolves a real 7-char git
// sha), so the fallback detector always reads it as a new deploy.
const DEPLOYED = { sha: "1795abc", commitMessage: "e2e deploy notice" };

// Debounced draft writes, a document load and the detector's own read have no single
// UI settle point between them. Named ceiling per the e2e-hygiene census.
const UPDATE_SETTLE_MS = 20_000;

async function interceptVersion(page: Page) {
  await page.route("**/api/version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEPLOYED),
    })
  );
}

// The deploy, answered ONCE. The automatic path reloads the tab, and the reloaded
// document must read the sha it was actually served with — the way a tab that took a
// real update does — or it would keep finding the same simulated deploy forever.
// Counting the armed answers rather than disarming on a navigation event is what
// makes that deterministic: the detector reads once on mount and then latches
// (`finalRef`) on the mismatch it finds, so exactly one armed answer is one deploy.
async function interceptVersionOnce(page: Page) {
  let served = 0;
  await page.route("**/api/version", (route) => {
    if (served > 0) return route.continue();
    served += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEPLOYED),
    });
  });
}

/** Count document loads in the page itself, so "reloaded once" is measurable. */
async function countLoads(page: Page) {
  await page.addInitScript(() => {
    const n = Number(sessionStorage.getItem("updateSpecLoads") ?? "0");
    sessionStorage.setItem("updateSpecLoads", String(n + 1));
  });
}

async function loads(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => sessionStorage.getItem("updateSpecLoads"));
  } catch {
    return null; // mid-navigation: the execution context is being replaced
  }
}

// The detector checks on its 60s interval AND whenever the tab becomes visible — the
// second is the hook a test can pull. Dispatching before the effect's listener is
// attached does nothing, so re-dispatch until the bar lands; the detector settles
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

test("a clean tab takes the deploy by itself and says so afterwards (#2471)", async ({
  page,
}) => {
  test.slow();
  await countLoads(page);
  await interceptVersionOnce(page);

  // Nothing is typed, nothing is in flight, and nobody is touching the page — which
  // is the whole of what "the first safe moment" means for a clean tab.
  await page.goto("/equipment");

  // No consent bar, ever: the tab converges instead of asking.
  await expect
    .poll(() => loads(page), {
      timeout: UPDATE_SETTLE_MS,
      message: "the tab to reload itself onto the new build",
    })
    .toBe("2");

  // The notice inverts: tell-after, not ask-before — and it names what shipped.
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText(UPDATE_TAKEN_MESSAGE, {
    timeout: UPDATE_SETTLE_MS,
  });
  await expect(toast).toContainText(DEPLOYED.commitMessage);
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);

  // ONE notice per taken build, and the consumption IS the dedupe: the marker is
  // gone, so no later reload — a manual refresh, #2155's late controller swap —
  // can toast for the build this tab just took.
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), UPDATE_TAKEN_KEY)
  ).toBeNull();
  await followLink(
    page,
    page.locator("aside nav").getByRole("link", { name: "Timeline" }),
    /\/timeline/
  );
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), UPDATE_TAKEN_KEY)
  ).toBeNull();
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);
  // …and the tab did not reload a second time for the same build.
  expect(await loads(page)).toBe("2");
});

test("a tab that is never quiet is left alone until it is (#2471)", async ({
  page,
}) => {
  test.slow();
  await countLoads(page);
  await interceptVersionOnce(page);
  await page.goto("/equipment");

  // A reload mid-scroll or mid-typing is the disruption the old bar was protecting
  // against, and the quiet gate is what replaces it. Drive continuous input for
  // longer than the quiet window and the document must survive it — literally: if
  // the tab reloaded, this evaluate's execution context would be destroyed and the
  // call would reject rather than resolve.
  await expect(
    page.evaluate(async () => {
      (window as unknown as Record<string, unknown>).__survived = true;
      // 30 × 200ms = six seconds of continuous input, twice the quiet window. A
      // count rather than a clock read: the duration is the point, and the harness
      // freezes the page's clock anyway.
      for (let i = 0; i < 30; i += 1) {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "a", bubbles: true })
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return (window as unknown as Record<string, unknown>).__survived === true;
    })
  ).resolves.toBe(true);
  expect(await loads(page)).toBe("1");

  // The input stops, the tab goes quiet, and it converges on its own.
  await expect
    .poll(() => loads(page), {
      timeout: UPDATE_SETTLE_MS,
      message: "the tab to reload once the page went quiet",
    })
    .toBe("2");
  await expect(page.getByTestId("toast")).toContainText(UPDATE_TAKEN_MESSAGE, {
    timeout: UPDATE_SETTLE_MS,
  });
});

test("with the automatic attempt spent, the deploy raises exactly one bar and it names the build (#1795)", async ({
  page,
}) => {
  // THE FALLBACK CONTRACT. A broken deploy — one the automatic reload has already
  // tried and failed to land — degrades to the affordance that shipped before #2471,
  // never to a reload loop. Spending the ration up front is that state.
  await spendAutoReloadRation(page);
  await interceptVersion(page);
  await page.goto("/equipment");

  const bar = await provokeVersionCheck(page);

  // ONE notice — not the bar plus a banner, which is what a single deploy used to
  // produce when two detectors owned two surfaces.
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(1);
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

  // Dismissible, and it stays dismissed across navigation. The bar is an offer again
  // in exactly this state, and an undismissable permanent bar on a deploy that keeps
  // failing would be worse than the thing #2471 replaced.
  await bar.getByTestId("update-ready-dismiss").click();
  await expect(bar).toHaveCount(0);
  await followLink(
    page,
    page.locator("aside nav").getByRole("link", { name: "Upcoming" }),
    /\/upcoming/
  );
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);
});

test("the pending update is recorded where the crash boundary can read it (#1906)", async ({
  page,
}) => {
  // THE CONTRACT THIS PINS. A tab with a pending update is running a build whose
  // hashed chunks the deploy has removed, so a client navigation to a route it has
  // not visited can throw ABOVE the route group — and app/global-error.tsx replaces
  // the root layout, so ServiceWorkerRegister is not mounted when that boundary has
  // to tell deployment skew from an ordinary crash. A per-tab marker is the only
  // channel that survives; this asserts the registrar actually writes it, and clears
  // it, so the boundary's decision is fed by the real pending state rather than by a
  // key nobody sets. Driven with the ration spent, because that is the tab that
  // stays stale long enough for any of this to matter.
  await spendAutoReloadRation(page);
  await page.goto("/equipment");

  // Before any deploy: no marker, so the boundary would render its card.
  await expect
    .poll(() =>
      page.evaluate((k) => sessionStorage.getItem(k), UPDATE_PENDING_KEY)
    )
    .toBeNull();

  await interceptVersion(page);
  await provokeVersionCheck(page);

  await expect
    .poll(() =>
      page.evaluate((k) => sessionStorage.getItem(k), UPDATE_PENDING_KEY)
    )
    .toBe(UPDATE_PENDING_MARKER);

  // Dismissing the bar hides the OFFER but does not un-deploy anything: the tab is
  // still on the old build, so the marker must stay. This is the case a naive
  // "clear it when the bar goes away" would get wrong, and it is exactly the tab
  // that goes on to hit a missing chunk.
  await page
    .getByTestId("update-ready-bar")
    .getByTestId("update-ready-dismiss")
    .click();
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), UPDATE_PENDING_KEY)
  ).toBe(UPDATE_PENDING_MARKER);
});

import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { hydratedClick } from "./helpers";
import { workerAuthPath } from "./worker-env";

// The complementary half of the dirty-form registry (issue #1878): a refresh the
// USER asked for is never deferred.
//
// Pull-to-refresh is the sharpest case. It exists only in the installed PWA,
// where there is no URL bar and therefore no other way to say "give me current
// data" — a gesture whose entire meaning is that request. Swallowing it because
// some form on the page is dirty would be its own bug, and a worse one than the
// wipe: the user would pull, see nothing happen, and have no recourse.
//
// So the distinction is an opt-in at the call site, not a heuristic: the chrome
// actors call `useChromeRefresh`, PullToRefresh keeps calling `router.refresh()`
// itself. This spec proves that from the outside — with a record form genuinely
// dirty, the pull still refreshes, and the registry never even hears about it
// (`data-owed` stays 0, so nothing was queued and silently swallowed).
//
// The two emulation seams (standalone display-mode, and counting refreshes at
// all) are the ones e2e/pull-to-refresh.mobile.spec.ts documents; this reuses
// them. Read-only: it types into a form and never submits.

const INDICATOR = "pull-to-refresh";

async function emulateStandalone(page: Page) {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => {
      if (query !== "(display-mode: standalone)") return real(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
  });
}

async function pullDown(page: Page, distance: number) {
  await page.evaluate((dy) => {
    const startY = 200;
    const touch = (y: number) =>
      new Touch({
        identifier: 1,
        target: document.body,
        clientX: 195,
        clientY: y,
      });
    const fire = (type: string, y: number, ending = false) =>
      window.dispatchEvent(
        new TouchEvent(type, {
          touches: ending ? [] : [touch(y)],
          targetTouches: ending ? [] : [touch(y)],
          changedTouches: [touch(y)],
          bubbles: true,
          cancelable: true,
        })
      );
    fire("touchstart", startY);
    for (const step of [0.3, 0.6, 1]) fire("touchmove", startY + dy * step);
    fire("touchend", startY + dy, true);
  }, distance);
}

test("a pull-to-refresh still refreshes while a record form holds unsaved input", async ({
  browser,
}) => {
  test.slow();
  const context = await browser.newContext({
    // A raw context does not inherit the `mobile` project's `use` block.
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    storageState: workerAuthPath(),
  });
  const page = await context.newPage();
  await emulateStandalone(page);
  try {
    await page.goto("/records/history/visits");
    await expect(page.getByTestId("visits-upcoming")).toBeVisible();

    const indicator = page.getByTestId(INDICATOR);
    const registry = page.getByTestId("dirty-form-registry");
    await expect(indicator).toHaveAttribute("data-refreshes", "0");
    await expect(registry).toHaveAttribute("data-dirty", "0");

    // Make the form genuinely dirty — the exact state that defers a CHROME
    // refresh.
    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    const title = dialog.getByLabel("Reason / title");
    await expect(title).toBeVisible();
    await title.fill("E2E pull-through-dirty visit");
    await expect(registry).toHaveAttribute("data-dirty", "1");

    // The user asks for current data anyway.
    await pullDown(page, 200);

    // It happened. Counting the calls is what makes this a fact rather than an
    // absence of symptoms.
    await expect(indicator).toHaveAttribute("data-refreshes", "1");
    // And it never entered the registry: nothing was owed, so nothing was
    // queued-and-swallowed on the way.
    await expect(registry).toHaveAttribute("data-owed", "0");
    await expect(registry).toHaveAttribute("data-refreshes", "0");
  } finally {
    await context.close();
  }
});

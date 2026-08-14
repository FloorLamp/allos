import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { hydratedClick, touchSwipeFrom } from "./helpers";
import { workerAuthPath } from "./worker-env";
// Standalone-PWA pull-to-refresh (issue #1428, section B).
//
// Installed to the home screen there is no URL bar and so no refresh control: a
// page gone stale (another device logged a dose) has no recovery gesture at all.
// This pins the three things that make the gesture correct rather than merely
// present — it only exists in standalone, a real pull refreshes, and a mid-page
// pull does NOT (which is the difference between a refresh gesture and a page
// that reloads whenever you scroll up hard).
//
// Two seams, both deliberate:
//
//   * `display-mode: standalone` has no Playwright emulation (emulateMedia
//     covers media/colorScheme/reducedMotion/forcedColors/contrast only), so the
//     installed context is emulated by patching that ONE media query in an init
//     script and delegating every other query to the real implementation — the
//     reduced-motion branch must keep answering honestly.
//   * "did router.refresh() run" is invisible from outside, so the indicator
//     carries `data-refreshes` — a count of exactly the calls. Asserting a count
//     is what lets the negative case ("a mid-page pull triggers nothing") be
//     stated as a fact instead of an absence of symptoms.
//
// Writes nothing; read-only over the shared seed at any parallelism.

const INDICATOR = "pull-to-refresh";

// Emulate an installed (standalone) launch for this context.
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

// Drag a finger down `distance` px from the current scroll position. Dispatched
// as real TouchEvents rather than through page.touchscreen (which only taps), so
// the gesture is deterministic — no timing and no animation to race.
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
    // A few intermediate samples, the way a real drag arrives.
    for (const step of [0.3, 0.6, 1]) fire("touchmove", startY + dy * step);
    fire("touchend", startY + dy, true);
  }, distance);
}

test("a pull at the top of a standalone page refreshes; a mid-page pull does not", async ({
  browser,
}) => {
  const context = await browser.newContext({
    // A raw context does NOT inherit the `mobile` project's `use` block, so the
    // phone viewport + touch have to be restated (dashboard-now.mobile.spec.ts's
    // gotcha) — a touch gesture spec at 1280×720 would be meaningless.
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    storageState: workerAuthPath(),
  });
  const page = await context.newPage();
  await emulateStandalone(page);
  try {
    // The Timeline is the app's tallest read-only surface on the shared seed, so
    // there is guaranteed scroll range to have a "mid-page" at all.
    await page.goto("/timeline");

    const indicator = page.getByTestId(INDICATOR);
    // It mounts at all only because this context reports standalone.
    await expect(indicator).toHaveAttribute("data-refreshes", "0");

    // A real pull from the top: past the arming threshold (the classifier halves
    // finger travel, so 200px of drag is comfortably armed).
    await pullDown(page, 200);
    await expect(indicator).toHaveAttribute("data-refreshes", "1");

    // THE negative case. Scroll into the page and pull exactly as hard: this is
    // ordinary scrolling, and it must trigger nothing.
    const depth = await page.evaluate(() => {
      window.scrollTo(0, 1200);
      return window.scrollY;
    });
    expect(
      depth,
      "the Timeline should be scrollable at phone width"
    ).toBeGreaterThan(400);
    await pullDown(page, 200);
    // Still one — the count is what makes "nothing happened" assertable.
    await expect(indicator).toHaveAttribute("data-refreshes", "1");

    // A too-short pull back at the top is a snap-back, not a refresh.
    await page.evaluate(() => window.scrollTo(0, 0));
    await pullDown(page, 30);
    await expect(indicator).toHaveAttribute("data-refreshes", "1");
  } finally {
    await context.close();
  }
});

test("dragging a bottom sheet closed is not a pull, and refreshes nothing", async ({
  browser,
}) => {
  // #2725's second defect. The listeners are on the WINDOW, so they see touches
  // inside overlays too — and a sheet's drag-dismiss passed every test the
  // classifier had: downward, from a page sitting at its top, far past the
  // arming distance. Installed, that meant a whole-page `router.refresh()` at
  // the exact moment the sheet was closing, plus the PTR spinner (`z-90`)
  // surfacing over the sheet (`z-60`) during a gesture that was never a pull.
  //
  // The existing test above proves a mid-page pull does nothing; this proves an
  // overlay gesture does nothing, which is a different clause of the classifier
  // and was the one that did not exist. Real Chromium touch input (not the
  // synthesised events `pullDown` uses), because the sheet has to actually drag.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    storageState: workerAuthPath(),
  });
  const page = await context.newPage();
  await emulateStandalone(page);
  try {
    await page.goto("/");
    await expect(page.getByTestId("shell-chrome")).toHaveAttribute(
      "data-ready",
      "true"
    );
    const indicator = page.getByTestId(INDICATOR);
    await expect(indicator).toHaveAttribute("data-refreshes", "0");

    const sheet = page.getByTestId("quick-log-sheet");
    await hydratedClick(page, page.getByTestId("quick-log-more"));
    await expect(sheet).toBeVisible();

    await touchSwipeFrom(page, sheet.getByTestId("sheet-drag-handle"), {
      dy: 240,
    });
    // The gesture did what it was for…
    await expect(sheet).toHaveCount(0);
    // …and nothing else. The count is what makes that statable: the refresh is
    // counted synchronously on touchend, and the sheet's exit has since run to
    // completion, so a fired refresh would already be visible here.
    await expect(indicator).toHaveAttribute("data-refreshes", "0");
  } finally {
    await context.close();
  }
});

test("in a browser tab there is no pull-to-refresh at all", async ({
  page,
}) => {
  // The browser already has a refresh control, and Chrome-Android has its own
  // native overscroll refresh — a second one here would fight it. So the whole
  // affordance is absent, not merely inert.
  await page.goto("/timeline");
  // Settle on the rendered shell first, so the absence below is a fact about a
  // loaded page rather than about a page that hadn't painted yet.
  await expect(page.getByTestId("shell-chrome")).toBeVisible();
  await expect(page.getByTestId(INDICATOR)).toHaveCount(0);
});

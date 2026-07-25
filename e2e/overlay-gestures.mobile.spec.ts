import { expect, test, type Page } from "@playwright/test";
import { centerOf, hydratedClick, touchSwipe } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_PRESENCE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Overlay gestures (issues #1425, #1469).
//
// One recognizer, one visual language, three outcomes. The point of these tests
// is the DIVERGENCE: the identical swipe-down resolves to DISCARD on a bottom
// sheet and to MINIMIZE on the activity dock, because the dock is a session — a
// live workout that "away" must never silently end (the #1428 decision rule).
// A regression that unified those outcomes would look like a cleanup and would
// lose people's workouts, so it is asserted directly.
//
// Every gesture here is driven through real Chromium touch input (`touchSwipe`
// in helpers.ts). That matters: the recognizer relies on the browser's own
// scroll arbitration — including the `pointercancel` it fires when it decides a
// drag is a scroll — and synthesised DOM events would bypass exactly that.

const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

// The shell chrome's scroll listener only exists after hydration, and it
// publishes that fact — which makes it the one deterministic "the client is
// live" gate on a phone page. Gestures are client-only, so a swipe before this
// is swallowed exactly like a pre-hydration tap, and unlike a tap a swipe can't
// simply be retried (a retried day-swipe would skip two days).
async function hydrated(page: Page): Promise<void> {
  await expect(page.getByTestId("shell-chrome")).toHaveAttribute(
    "data-ready",
    "true"
  );
}

async function openQuickLogSheet(page: Page) {
  const sheet = page.getByTestId("quick-log-sheet");
  await hydratedClick(page, page.getByTestId("quick-log-more"));
  await expect(sheet).toBeVisible();
  return sheet;
}

test.describe("bottom sheet: swipe down discards", () => {
  test("a decisive downward drag on the handle dismisses the sheet", async ({
    page,
  }) => {
    await page.goto("/");
    await hydrated(page);
    const sheet = await openQuickLogSheet(page);

    const grip = await centerOf(sheet.getByTestId("sheet-drag-handle"));
    await touchSwipe(page, grip, { x: grip.x, y: grip.y + 240 });

    // The sheet is transactional: dismissal means discard, and the panel is gone
    // from the tree (not merely hidden) once its exit finishes.
    await expect(sheet).toHaveCount(0);
  });

  test("a short, slow drag leaves the sheet open", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    const sheet = await openQuickLogSheet(page);

    const grip = await centerOf(sheet.getByTestId("sheet-drag-handle"));
    // 24px, deliberately slow: under the commit distance and far under a flick.
    // A gesture this cheap must never dismiss anything — the whole reason the
    // recognizer has a threshold at all.
    await touchSwipe(
      page,
      grip,
      { x: grip.x, y: grip.y + 24 },
      { stepDelayMs: 40 }
    );

    await expect(sheet).toBeVisible();
    // …and it settles back to rest rather than sitting 24px down where the
    // finger left it: the panel's bottom edge is the screen's bottom edge again.
    const panel = sheet.locator("[data-sheet-panel]");
    const viewportH = page.viewportSize()!.height;
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return box ? Math.round(box.y + box.height) : -1;
      })
      .toBe(viewportH);
  });

  test("an upward drag on the handle does nothing at all", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    const sheet = await openQuickLogSheet(page);

    const grip = await centerOf(sheet.getByTestId("sheet-drag-handle"));
    // Travel the wrong way is not negative travel, it is no travel: a
    // bottom-anchored sheet cannot be dragged up off its resting edge.
    await touchSwipe(page, grip, { x: grip.x, y: grip.y - 200 });

    await expect(sheet).toBeVisible();
  });
});

test.describe("nav drawer: edge-swipe opens, swipe-left closes", () => {
  test("swiping in from the left edge opens the drawer, and swiping it left closes it", async ({
    page,
  }) => {
    await page.goto("/");
    await hydrated(page);

    const drawer = page.getByTestId("mobile-drawer");
    await expect(drawer).toHaveCount(0);

    // From the very edge of the screen — the gesture a thumb arriving from
    // off-glass makes. Starting further in is a page gesture and must not open it.
    await touchSwipe(page, { x: 2, y: 500 }, { x: 220, y: 505 });
    await expect(drawer).toBeVisible();

    const grip = await centerOf(drawer);
    await touchSwipe(page, grip, { x: grip.x - 260, y: grip.y });
    await expect(drawer).toHaveCount(0);
  });

  test("a swipe that starts mid-screen never opens the drawer", async ({
    page,
  }) => {
    await page.goto("/");
    await hydrated(page);

    await touchSwipe(page, { x: 250, y: 500 }, { x: 380, y: 500 });
    await expect(page.getByTestId("mobile-drawer")).toHaveCount(0);
  });
});

test.describe("the activity dock: the same swipe MINIMIZES", () => {
  // The dock's fixture is a login with a seeded in-progress workout. Nothing
  // here writes: the session row is left exactly as found, so this spec and the
  // desktop presence spec can share the fixture without racing.
  test("swipe-down on a live workout minimizes it — and never discards it", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_PRESENCE, password: E2E_MEMBER_PASSWORD },
      PHONE_CONTEXT
    );
    try {
      await page.goto("/");
      const dock = page.getByTestId("workout-dock");
      await expect(dock).toBeVisible();

      await hydratedClick(page, page.getByTestId("workout-dock-open"));
      const panel = page.getByTestId("activity-overlay-panel");
      await expect(panel).toBeVisible();

      const grip = await centerOf(page.getByTestId("workout-drag-handle"));
      await touchSwipe(page, grip, { x: grip.x, y: grip.y + 240 });

      // THE DIVERGENCE. The identical gesture that discards a sheet collapses
      // this to the bar — the workout is still running, and the bar is proof.
      await expect(dock).toBeVisible();
      await expect(page.getByTestId("minimize-workout")).toBeHidden();

      // Re-opening proves both halves of the "parked, not destroyed" contract:
      // the same panel comes back (the form was never unmounted, so the rest
      // timer never stopped), and it comes back AT REST rather than still
      // translated off the bottom by the drag that minimized it.
      await page.getByTestId("workout-dock-open").click();
      await expect(panel).toBeVisible();
      const box = await panel.boundingBox();
      expect(
        box!.y,
        "a re-opened dock must sit at its resting position, not where the drag left it"
      ).toBeLessThan(page.viewportSize()!.height / 2);
    } finally {
      await page.context().close();
    }
  });

  test("the sheet and the dock offer the SAME affordance for their different outcomes", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_PRESENCE, password: E2E_MEMBER_PASSWORD },
      PHONE_CONTEXT
    );
    try {
      await page.goto("/");
      await hydrated(page);

      // Measured in ONE browser context so the comparison is real rather than a
      // restatement of the token constant.
      const sheet = await openQuickLogSheet(page);
      const sheetBar = await sheet
        .getByTestId("sheet-drag-handle")
        .locator("span")
        .boundingBox();
      const sheetScrim = await page
        .getByTestId("quick-log-sheet-backdrop")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);

      await hydratedClick(page, page.getByTestId("workout-dock-open"));
      await expect(page.getByTestId("activity-overlay-panel")).toBeVisible();
      const dockBar = await page
        .getByTestId("workout-drag-handle")
        .locator("span")
        .boundingBox();

      // One drag-handle geometry (#1469): the two surfaces are different
      // lifecycles wearing the same affordance, which is what makes the gesture
      // learnable in one place and usable in the other.
      expect(dockBar!.width).toBeCloseTo(sheetBar!.width, 0);
      expect(dockBar!.height).toBeCloseTo(sheetBar!.height, 0);

      // …and one scrim treatment. The drawer's backdrop used to be a different
      // tint with an extra blur, so the same dimming read as two depths.
      await page.getByTestId("minimize-workout").click();
      await touchSwipe(page, { x: 2, y: 500 }, { x: 220, y: 505 });
      const drawerScrim = await page
        .getByTestId("mobile-drawer-backdrop")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(drawerScrim).toBe(sheetScrim);
    } finally {
      await page.context().close();
    }
  });
});

test.describe("reduced motion", () => {
  // PW exposes the emulation through contextOptions (there is no top-level
  // `reducedMotion` test option), so this is the shape that reaches the browser.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("every gesture still resolves — the surfaces simply snap", async ({
    page,
  }) => {
    // The preference asks for no TRAVEL, not for a missing interaction. Under
    // reduce, nothing follows the finger and no keyframe is scheduled, but the
    // same swipes reach the same outcomes (#794 8d / #1416 F).
    await page.goto("/");
    await hydrated(page);

    const sheet = await openQuickLogSheet(page);
    const grip = await centerOf(sheet.getByTestId("sheet-drag-handle"));
    await touchSwipe(page, grip, { x: grip.x, y: grip.y + 240 });
    await expect(sheet).toHaveCount(0);

    const drawer = page.getByTestId("mobile-drawer");
    await touchSwipe(page, { x: 2, y: 500 }, { x: 220, y: 505 });
    await expect(drawer).toBeVisible();
    const drawerGrip = await centerOf(drawer);
    await touchSwipe(page, drawerGrip, {
      x: drawerGrip.x - 260,
      y: drawerGrip.y,
    });
    await expect(drawer).toHaveCount(0);
  });
});

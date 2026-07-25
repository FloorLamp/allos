import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { openMobileDrawer, settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_MULTI,
  E2E_LOGIN_SHELL,
  MULTI_SHARED_PROFILE,
  SHELL_WEIGHT_KG,
} from "./fixture-logins";

// The mobile shell pass (issue #1416) — the phone chrome itself, which the
// desktop projects structurally cannot see. Runs in the `mobile` Playwright
// project (390×844, hasTouch) by its `*.mobile.spec.ts` name.
//
// What is pinned here, and why each one is a real regression class:
//   B. The sticky chrome hides on scroll-down and returns on scroll-up. A
//      transform-based hide is invisible to a "toBeVisible" assertion (a
//      translated element is still visible), so the position is asserted by
//      BOUNDING BOX as well as by the state attribute.
//   C. The multi-profile view banner lives INSIDE that sticky chrome. That
//      containment IS the fix — before it, the banner sat in the content flow and
//      scrolled away, which is exactly when you most need to know whose data you
//      are reading.
//   B/E. Search is one tap, and the "+" names the CURRENT page's log.
//   E. The quick-log sheet opens, reaches a REAL existing form, and closes.
//   F. Reduced motion: the same open/close STATES, no travel.
//
// Fixture hygiene (#868): everything except the one write is read-only over the
// shared seed with no counts. The single write (a body weight through the sheet)
// runs as a DEDICATED login in its own cookie context and is asserted by value,
// so --repeat-each and re-runs never contend.

const CHROME = "shell-chrome";

// `loginAs` builds its own browser context (that is the point — a cookie-less
// session that can't disturb the shared admin storageState), and a raw context
// does NOT inherit the `mobile` project's `use` block. So a test that logs in as a
// fixture has to restate the phone viewport, or it would silently run at the
// default 1280×720 and assert the mobile shell on a surface that doesn't render
// it. Mirrors playwright.config.ts's `mobile` project.
const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

// Resolve a seeded fixture profile's id by name. Short-lived connection with a
// busy timeout so it never contends with the running server on the WAL DB (the
// multi-view spec's pattern).
function fixtureProfileId(name: string): number {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
        id: number;
      }
    ).id;
  } finally {
    db.close();
  }
}

// Scroll the window and read back the offset actually reached, so an assertion
// can say "the page was scrollable" out loud rather than passing vacuously on a
// short page. The rAF-coalesced listener then settles under the retrying
// `expect` that follows.
async function scrollTo(page: Page, y: number): Promise<number> {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  return page.evaluate(() => window.scrollY);
}

// The chrome's scroll listener only exists after hydration (see
// components/useShellChrome.ts). Scrolling before that is genuinely not seen —
// by the browser as much as by the test — so every scroll assertion waits for
// the listener to be attached first. This is the deterministic replacement for
// a re-scroll retry loop: there IS an awaitable signal, so use it.
async function chromeReady(page: Page) {
  const chrome = page.getByTestId(CHROME);
  await expect(chrome).toHaveAttribute("data-ready", "true");
  return chrome;
}

test.describe("auto-hiding top chrome (#1416 B)", () => {
  test("hides on scroll-down and returns on scroll-up", async ({ page }) => {
    // The Timeline is the app's tallest read-only surface on the shared seed
    // (~3 weeks of day sections), so there is real scroll range at 390px wide.
    await page.goto("/timeline");
    const chrome = await chromeReady(page);
    await expect(chrome).toHaveAttribute("data-hidden", "false");

    // It is genuinely sticky on a phone — the whole premise of B and C.
    await expect
      .poll(() =>
        page.getByTestId(CHROME).evaluate((el) => getComputedStyle(el).position)
      )
      .toBe("sticky");

    const deep = await scrollTo(page, 1400);
    expect(
      deep,
      "the Timeline should be scrollable at phone width"
    ).toBeGreaterThan(400);
    await expect(chrome).toHaveAttribute("data-hidden", "true");

    // Transform-based: the element still "exists" and is still `visible` to the
    // DOM, but it has travelled off the top of the viewport.
    await expect
      .poll(async () => (await chrome.boundingBox())?.y ?? 0)
      .toBeLessThan(0);

    // Any upward scroll brings it straight back, still deep in the page.
    await scrollTo(page, deep - 300);
    await expect(chrome).toHaveAttribute("data-hidden", "false");
    await expect
      .poll(async () => (await chrome.boundingBox())?.y ?? -1)
      .toBe(0);

    // And returning to the top leaves it showing.
    await scrollTo(page, 0);
    await expect(chrome).toHaveAttribute("data-hidden", "false");
  });

  test("keeps the hamburger reachable after a hide/reveal cycle", async ({
    page,
  }) => {
    await page.goto("/timeline");
    await chromeReady(page);
    await scrollTo(page, 1400);
    await expect(page.getByTestId(CHROME)).toHaveAttribute(
      "data-hidden",
      "true"
    );
    await scrollTo(page, 1100);

    // The drawer still opens from the revealed bar — the hide is presentation
    // only, never an unmount, so nothing about navigation depends on scroll.
    const drawer = await openMobileDrawer(page);
    await expect(
      drawer.getByRole("link", { name: "Timeline", exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });
});

test("the multi-profile view banner rides in the sticky chrome (#1416 C)", async ({
  browser,
}) => {
  // Read-only over the multi-view fixture, in its OWN cookie context: the view-set
  // lives on the SESSION (sessions.view_profile_ids), so toggling it here cannot
  // touch the shared admin storageState or another spec's session.
  const sharedId = fixtureProfileId(MULTI_SHARED_PROFILE);
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_MULTI, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  try {
    await page.goto("/upcoming");
    // Single-view default: no banner at all (zero chrome change for the common case).
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);

    // Toggle the second profile into view. On a phone the profile menu lives in
    // the drawer (the shared SidebarContent), so this is also a small proof that
    // the animated drawer still reaches the same controls the desktop sidebar does.
    const drawer = await openMobileDrawer(page);
    const trigger = drawer.getByTestId("user-menu-trigger");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    // Scope to the drawer: the (hidden) desktop sidebar renders the same popover
    // markup at every viewport, so an unscoped testid is two elements.
    await expect(drawer.getByTestId("user-menu-popover")).toBeVisible();
    await settledClick(page, drawer.getByTestId(`view-toggle-${sharedId}`));
    // Close the drawer so the banner underneath is the thing being asserted.
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    // THE assertion: the banner is a descendant of the sticky chrome, not of the
    // scrolling content container. One strip in the DOM — never a hidden md:*
    // pair — so this holds on every viewport.
    const banner = page.getByTestId(CHROME).getByTestId("profile-view-strip");
    await expect(banner).toBeVisible();
    await expect(
      page
        .getByTestId("app-content-container")
        .getByTestId("profile-view-strip")
    ).toHaveCount(0);

    // It travels WITH the bar because it IS inside the bar's one transformed
    // element — that containment, asserted above, is the whole mechanism. The
    // hide/reveal behavior itself is pinned on /timeline (the tests above), where
    // there is guaranteed scroll range; re-driving it here on a fixture profile's
    // short page would only prove the scroll bar's height.
    await chromeReady(page);
    const chromeBox = await page.getByTestId(CHROME).boundingBox();
    const box = await banner.boundingBox();
    expect(chromeBox, "the chrome should be laid out").not.toBeNull();
    expect(box, "the banner should be laid out").not.toBeNull();
    // Pinned under the bar, above the fold, inside the sticky element's box.
    expect(box!.y).toBeGreaterThanOrEqual(chromeBox!.y);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      chromeBox!.y + chromeBox!.height + 1
    );
  } finally {
    await page.context().close();
  }
});

test.describe("fewer taps to common actions (#1416 B/E)", () => {
  test("search opens the command palette in ONE tap from the bar", async ({
    page,
  }) => {
    await page.goto("/");
    const input = page.getByRole("combobox", {
      name: "Search or run a command",
    });
    await expect(input).toHaveCount(0);

    // No drawer detour — the magnifier lives on the bar itself now.
    await expect(async () => {
      if (!(await input.isVisible())) {
        await page.getByTestId("search-mobile").click();
      }
      await expect(input).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the search icon past the pre-hydration swallow (#500) — a pure client toggle with no POST to settle on, and the visibility guard keeps a late tap from re-closing it
  });

  test("the + names the CURRENT page's log", async ({ page }) => {
    const primary = page.getByTestId("quick-log-primary");

    // Fallback everywhere with no opinion: the bar's historical behavior.
    await page.goto("/");
    await expect(primary).toHaveAttribute("data-quick-log-id", "log-activity");
    await expect(primary).toHaveAttribute("aria-label", "Log activity");
    // Where the primary IS the activity editor, its two companions show.
    await expect(page.getByTestId("start-workout-mobile")).toBeVisible();

    await page.goto("/nutrition");
    await expect(primary).toHaveAttribute("data-quick-log-id", "log-food");
    await expect(primary).toHaveAttribute("aria-label", "Log food");
    // …and there they are noise competing for a 390px bar, so they are dropped.
    await expect(page.getByTestId("start-workout-mobile")).toHaveCount(0);

    await page.goto("/medications");
    await expect(primary).toHaveAttribute("data-quick-log-id", "log-dose");

    // The Body TAB is the rule, not the /trends route.
    await page.goto("/trends?tab=body");
    await expect(primary).toHaveAttribute("data-quick-log-id", "log-weight");
  });

  test("the quick-log sheet opens, reaches a real form, and closes", async ({
    browser,
  }) => {
    // The ONE write: a dedicated login in its own context (#868).
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
      PHONE_CONTEXT
    );
    try {
      await page.goto("/");
      const sheet = page.getByTestId("quick-log-sheet");
      await expect(sheet).toHaveCount(0);

      await expect(async () => {
        if (!(await sheet.isVisible())) {
          await page.getByTestId("quick-log-more").click();
        }
        await expect(sheet).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the caret past the pre-hydration swallow (#500) — a pure client toggle, visibility-guarded so a late tap can't re-close it

      // It is a real dialog with the drag-handle affordance (#1425's seam), and
      // it lists every common log — including the ones this route did not promote.
      await expect(sheet.getByRole("dialog")).toHaveAttribute(
        "aria-modal",
        "true"
      );
      await expect(sheet.getByTestId("sheet-drag-handle")).toBeVisible();
      for (const id of ["log-activity", "log-food", "log-dose", "log-weight"]) {
        await expect(sheet.getByTestId(`quick-log-${id}`)).toBeVisible();
      }

      // Tapping a row closes the sheet and lands on the EXISTING form — no new
      // write path was invented for the sheet.
      await sheet.getByTestId("quick-log-log-weight").click();
      await expect(sheet).toHaveCount(0);
      await expect(page).toHaveURL(/\/trends\?tab=body&new=weight/);

      // …and that form still saves, end to end.
      await page.locator("#bm-weight").fill(SHELL_WEIGHT_KG);
      await settledClick(
        page,
        page.getByRole("button", { name: "Save entry" })
      );
      await expect(page.getByText("Entry saved")).toBeVisible();
      // Assert the stored row by TEXT rather than visibility: the history table
      // lives in a horizontally-scrolling container at phone width, so a cell can
      // be laid out and still not be on screen.
      await expect(page.getByTestId("body-history-table")).toContainText(
        SHELL_WEIGHT_KG
      );
    } finally {
      await page.context().close();
    }
  });

  test("Escape and the backdrop both dismiss the sheet", async ({ page }) => {
    await page.goto("/");
    const sheet = page.getByTestId("quick-log-sheet");
    await expect(async () => {
      if (!(await sheet.isVisible())) {
        await page.getByTestId("quick-log-more").click();
      }
      await expect(sheet).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the caret past the pre-hydration swallow (#500) — a pure client toggle, visibility-guarded

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    await page.getByTestId("quick-log-more").click();
    await expect(sheet).toBeVisible();
    await sheet.getByTestId("quick-log-sheet-backdrop").click();
    await expect(sheet).toHaveCount(0);
  });
});

test.describe("reduced motion (#1416 F)", () => {
  // PW 1.61 exposes the emulation through contextOptions (there is no top-level
  // `reducedMotion` test option), so this is the shape that reaches the browser.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("the drawer, the sheet and the chrome all still work — they just snap", async ({
    page,
  }) => {
    await page.goto("/timeline");
    await chromeReady(page);

    // The drawer reaches BOTH states with no animation scheduled: usePresence
    // collapses its exit duration to 0, so the unmount is immediate.
    const drawer = await openMobileDrawer(page);
    await expect(
      drawer.getByRole("link", { name: "Trends", exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    // The sheet too.
    const sheet = page.getByTestId("quick-log-sheet");
    await expect(async () => {
      if (!(await sheet.isVisible())) {
        await page.getByTestId("quick-log-more").click();
      }
      await expect(sheet).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the caret past the pre-hydration swallow (#500) — a pure client toggle, visibility-guarded
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // And the chrome still hides/reveals — the preference asks for no TRAVEL, not
    // for a permanently parked bar.
    await scrollTo(page, 1400);
    await expect(page.getByTestId(CHROME)).toHaveAttribute(
      "data-hidden",
      "true"
    );
    await scrollTo(page, 1100);
    await expect(page.getByTestId(CHROME)).toHaveAttribute(
      "data-hidden",
      "false"
    );
  });
});

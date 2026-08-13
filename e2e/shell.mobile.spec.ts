import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { openMobileDrawer, settledClick, expectInView } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { loginAs, openCommandPalette } from "./nav";
import type { QuickLogId } from "@/lib/quick-log";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_MULTI,
  MULTI_SHARED_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

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
  const dbPath = workerDbPath();
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

test("the identity bar rides in the sticky chrome and opens the top drawer (#1416 C / #1801)", async ({
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
    // Single-view default: one avatar on the bar.
    await expectInView(page, 1, { mobile: true });

    // THE #1416 C assertion, inherited by the surface that replaced the view strip:
    // the thing that answers "whose data am I looking at?" is a descendant of the
    // STICKY chrome, not of the scrolling content container — so it stays on screen
    // mid-scroll instead of scrolling away with the page.
    const bar = page
      .getByTestId(CHROME)
      .getByTestId("profile-identity-bar-mobile");
    await expect(bar).toBeVisible();
    await expect(
      page
        .getByTestId("app-content-container")
        .getByTestId("profile-identity-bar-mobile")
    ).toHaveCount(0);
    await chromeReady(page);
    const chromeBox = await page.getByTestId(CHROME).boundingBox();
    const box = await bar.boundingBox();
    expect(chromeBox, "the chrome should be laid out").not.toBeNull();
    expect(box, "the bar should be laid out").not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(chromeBox!.y);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      chromeBox!.y + chromeBox!.height + 1
    );

    // Tapping the bar drops the TOP drawer — the switcher panel appears where the
    // finger already is, not at the far end of the screen. The drawer is portalled
    // to <body> (the chrome transforms itself on scroll), so scope the row lookup to
    // the panel: the hidden desktop expando carries the same row testids.
    await expect(bar).toBeEnabled();
    await bar.click();
    const panel = page.getByTestId("profile-switcher-panel-mobile");
    await expect(panel).toBeVisible();
    const panelBox = await panel.boundingBox();
    expect(panelBox, "the panel should be laid out").not.toBeNull();
    // Anchored to the TOP of the viewport, under the finger that opened it.
    expect(panelBox!.y).toBeLessThan(40);

    await settledClick(page, panel.getByTestId(`view-toggle-${sharedId}`));

    // The bar now stacks both profiles — the view-set round-trip, read off the ONE
    // surface that reports it.
    await expectInView(page, 2, { mobile: true });
    await expect(
      page
        .getByTestId("profile-identity-bar-mobile")
        .getByTestId(`identity-avatar-${sharedId}`)
    ).toBeVisible();
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
    // Where the primary IS the activity editor, its companion shows.
    await expect(page.getByTestId("start-workout-mobile")).toBeVisible();
    // …and it is the ONLY one since #1509: the ⟳ repeat-last button left the bar
    // (it was a fourth home for a shortcut the palette and the Training Log card's ⋯
    // menu already carry, spending a slot of a 390px bar).
    await expect(page.getByTestId("repeat-last-mobile")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Repeat last activity" })
    ).toHaveCount(0);

    await page.goto("/nutrition");
    await expect(primary).toHaveAttribute("data-quick-log-id", "log-food");
    await expect(primary).toHaveAttribute("aria-label", "Log food");
    // …and there it is noise competing for a 390px bar, so it is dropped.
    await expect(page.getByTestId("start-workout-mobile")).toHaveCount(0);

    await page.goto("/medications");
    await expect(primary).toHaveAttribute("data-quick-log-id", "log-dose");

    // Since #1644 the /trends ROUTE is the rule: the hub is one page and the Body
    // census (with its measurements form) is always on it.
    await page.goto("/trends");
    await expect(primary).toHaveAttribute(
      "data-quick-log-id",
      "log-measurements"
    );
  });

  test("repeat-last keeps its palette home after leaving the bar (#1509)", async ({
    page,
  }) => {
    // Dropping the bar button did not drop the SHORTCUT: it keeps exactly two
    // homes — the command palette (here, reachable on a phone too) and the
    // Training Log card's ⋯ "Log again" (pinned by entry-ergonomics.spec.ts). It was
    // deliberately NOT added to the quick-log sheet (#1506 keeps that list to
    // logging actions).
    await page.goto("/"); // the seed has plenty of logged activities
    const input = await openCommandPalette(page);
    await input.fill("repeat");
    await expect(page.getByText("Repeat last activity")).toBeVisible();
    // Read-only: close without executing so no draft is created.
    await page.keyboard.press("Escape");
  });

  test("the quick-log sheet opens, opens a real form IN PLACE, and closes", async ({
    page,
  }) => {
    // Read-only now: the sheet no longer NAVIGATES anywhere (#1468), so proving
    // it "reaches a real form" costs nothing but a mount. The end-to-end write
    // through that overlay — and its durability — lives in
    // quick-log-overlay.mobile.spec.ts, which owns the fixture that writes.
    await page.goto("/");
    await expect(page.getByTestId("quick-log-sheet")).toHaveCount(0);
    const sheet = await openLogSheet(page);

    // It is a real dialog with the drag-handle affordance (#1425's seam).
    await expect(sheet.getByRole("dialog")).toHaveAttribute(
      "aria-modal",
      "true"
    );
    await expect(sheet.getByTestId("sheet-drag-handle")).toBeVisible();

    // EVERY common log is still reachable from the sheet — and since #2651 that
    // is the honest wording, because it is no longer one list. The long tail is a
    // segmented domain track, so a log outside the segment the route opens on
    // costs ONE segment tap before its row exists at all. This loop pays that tap
    // per row (`showLogRow` asserts the segment reports itself selected), which
    // is precisely the extra cost the redesign introduced: reachability is
    // preserved, one-glance visibility of the whole menu is not.
    //
    // The rows themselves are the unchanged registry: the ones this route did not
    // promote, vitals (which joined in #1467 and merged into "Log measurements"
    // in #1486 — ONE measurements row since), and the two non-weight-scale
    // entries a phone also needs, a tracked wellness practice (#1633) and filing
    // a document (#1525).
    const ids: QuickLogId[] = [
      "log-activity",
      "log-food",
      "log-dose",
      "log-measurements",
      "log-practice",
      "add-document",
    ];
    for (const id of ids) {
      const row = await showLogRow(sheet, id);
      await expect(row).toBeVisible();
    }

    // Tapping a row closes the sheet and opens the EXISTING form right here —
    // no new write path, and no navigation (that is the #1468 rule).
    const before = page.url();
    const measurements = await showLogRow(sheet, "log-measurements");
    await measurements.click();
    await expect(sheet).toHaveCount(0);
    const overlay = page.getByTestId("quick-entry-sheet");
    await expect(overlay).toBeVisible();
    // The overlay's props come from a Server Action whose response carries a
    // re-render of the page behind it — on the seeded profile that is the heaviest
    // page in the app, and measurably over the default 5s budget on a loaded runner
    // (both before and after this issue's rows). A named ceiling, not a sleep: the
    // assertion still fails if the form never mounts.
    // The form mounted — which group it opens is the #2014 entry-point decision,
    // not what this test is about.
    await expect(overlay.getByTestId("measurements-quick-add")).toBeVisible({
      timeout: 20_000,
    });
    expect(page.url()).toBe(before);

    // And it is transactional: dismissing discards, which is safe here (the
    // activity editor deliberately stays a dock instead, #1428).
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    expect(page.url()).toBe(before);
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
    // Near the TOP of the scrim, not its centre: the scrim spans the viewport with
    // the panel stacked over its lower half, and with the context row and a
    // segment's rows above the fold the panel can reach past the midpoint — a
    // default centre-click would land on the panel and dismiss nothing. The
    // affordance under test is unchanged; where it is exposed is not.
    await sheet
      .getByTestId("quick-log-sheet-backdrop")
      .click({ position: { x: 20, y: 20 } });
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

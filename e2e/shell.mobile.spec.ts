import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  expectInView,
  expectPhoneTapTargets,
  openMobileDrawer,
  settledBoxes,
  settledClick,
} from "./helpers";
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
//      SINCE #4102 THIS IS A TAB-FIRST PAGE'S BEHAVIOUR. The chrome was built to
//      carry two things, the phone top bar and a route-registered tab strip; the
//      bar retired, so on a page that registers no strip the chrome is EMPTY and
//      has nothing to hide. The hide/reveal is therefore exercised on /records,
//      which registers one — the mechanism is unchanged, its only occupant moved.
//   C. The identity bar is at the top of the MORE DRAWER, not in the chrome. It
//      rode the top bar until #4102 retired that bar; the question it answers is
//      the same one, and the drawer is now the only place on a phone that answers
//      it. Pinned in e2e/profile-identity-bar.spec.ts, where the switcher lives.
//   B/E. Search is one tap FROM THE DOCK; the dock puck is the sole phone-chrome
//      log route.
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
    // A TAB-FIRST page, because the chrome only has an occupant on one (#4102).
    // /records registers a strip (components/tab-first-pages.ts) and its history
    // pane is long enough to scroll at 390px wide.
    await page.goto("/records/history");
    const chrome = await chromeReady(page);
    // The premise, asserted rather than assumed: this page really does put
    // something in the chrome. Without this the whole test would pass vacuously on
    // a tree where the strip stopped registering — an empty box hides just fine.
    await expect(page.getByTestId("shell-tab-strip")).toBeVisible();
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

  test("the strip parks BELOW a notch band rather than under it (#4282)", async ({
    page,
  }) => {
    // The shell paints no status-bar band any more (#4282: edge-to-edge, the dock
    // is the phone's one chrome), so a strip that says `top: 0` pins UNDER the
    // status bar. Headless Chromium reports a ZERO inset, so `--top-edge-inset`
    // (app/globals.css) is the seam a notch can be forged through — an `env()`
    // written inline at the call site could not be forged at all.
    const NOTCH = 44; // an iPhone-class status-bar inset, in CSS px
    await page.goto("/records/history");
    const chrome = await chromeReady(page);
    await expect(page.getByTestId("shell-tab-strip")).toBeVisible();

    // PINNED, and re-pinned after the forge: at the top of the page the strip's
    // natural offset under a forged notch is the same number as its parked one, so
    // the reading has to be taken deep in the page — and changing the token relays
    // the page, which can put the chrome into its hidden state, where a translated
    // strip reads as a large negative y rather than as the offset.
    const pin = async () => {
      // Settle at the top FIRST — the machine always reveals inside its top zone
      // (lib/shell-chrome), so this cannot settle on a hidden strip — and then walk
      // the hide/reveal ONE STATE AT A TIME. The listener is rAF-coalesced
      // (components/useShellChrome), so a down-scroll and an up-scroll issued
      // inside one frame are read as a single downward move and the strip ends
      // HIDDEN, which prints as a large negative y long after the pin looked
      // established. Waiting for `true` in between forces the frame boundary.
      await scrollTo(page, 0);
      await settledBoxes([chrome]);
      const deep = await scrollTo(page, 1400);
      expect(
        deep,
        "the Timeline should be scrollable at phone width"
      ).toBeGreaterThan(400);
      await expect(chrome).toHaveAttribute("data-hidden", "true");
      await scrollTo(page, deep - 300);
      await expect(chrome).toHaveAttribute("data-hidden", "false");
    };
    // Control and assertion through the SAME read: flush with no notch, below the
    // band with one.
    const parkedY = async () => (await chrome.boundingBox())?.y ?? -1;
    await pin();
    await expect.poll(parkedY).toBe(0);
    await page.evaluate(
      (px) =>
        document.documentElement.style.setProperty(
          "--top-edge-inset",
          `${px}px`
        ),
      NOTCH
    );
    await pin();
    await expect.poll(parkedY).toBe(NOTCH);
  });

  test("keeps dock More reachable after a top-chrome hide/reveal cycle", async ({
    page,
  }) => {
    await page.goto("/history");
    await chromeReady(page);
    await scrollTo(page, 1400);
    await expect(page.getByTestId(CHROME)).toHaveAttribute(
      "data-hidden",
      "true"
    );
    await scrollTo(page, 1100);

    // The drawer still opens from the fixed dock; top-chrome motion never owns
    // navigation reachability after #2746.
    const drawer = await openMobileDrawer(page);
    const close = drawer.getByRole("button", { name: "Close menu" });
    await expect(close).toHaveAttribute("data-icon-button", "");
    await expectPhoneTapTargets(page, "mobile drawer close", [close]);
    // A TOP-LEVEL row (#4965 moved Trends into the collapsed "Plan & review"
    // group). What this case claims is that the drawer opens and its navigation is
    // reachable — an assertion about the drawer, not about the nav registry.
    await expect(
      drawer.getByRole("link", { name: "History", exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });
});

// #1416 C, RE-POINTED (#4102). The promise was that "whose data am I looking at?"
// stays answerable without hunting — originally by living inside the sticky chrome
// so it could not scroll away. The top bar retired, so the bar lives at the top of
// the More drawer and the promise is kept differently: one tap on a dock slot that
// is fixed to the bottom edge and never scrolls at all.
//
// What is asserted HERE is the part this file owns — that nothing identity-shaped
// is left in the scrolling content, and that the view-set round-trips through the
// drawer's bar. The switcher's own behaviour is e2e/profile-identity-bar.spec.ts's.
test("the identity bar answers from the drawer, never from the scrolling content (#1416 C / #1801 / #4102)", async ({
  browser,
}) => {
  const sharedId = fixtureProfileId(MULTI_SHARED_PROFILE);
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_MULTI, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  try {
    await page.goto("/upcoming");

    // Not in the chrome, and — the half that would be a real regression — not in
    // the content container either, where it would scroll away.
    await expect(
      page.getByTestId(CHROME).getByTestId("profile-identity-bar")
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId("app-content-container")
        .getByTestId("profile-identity-bar")
    ).toHaveCount(0);
    // And the retired phone-shaped mount is gone outright.
    await expect(page.getByTestId("profile-identity-bar-mobile")).toHaveCount(
      0
    );

    const drawer = await openMobileDrawer(page);
    const bar = drawer.getByTestId("profile-identity-bar");
    await expect(bar).toBeVisible();
    // Single-view default: one avatar on the bar.
    await expectInView(page, 1, { within: drawer });

    await expect(bar).toBeEnabled();
    await bar.click();
    const panel = drawer.getByTestId("profile-switcher-panel");
    await expect(panel).toBeVisible();

    const viewToggle = panel.getByTestId(`view-toggle-${sharedId}`);
    await expect(viewToggle).toHaveAttribute("data-icon-button", "");
    await expectPhoneTapTargets(page, "profile view toggle", [viewToggle]);
    await settledClick(page, viewToggle);

    // The view-set round-trip, read off the ONE surface that reports it.
    const reopened = await openMobileDrawer(page);
    await expectInView(page, 2, { within: reopened });
    await expect(
      reopened
        .getByTestId("profile-identity-bar")
        .getByTestId(`identity-avatar-${sharedId}`)
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test.describe("fewer taps to common actions (#1416 B/E)", () => {
  test("search opens the command palette in ONE tap from the dock", async ({
    page,
  }) => {
    await page.goto("/");
    const input = page.getByRole("combobox", {
      name: "Search or run a command",
    });
    await expect(input).toHaveCount(0);

    // No drawer detour, and no top bar either: since #4102 the magnifier IS a dock
    // slot, so the one tap it always promised is now a tap at the bottom edge —
    // inside the thumb's range instead of at the far corner.
    await expect(async () => {
      if (!(await input.isVisible())) {
        await page.getByTestId("dock-slot-search").click();
      }
      await expect(input).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the dock's Search slot past the pre-hydration swallow (#500) — a pure client toggle with no POST to settle on, and the visibility guard keeps a late tap from re-closing it
  });

  test("the dock puck absorbs the bar's log cluster and keeps the workout offer", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("quick-log-primary")).toHaveCount(0);
    await expect(page.getByTestId("dock-log-puck")).toBeVisible();
    await expect(page.getByTestId("start-workout-mobile")).toHaveCount(0);
    await expect(page.getByTestId("dock-log-puck")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(
      0
    );

    const sheet = await openLogSheet(page);
    await expect(
      sheet.getByText("Log it right here — you'll stay on this page.")
    ).toHaveCount(0);
    const workout = await showLogRow(sheet, "live-workout");
    await expect(workout).toContainText("Start workout");
    await expect(workout).toHaveAttribute("data-workout-offer", "start");

    // Repeat-last keeps exactly its palette and Training Log menu homes; it did
    // not move into the sheet with the live-workout lifecycle.
    await expect(page.getByTestId("repeat-last-mobile")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Repeat last activity" })
    ).toHaveCount(0);
  });

  test("repeat-last keeps its palette home after leaving the bar (#1509)", async ({
    page,
  }) => {
    // Dropping the bar button did not drop the SHORTCUT: it keeps exactly two
    // homes — the command palette (here, reachable on a phone too) and the
    // Activity record's ⋯ "Duplicate activity" (pinned by entry-ergonomics.spec.ts). It was
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
        await page.getByTestId("dock-log-puck").click();
      }
      await expect(sheet).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the puck past the pre-hydration swallow (#500) — a pure client toggle, visibility-guarded

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    await page.getByTestId("dock-log-puck").click();
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

// ── THE DRAWER IS A MODAL, AND SAYS SO (#3463) ───────────────────────────────
//
// The failure this pins was invisible to every spec in the suite, which is the
// reason it survived: the drawer opened, the links worked, and the only thing
// wrong was what it told a keyboard or a screen reader — nothing. It portals to
// <body>, covers the viewport, scrim-dims and SCROLL-LOCKS the page behind it, and
// carried no `role`, no `aria-modal` and no focus trap, so Tab walked straight out
// of it into content nobody could scroll to.
//
// WHAT IS ASSERTED, and why each part needs a browser:
//   * the declaration, through `getByRole` rather than by attribute alone — the
//     accessible NAME is a computation, and an `aria-label` that resolved to
//     nothing would still pass an attribute check.
//   * both TRAP BOUNDARIES, by identity. Shift+Tab from the opening stop must land
//     somewhere else inside the drawer, and one Tab from there must come BACK to
//     where it started. The return trip is what distinguishes a wrap from focus
//     that simply never moved — the shape a broken trap and a working one share.
//   * a forward sweep, because a boundary that holds says nothing about the stops
//     in between (the drawer holds a whole month calendar of day links).
//   * RESTORE, to the dock's More slot. A trap that strands focus on <body> after
//     closing has moved the problem rather than fixed it.
//   * and the two dismissals that already existed, re-asserted HERE because the
//     trap now answers Escape on the capture phase instead of this file's own
//     `document` listener. The edge-swipe retreat is unchanged and stays in
//     e2e/overlay-gestures.mobile.spec.ts, which owns the gesture.
test.describe("the nav drawer declares itself a modal (#3463)", () => {
  // Where focus actually is, named well enough for a failure to say so out loud.
  // `closest` rather than a bounding-box test: the drawer is portalled, so DOM
  // containment is the only honest reading of "focus is still in the drawer".
  const focusHere = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { inside: false, name: "nothing" };
      return {
        inside: el.closest('[data-testid="mobile-drawer"]') !== null,
        name:
          el.getAttribute("aria-label") ??
          el.textContent?.trim().slice(0, 40) ??
          el.tagName,
      };
    });

  test("declares role, name and aria-modal, and Tab cannot leave it", async ({
    page,
  }) => {
    await page.goto("/history");
    const drawer = await openMobileDrawer(page);

    await expect(drawer).toHaveAttribute("role", "dialog");
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    // The computed name, not the attribute: this is the assertion that fails if
    // the label is ever moved to an element that does not name the panel.
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();

    // The trap put focus INSIDE on open — without this every assertion below
    // would be about a page whose focus never entered the drawer at all.
    const opening = await focusHere(page);
    expect(opening.inside, `focus opened on ${opening.name}`).toBe(true);

    // BOUNDARY ONE: backwards off the first stop wraps to the last.
    await page.keyboard.press("Shift+Tab");
    const wrapped = await focusHere(page);
    expect(wrapped.inside, `Shift+Tab reached ${wrapped.name}`).toBe(true);
    expect(
      wrapped.name,
      "Shift+Tab from the drawer's first stop did not move focus at all, so the " +
        "wrap below would pass vacuously"
    ).not.toBe(opening.name);

    // BOUNDARY TWO: forwards off the last stop comes back to the first. Same key,
    // opposite end, and the round trip is the proof.
    await page.keyboard.press("Tab");
    const returned = await focusHere(page);
    expect(returned.inside, `Tab reached ${returned.name}`).toBe(true);
    expect(returned.name).toBe(opening.name);

    // AND THE STOPS IN BETWEEN. The drawer holds the whole sidebar plus a month of
    // day links, so this sweep does not claim to be exhaustive — it claims that no
    // ordinary run of tabbing walks out of a scroll-locked overlay, which is the
    // thing a person would actually do.
    const SWEEP = 40;
    for (let i = 0; i < SWEEP; i += 1) {
      await page.keyboard.press("Tab");
      const at = await focusHere(page);
      expect(
        at.inside,
        `Tab #${i + 1} reached ${at.name}, outside the drawer`
      ).toBe(true);
    }
  });

  test("Escape and the backdrop both dismiss it, and focus goes back to More", async ({
    page,
  }) => {
    await page.goto("/history");
    const drawer = await openMobileDrawer(page);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    // RESTORED, not merely released. The opener is the dock's More slot, which is
    // where a keyboard user was standing when the drawer took over.
    await expect(page.getByTestId("dock-slot-more")).toBeFocused();

    const reopened = await openMobileDrawer(page);
    // TO THE RIGHT OF THE PANEL, not at the scrim's own origin. The backdrop spans
    // the viewport and the drawer is stacked over its left ~320px, so a click at
    // (20, 20) lands on the drawer and dismisses nothing. The affordance under
    // test is unchanged; where it is exposed is not.
    await page
      .getByTestId("mobile-drawer-backdrop")
      .click({ position: { x: 360, y: 400 } });
    await expect(reopened).toHaveCount(0);
    await expect(page.getByTestId("dock-slot-more")).toBeFocused();
  });
});

test.describe("reduced motion (#1416 F)", () => {
  // PW 1.61 exposes the emulation through contextOptions (there is no top-level
  // `reducedMotion` test option), so this is the shape that reaches the browser.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("the drawer, the sheet and the chrome all still work — they just snap", async ({
    page,
  }) => {
    await page.goto("/history");
    await chromeReady(page);

    // The drawer reaches BOTH states with no animation scheduled: usePresence
    // collapses its exit duration to 0, so the unmount is immediate.
    const drawer = await openMobileDrawer(page);
    await expect(
      drawer.getByRole("link", { name: "History", exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    // The sheet too.
    const sheet = page.getByTestId("quick-log-sheet");
    await expect(async () => {
      if (!(await sheet.isVisible())) {
        await page.getByTestId("dock-log-puck").click();
      }
      await expect(sheet).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the puck past the pre-hydration swallow (#500) — a pure client toggle, visibility-guarded
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

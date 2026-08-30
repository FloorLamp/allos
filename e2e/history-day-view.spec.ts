import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledBoxes, settledClick } from "./helpers";
import { loginAs } from "./nav";
import { expandTimelineFilters } from "./timeline-chrome";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TL_CHROME,
  TL_CHROME_SICK_PROFILE,
  TL_CHROME_BUSY_DAY,
  TL_CHROME_SYMPTOM_DAY,
  TL_CHROME_QUIET_DAY,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The Timeline's mobile chrome budget (issue #1517).
//
// Three fixes, one surface:
//   A. the sticky/scroll priority is swapped — the day nav (used constantly) takes
//      the pinned slot and rides the shell chrome; the filter block (set once a
//      session) scrolls away;
//   B. the filter block collapses to ONE summary line below `sm`, expanding on tap;
//   C. the symptom logger arrives collapsed behind "+ Log symptom" unless logging is
//      the point of the visit (the day already has symptoms, or an illness-type
//      situation is active).
//
// Fixture (#868): a dedicated login over two dedicated profiles — see
// e2e/logins/history.ts for why the auto-expand's three states cannot share one
// profile. Deep-past days, navigation + client toggles only, no writes, so it is
// repeat-safe under --repeat-each.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

function dayUrl(date: string): string {
  return `/history?day=${date}`;
}

// The sick profile's id, so the spec can switch the session's active profile to it
// through the product's own affordance.
function sickProfileId(): number {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(TL_CHROME_SICK_PROFILE) as { id: number }
    ).id;
  } finally {
    db.close();
  }
}

async function signIn(browser: Parameters<typeof loginAs>[0]): Promise<Page> {
  return loginAs(
    browser,
    { username: E2E_LOGIN_TL_CHROME, password: E2E_MEMBER_PASSWORD },
    { viewport: PHONE, hasTouch: true }
  );
}

// The shell chrome's scroll listener only exists after hydration (see
// components/useShellChrome.ts), and the day nav rides the same machine — so every
// scroll assertion waits for the listener to be attached rather than racing it.
async function chromeReady(page: Page): Promise<void> {
  await expect(page.getByTestId("shell-chrome")).toHaveAttribute(
    "data-ready",
    "true"
  );
  await expect(page.getByTestId("timeline-day-nav")).toHaveAttribute(
    "data-ready",
    "true"
  );
}

async function scrollTo(page: Page, y: number): Promise<number> {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  return page.evaluate(() => window.scrollY);
}

test.describe("Timeline mobile chrome budget (#1517)", () => {
  test("the day nav takes the pinned slot and the filter block scrolls away (A)", async ({
    browser,
  }) => {
    test.slow(); // the Timeline is one of the app's heaviest server renders
    const page = await signIn(browser);
    try {
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));
      await chromeReady(page);

      const nav = page.getByTestId("timeline-day-nav");
      const filters = page.locator("#timeline-controls");
      await expect(nav).toBeVisible();

      // It is genuinely sticky on a phone — the premise of the swap.
      await expect
        .poll(() => nav.evaluate((el) => getComputedStyle(el).position))
        .toBe("sticky");
      // …and the filter block is NOT. It used to be the pinned one.
      await expect
        .poll(() => filters.evaluate((el) => getComputedStyle(el).position))
        .toBe("static");

      // Scroll deep into the day's events. The nav rides the shell chrome, so it
      // travels away with the top bar on the way DOWN (the #1485 F contract) …
      const deep = await scrollTo(page, 1200);
      expect(
        deep,
        "the busy day should be scrollable at phone width"
      ).toBeGreaterThan(400);
      await expect(nav).toHaveAttribute("data-hidden", "true");

      // … and comes straight back on any upward scroll, STILL deep in the page —
      // which is the whole fix: prev/next day is reachable mid-day, where before it
      // had scrolled off with the events.
      const stillDeep = await scrollTo(page, deep - 300);
      expect(stillDeep).toBeGreaterThan(400);
      await expect(nav).toHaveAttribute("data-hidden", "false");
      // ONE SETTLED SNAPSHOT, not two raw reads (#2437's family; measured here on
      // #3079's CI shard). `data-hidden` flips at the START of the chrome's
      // reveal, not the end, so a `boundingBox()` taken the instant the attribute
      // asserts catches the day nav MID-SLIDE. Measured on an idle box across five
      // trials, the immediate read was 57, 49.96, 51.61, 51.57 and 14.86 while the
      // SETTLED read was 57 every time; on a contended CI worker the same race
      // reported -12.54 and failed the budget below.
      //
      // The budget itself is untouched — widening -2 to swallow -12.54 would
      // retire the guarantee this case exists to hold ("pinned in the top band").
      // What changed is that the number being judged now comes from a layout that
      // actually held still. settledBoxes measures both elements in the same
      // settled snapshot, which is also what makes the two assertions below
      // describe ONE layout rather than two.
      const [navBox, filterBox] = await settledBoxes([nav, filters]);
      // -2 epsilon: sticky positioning can report a sub-pixel negative y
      // (-0.82 observed) while visually pinned at the top — the assertion is
      // "pinned in the top band", not "mathematically at 0".
      expect(navBox.y).toBeGreaterThan(-2);
      expect(navBox.y).toBeLessThan(160);
      await expect(page.getByTestId("timeline-day-prev")).toBeVisible();

      // The filter block, meanwhile, has scrolled off the top entirely.
      expect(filterBox.y + filterBox.height).toBeLessThan(0);
    } finally {
      await page.context().close();
    }
  });

  test("the filter block is one summary line that expands on tap (B)", async ({
    browser,
  }) => {
    test.slow();
    const page = await signIn(browser);
    try {
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));

      const bar = page.getByTestId("timeline-filters-bar");
      await expect(bar).toBeVisible();
      await expect(bar).toHaveAttribute("data-expanded", "false");
      // The summary names the active state: category, then the window.
      await expect(page.getByTestId("timeline-filters-label")).toContainText(
        "All"
      );
      // Collapsed means genuinely out of the tree, not merely visually hidden.
      await expect(page.getByTestId("timeline-filters-controls")).toBeHidden();

      await expandTimelineFilters(page);
      await expect(bar).toHaveAttribute("data-expanded", "true");
      await expect(page.getByTestId("timeline-filters-controls")).toBeVisible();
      await expect(page.getByTestId("custom-range-toggle")).toBeVisible();

      // …and it closes again: this is a toggle, not a one-way reveal.
      await hydratedClick(page, page.getByTestId("timeline-filters-toggle"));
      await expect(bar).toHaveAttribute("data-expanded", "false");
    } finally {
      await page.context().close();
    }
  });

  test("the symptom entry is collapsed on an ordinary day and open when it is the point of the visit (C)", async ({
    browser,
  }) => {
    test.slow();
    const sickId = sickProfileId();
    const page = await signIn(browser);
    try {
      // 1. A quiet day, no active situation → collapsed behind "+ Log symptom",
      //    with the bar itself out of the tab order.
      await page.goto(dayUrl(TL_CHROME_QUIET_DAY));
      const entry = page.getByTestId("timeline-symptom-entry");
      await expect(entry).toBeVisible();
      await expect(entry).toHaveAttribute("data-open", "false");
      await expect(page.getByTestId("timeline-symptom-toggle")).toContainText(
        "Log symptom"
      );
      await expect(page.getByTestId("symptom-log-bar")).toBeHidden();

      // …and one tap still gets you there.
      await hydratedClick(page, page.getByTestId("timeline-symptom-toggle"));
      await expect(entry).toHaveAttribute("data-open", "true");
      await expect(page.getByTestId("symptom-log-bar")).toBeVisible();

      // 2. A day that already carries symptoms → open on arrival (you are amending).
      await page.goto(dayUrl(TL_CHROME_SYMPTOM_DAY));
      await expect(page.getByTestId("timeline-symptom-entry")).toHaveAttribute(
        "data-open",
        "true"
      );
      await expect(page.getByTestId("symptom-log-bar")).toBeVisible();

      // 3. An ACTIVE illness situation → open on an ordinary quiet day too, so the
      //    sick-day flow #799 built the bar for stays one tap.
      //
      //    The switch is driven at DESKTOP width on purpose: below `md` the profile
      //    menu lives inside the nav drawer, and the (hidden) desktop sidebar
      //    renders the same markup at every viewport, so an unscoped trigger is two
      //    elements. Switching is a session-level Server Action — the viewport it
      //    was driven from is not part of what this test asserts.
      await page.setViewportSize(DESKTOP);
      await page.goto("/history");
      const trigger = page.getByTestId("profile-identity-bar");
      await expect(trigger).toBeEnabled();
      await trigger.click();
      await expect(page.getByTestId("profile-switcher-panel")).toBeVisible();
      await settledClick(page, page.getByTestId(`switch-to-${sickId}`));
      // Settle on the server-rendered result of the switch before navigating — a
      // goto over an in-flight action loses the write (#1437).
      await expect(trigger).toContainText(TL_CHROME_SICK_PROFILE);

      await page.setViewportSize(PHONE);
      await page.goto(dayUrl(TL_CHROME_QUIET_DAY));
      await expect(page.getByTestId("timeline-symptom-entry")).toHaveAttribute(
        "data-open",
        "true"
      );
    } finally {
      await page.context().close();
    }
  });

  test("desktop is unchanged: sticky filters, static day nav, no toggle", async ({
    browser,
  }) => {
    test.slow();
    const page = await signIn(browser);
    try {
      await page.setViewportSize(DESKTOP);
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));

      // The filter block is still the sticky one from `md` up, where viewport
      // height is not the scarce resource.
      await expect
        .poll(() =>
          page
            .locator("#timeline-controls")
            .evaluate((el) => getComputedStyle(el).position)
        )
        .toBe("sticky");
      await expect
        .poll(() =>
          page
            .getByTestId("timeline-day-nav")
            .evaluate((el) => getComputedStyle(el).position)
        )
        .toBe("static");

      // No collapse at all: the toggle isn't rendered and the controls are simply
      // there, in the layout they always had.
      await expect(page.getByTestId("timeline-filters-toggle")).toBeHidden();
      await expect(page.getByTestId("timeline-filters-controls")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});

// ── THE HEADER'S READ-ONCE SENTENCE (#3452 item 3) ───────────────────────────
//
// The Timeline's subtitle — "A chronological view of workouts, labs, documents,
// medications, visits, goals, and other health events." — is the longest page
// subtitle in the app, and #3403 made it cost a second line on a phone: letting
// the header reserve its action's width stopped "Year in review" wrapping and
// pushed the sentence over instead, running the header 73->165 instead of 73->145.
//
// The owner ruled it off the phone (2026-08-22) and named the cost: a first-time
// phone visitor loses the one-line explainer. `PageHeader`'s `hideSubtitleBelowSm`
// is the prop that does it, and until now NOTHING in the app passed it — so the
// only thing standing between this ruling and a silent revert is this guard
// (guards are mandatory, owner ruling 2026-08-21, docs/internals/design-system.md).
//
// BOTH HALVES, because half of the ruling is that desktop does not change. A guard
// that only checked the phone would go green on a subtitle deleted outright, which
// is a different decision than the one that was made.
test.describe("the Timeline subtitle is phone-only chrome (#3452)", () => {
  const SUBTITLE = /^A chronological view of workouts, labs/;

  test("hidden below `sm`, present on desktop", async ({ browser }) => {
    test.slow(); // the Timeline is one of the app's heaviest server renders
    const page = await signIn(browser);
    try {
      await page.goto(dayUrl(TL_CHROME_QUIET_DAY));

      // The page still NAMES itself on a phone — the title is what orients you, and
      // `compactBelowSm` (which takes the whole heading band) was not the ruling.
      await expect(
        page.getByRole("heading", { name: "Timeline", level: 1 })
      ).toBeVisible();
      // RENDERED BUT NOT SHOWN. `hideSubtitleBelowSm` is a `hidden sm:block`, so the
      // node is in the DOM and `toBeHidden` is the honest assertion; a `toHaveCount(0)`
      // here would pass against a subtitle that had simply been deleted.
      const subtitle = page.getByText(SUBTITLE);
      await expect(subtitle).toHaveCount(1);
      await expect(subtitle).toBeHidden();

      // …and it comes back the moment there is room for it. Same page, same node.
      await page.setViewportSize(DESKTOP);
      await expect(subtitle).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});

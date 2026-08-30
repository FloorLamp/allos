import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledBoxes, settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TL_CHROME,
  TL_CHROME_SICK_PROFILE,
  TL_CHROME_BUSY_DAY,
  TL_CHROME_SYMPTOM_DAY,
  TL_CHROME_QUIET_DAY,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The record day view's phone chrome (issue #1517), inherited from `/timeline` when
// #3958 phase 2 retired that route and `/history?day=` became the app's one "that
// day" anchor.
//
// Two of #1517's three fixes still have a subject here:
//   A. the sticky/scroll priority — the day nav (used constantly) takes the pinned
//      slot and rides the shell chrome, while the filter row scrolls away;
//   C. the symptom logger arrives collapsed behind "+ Log symptom" unless logging is
//      the point of the visit (the day already has symptoms, or an illness-type
//      situation is active).
//
// Fix B (collapsing the filter block) does not: the record has one filter row and no
// range chrome, so there is nothing to collapse. The note where its test stood says
// what asserts the budget instead.
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

test.describe("the record day view's phone chrome (#1517, inherited)", () => {
  test("the day nav takes the pinned slot and the filter row scrolls away (A)", async ({
    browser,
  }) => {
    test.slow(); // the record is one of the app's heaviest server renders
    const page = await signIn(browser);
    try {
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));
      await chromeReady(page);

      const nav = page.getByTestId("timeline-day-nav");
      const filters = page.getByTestId("history-filters");
      await expect(nav).toBeVisible();

      // It is genuinely sticky on a phone — the premise of the swap.
      await expect
        .poll(() => nav.evaluate((el) => getComputedStyle(el).position))
        .toBe("sticky");
      // …and the filter row is NOT. On `/timeline` the block was the pinned one.
      await expect
        .poll(() => filters.evaluate((el) => getComputedStyle(el).position))
        .toBe("static");

      // Scroll deep into the day's events. The nav rides the shell chrome, so it
      // travels away with the top bar on the way DOWN (the #1485 F contract) …
      //
      // MEASURED AGAINST THE PAGE, NOT AGAINST A CONSTANT. This scrolled to a flat
      // 1200 and required 400 to remain after backing off 300 — numbers taken from
      // `/timeline`, whose two-line event CARDS made the busy day roughly twice as
      // tall as the record's one-line rows. Measured here at 390px, the same day is
      // ~700px of scroll, so the old floor failed on a page that behaves correctly.
      // The claim was never about a pixel count: it is that an upward scroll brings
      // the nav back while the reader is STILL in the day's events rather than back
      // at its top. So the floor is the day's own scrollable height.
      const maxScroll = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight
      );
      expect(
        maxScroll,
        "the busy day should be scrollable at phone width"
      ).toBeGreaterThan(300);
      const deep = await scrollTo(page, maxScroll);
      await expect(nav).toHaveAttribute("data-hidden", "true");

      // … and comes straight back on any upward scroll, STILL deep in the page —
      // which is the whole fix: prev/next day is reachable mid-day, where before it
      // had scrolled off with the events. A THIRD of the way back up, so the reveal
      // is asserted somewhere that is unambiguously not the top.
      const stillDeep = await scrollTo(page, Math.round(deep * 0.66));
      expect(stillDeep).toBeGreaterThan(deep / 3);
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

      // The filter row, meanwhile, has scrolled off the top entirely.
      expect(filterBox.y + filterBox.height).toBeLessThan(0);
    } finally {
      await page.context().close();
    }
  });

  // FIX B HAS NO SUBJECT HERE, AND THAT IS THE POINT. `/timeline` met its chrome
  // budget by COLLAPSING a filter block that carried a category row, a date-range
  // card and a quick-range row. The record meets the same budget by not having them:
  // #3958 rules ONE filter row and NO range chrome at all, so there is no block to
  // collapse and no summary line to expand. Deleting the test rather than porting it
  // is the honest reading — a collapse guard over a surface with nothing to collapse
  // would be green for the wrong reason. The budget itself is asserted directly, in
  // e2e/history.spec.ts ("spends no more than the chrome budget above its first
  // record at 390px").

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
      const entry = page.getByTestId("history-symptom-entry");
      await expect(entry).toBeVisible();
      await expect(entry).toHaveAttribute("data-open", "false");
      await expect(page.getByTestId("history-symptom-toggle")).toContainText(
        "Log symptom"
      );
      await expect(page.getByTestId("symptom-log-bar")).toBeHidden();

      // …and one tap still gets you there.
      await hydratedClick(page, page.getByTestId("history-symptom-toggle"));
      await expect(entry).toHaveAttribute("data-open", "true");
      await expect(page.getByTestId("symptom-log-bar")).toBeVisible();

      // 2. A day that already carries symptoms → open on arrival (you are amending).
      await page.goto(dayUrl(TL_CHROME_SYMPTOM_DAY));
      await expect(page.getByTestId("history-symptom-entry")).toHaveAttribute(
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
      await expect(page.getByTestId("history-symptom-entry")).toHaveAttribute(
        "data-open",
        "true"
      );
    } finally {
      await page.context().close();
    }
  });

  test("desktop is unchanged: the day nav stops sticking, and nothing collapses", async ({
    browser,
  }) => {
    test.slow();
    const page = await signIn(browser);
    try {
      await page.setViewportSize(DESKTOP);
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));

      // The day nav drops to static from `sm` up — the pinned slot is a phone
      // affordance, bought because viewport height is scarce there and not here.
      await expect
        .poll(() =>
          page
            .getByTestId("timeline-day-nav")
            .evaluate((el) => getComputedStyle(el).position)
        )
        .toBe("static");

      // AND THE FILTER ROW IS STATIC AT BOTH WIDTHS, which is the half that changed:
      // `/timeline` made its filter block sticky from `md` up. The record's row is
      // one line, so pinning it would spend the budget it exists to protect. Asserted
      // beside the nav rather than alone — "nothing is sticky" passes on a page that
      // rendered no chrome at all, and the nav assertion above is what rules that out.
      await expect
        .poll(() =>
          page
            .getByTestId("history-filters")
            .evaluate((el) => getComputedStyle(el).position)
        )
        .toBe("static");
    } finally {
      await page.context().close();
    }
  });
});

// THE SUBTITLE TEST WENT WITH THE ROUTE (#3452 item 3). It guarded
// `hideSubtitleBelowSm` against a silent revert, and `/timeline`'s subtitle — the
// longest in the app — was the only thing in the tree that passed the prop. The
// record uses `compactBelowSm` instead and states its own rule in #3958 ("no
// h1/subtitle below `sm`"), which e2e/history.spec.ts's chrome-budget case measures
// directly rather than by naming a prop. The prop itself now has no call site; that
// is recorded on the PR as an open question rather than removed here.

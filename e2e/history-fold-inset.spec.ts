import { test, expect } from "./fixtures";
import type { Page, TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import { workerDbPath, frozenNow } from "./worker-env";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// /history's fold hierarchy renders inside-out, and every toggle repaints the whole
// feed (#4365) — two defects on top of #2657/#4045's fold system.
//
// 1. A NESTED month's revealed days now share the month card's own left inset
//    (`app/(app)/history/page.tsx`'s `daySection`), so the geometry states the
//    containment `data-fold-nested` already states for machines.
// 2. A fold or rollup tap now wraps its same-route `?open=`/`?expand=` navigation in
//    the browser's View Transition API (`useHistoryFoldNavigate`,
//    components/TimelineFilterLink.tsx) rather than letting the whole feed repaint
//    at once. State stays URL-carried throughout — this is a VISUAL change only.
//
// Fixture-OWNED (#868/#3106), following e2e/history-windowing.spec.ts's shape: a
// spec-private login + profile + goals, so no shared profile's history can push a
// planted day off the page or move which month a "closed" assertion lands on.

const DB_PATH = workerDbPath();
const RECENT_GOAL = "E2e Fold Inset Recent";
const CURRENT_OLD_GOAL = "E2e Fold Inset Current Old";
const LAST_YEAR_GOAL = "E2e Fold Inset Last Year";

function shiftedDay(days: number): string {
  const d = new Date(frozenNow());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// −7: inside the 14-day recent band in any timezone — keeps the record non-empty so
// windowTimelineDays does not auto-open the newest month (that rule only fires when
// the recent band is empty), which would otherwise make "closed" assertions below
// depend on which month happened to be newest.
const RECENT_DATE = shiftedDay(-7);
// −100: outside the recent band, inside the CURRENT calendar year — a TOP-LEVEL
// month fold, never nested. This is the "closed month's siblings align as today"
// control: the inset fix must not touch it.
const CURRENT_OLD_DATE = shiftedDay(-100);
const CURRENT_OLD_MONTH = CURRENT_OLD_DATE.slice(0, 7);
// −400: comfortably inside the PREVIOUS calendar year, nowhere near either of its
// boundaries (mirrors history-windowing.spec.ts's own LAST_YEAR_DATE) — a month
// nested one level under a year fold, which is the shape the issue is about.
const LAST_YEAR_DATE = shiftedDay(-400);
const LAST_YEAR_MONTH = LAST_YEAR_DATE.slice(0, 7);
const LAST_YEAR = LAST_YEAR_DATE.slice(0, 4);

const WIDE_PX = 1440;
const NARROW_DESKTOP_PX = 1024;

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

interface Fixture {
  username: string;
  loginId: number;
  profileId: number;
}

function createFixture(testInfo: TestInfo, purpose: string): Fixture {
  return withDb((db) => {
    const suffix = `${purpose}-${process.pid}-${testInfo.repeatEachIndex}`;
    const username = `e2e_foldinset_${suffix}`;
    let loginId = 0;
    let profileId = 0;
    db.transaction(() => {
      const passwordHash = (
        db
          .prepare("SELECT password_hash FROM logins WHERE username = ?")
          .get(E2E_LOGIN_DAILY) as { password_hash: string }
      ).password_hash;
      profileId = createFixtureProfile(db, `Fold Inset ${suffix}`);
      loginId = Number(
        db
          .prepare(
            "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
          )
          .run(username, passwordHash).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO login_profiles (login_id, profile_id, access)
         VALUES (?, ?, 'write')`
      ).run(loginId, profileId);
      const insert = db.prepare(
        `INSERT INTO goals (profile_id, title, target_date, status)
         VALUES (?, ?, ?, 'active')`
      );
      for (const [title, date] of [
        [RECENT_GOAL, RECENT_DATE],
        [CURRENT_OLD_GOAL, CURRENT_OLD_DATE],
        [LAST_YEAR_GOAL, LAST_YEAR_DATE],
      ] as const) {
        insert.run(profileId, title, date);
      }
    }).immediate();
    return { username, loginId, profileId };
  });
}

function destroyFixture(fixture: Fixture): void {
  withDb((db) => {
    db.transaction(() => {
      db.prepare("DELETE FROM sessions WHERE login_id = ?").run(
        fixture.loginId
      );
      db.prepare("DELETE FROM login_profiles WHERE login_id = ?").run(
        fixture.loginId
      );
      db.prepare("DELETE FROM login_settings WHERE login_id = ?").run(
        fixture.loginId
      );
      db.prepare("DELETE FROM logins WHERE id = ?").run(fixture.loginId);
      db.prepare("DELETE FROM goals WHERE profile_id = ?").run(
        fixture.profileId
      );
      destroyFixtureProfile(db, fixture.profileId);
    }).immediate();
  });
}

/** Left edges of the four elements the geometry claim is about, at whatever width
 *  the caller already set. */
async function insetEdges(page: Page): Promise<{
  nestedMonth: number;
  nestedDay: number;
  topMonth: number;
  topDay: number;
}> {
  return page.evaluate(
    ([nestedMonthSel, nestedDaySel, topMonthSel, topDaySel]) => {
      const left = (sel: string) =>
        Math.round(document.querySelector(sel)!.getBoundingClientRect().left);
      return {
        nestedMonth: left(nestedMonthSel),
        nestedDay: left(nestedDaySel),
        topMonth: left(topMonthSel),
        topDay: left(topDaySel),
      };
    },
    [
      // THE LINK, NOT THE SECTION — the same choice #4045 §2 makes for the right
      // edge, and for the same reason: `pl-4` is PADDING on the section itself, so
      // the section's OWN box never moves (padding displaces what is inside a box,
      // never the box's own edge). The bordered link is the content the padding
      // actually pushes, and the same is true of the day's row list below.
      `[data-testid="history-fold-${LAST_YEAR_MONTH}"] a`,
      `#timeline-day-${LAST_YEAR_DATE} [data-testid="history-rows"]`,
      `[data-testid="history-fold-${CURRENT_OLD_MONTH}"] a`,
      `#timeline-day-${CURRENT_OLD_DATE} [data-testid="history-rows"]`,
    ] as const
  );
}

test.describe("the fold hierarchy's inset and its toggle's transition (#4365)", () => {
  test("an open nested month's day card shares the month card's own left inset at two widths; a top-level month's stays flush", async ({
    browser,
  }, testInfo) => {
    const fixture = createFixture(testInfo, "geometry");
    const page = await loginAs(browser, {
      username: fixture.username,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      for (const width of [WIDE_PX, NARROW_DESKTOP_PX]) {
        await page.setViewportSize({ width, height: 900 });
        // Direct URL load, not a tap: `open` names the year AND the nested month,
        // which is `?open=`'s own multi-value grammar (parseTimelineOpen splits on
        // commas within one entry) — a hand-edited or bookmarked link has to reach
        // the same nested state a tap does.
        await page.goto(
          `/history?open=${LAST_YEAR}&open=${LAST_YEAR_MONTH}&open=${CURRENT_OLD_MONTH}`
        );

        const nestedMonth = page.getByTestId(`history-fold-${LAST_YEAR_MONTH}`);
        await expect(nestedMonth).toHaveAttribute("data-fold-nested", "true");
        await expect(nestedMonth).toHaveAttribute("data-fold-open", "true");
        const nestedDay = page.locator(`#timeline-day-${LAST_YEAR_DATE}`);
        await expect(nestedDay).toBeVisible();
        await expect(nestedDay).toHaveAttribute("data-day-nested", "true");

        const topMonth = page.getByTestId(`history-fold-${CURRENT_OLD_MONTH}`);
        await expect(topMonth).not.toHaveAttribute("data-fold-nested", "true");
        await expect(topMonth).toHaveAttribute("data-fold-open", "true");
        const topDay = page.locator(`#timeline-day-${CURRENT_OLD_DATE}`);
        await expect(topDay).toBeVisible();
        await expect(topDay).not.toHaveAttribute("data-day-nested", "true");

        const edges = await insetEdges(page);

        // THE CLAIM: one card's edge against the other's, not either against the
        // viewport (the same relationship #4045 §2 asserts for the right edge).
        expect(
          edges.nestedDay,
          `at ${width}px the nested month card starts at ${edges.nestedMonth} and its day at ${edges.nestedDay}`
        ).toBe(edges.nestedMonth);
        // THE CONVERSE, in the same test: an inset that is EQUAL on both sides
        // because neither one is inset would pass the assertion above for the
        // wrong reason. The nested pair must actually sit right of the top-level
        // pair for the equality above to mean containment rather than coincidence.
        expect(
          edges.nestedMonth,
          `at ${width}px the nested month (${edges.nestedMonth}) should sit right of the top-level month (${edges.topMonth})`
        ).toBeGreaterThan(edges.topMonth);
        // A CLOSED MONTH'S SIBLINGS ALIGN AS TODAY: the top-level month and the day
        // it reveals stay flush with each other — the fix must not touch them.
        expect(
          edges.topDay,
          `at ${width}px the top-level month card starts at ${edges.topMonth} and its day at ${edges.topDay}`
        ).toBe(edges.topMonth);
      }
    } finally {
      await page.context().close();
      destroyFixture(fixture);
    }
  });

  test("a fold toggle does not remount rows outside it, and a direct URL load matches the tapped path", async ({
    browser,
  }, testInfo) => {
    const fixture = createFixture(testInfo, "identity");
    const page = await loginAs(browser, {
      username: fixture.username,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.setViewportSize({ width: NARROW_DESKTOP_PX, height: 900 });
      await page.goto("/history");

      // HOLD the recent-band day — unrelated to the month fold about to toggle —
      // as the ACTUAL DOM node, per e2e/food-bar-subtree-identity.spec.ts's own
      // pattern: only a held node can answer "is it the SAME row", never a fresh
      // query, which is true either way.
      const held = await page.evaluateHandle(
        (sel) => document.querySelector(sel),
        `#timeline-day-${RECENT_DATE}`
      );

      const month = page.getByTestId(`history-fold-${CURRENT_OLD_MONTH}`);
      await expect(month).toHaveAttribute("data-fold-open", "false");
      await hydratedClick(page, month.locator("a"));
      await expect(month).toHaveAttribute("data-fold-open", "true");
      await expect(
        page.locator(`#timeline-day-${CURRENT_OLD_DATE}`)
      ).toBeVisible();

      const stillSameNode = await page.evaluate(
        ([sel, handle]) => document.querySelector(sel as string) === handle,
        [`#timeline-day-${RECENT_DATE}`, held] as const
      );
      expect(
        stillSameNode,
        "the recent-band day was replaced by opening an unrelated month fold"
      ).toBe(true);

      // TAPPED STATE, READ BACK. Then the SAME state reached by loading the URL
      // the tap produced directly — both have to render identically, because the
      // fold's open/closed state is the URL and nothing else (#4135).
      const tappedUrl = page.url();
      const tappedInset = await page.evaluate(
        (sel) =>
          Math.round(document.querySelector(sel)!.getBoundingClientRect().left),
        `[data-testid="history-fold-${CURRENT_OLD_MONTH}"]`
      );

      await page.goto(tappedUrl);
      await expect(month).toHaveAttribute("data-fold-open", "true");
      await expect(
        page.locator(`#timeline-day-${CURRENT_OLD_DATE}`)
      ).toBeVisible();
      const directInset = await page.evaluate(
        (sel) =>
          Math.round(document.querySelector(sel)!.getBoundingClientRect().left),
        `[data-testid="history-fold-${CURRENT_OLD_MONTH}"]`
      );
      expect(
        directInset,
        "direct URL load rendered a different inset than the tap"
      ).toBe(tappedInset);
    } finally {
      await page.context().close();
      destroyFixture(fixture);
    }
  });

  test("a fold toggle wraps its navigation in a view transition; reduced motion skips it", async ({
    browser,
  }, testInfo) => {
    const fixture = createFixture(testInfo, "transition");
    for (const reducedMotion of [false, true] as const) {
      const page = await loginAs(browser, {
        username: fixture.username,
        password: E2E_MEMBER_PASSWORD,
      });
      try {
        await page.emulateMedia({
          reducedMotion: reducedMotion ? "reduce" : "no-preference",
        });
        await page.goto("/history");

        // A COUNTING SPY, not a boolean: `startViewTransition` returning a real
        // `ViewTransition` (`ready`/`finished`/`updateCallbackDone` all resolved
        // promises, `skipTransition` a no-op) keeps the app's own navigation
        // working while this test watches whether the API was ever reached for.
        await page.evaluate(() => {
          const w = window as unknown as { __svtCalls: number };
          w.__svtCalls = 0;
          const real = document.startViewTransition?.bind(document);
          document.startViewTransition = ((cb: () => unknown) => {
            w.__svtCalls++;
            if (real) return real(cb);
            const p = Promise.resolve(cb());
            return {
              ready: p,
              finished: p,
              updateCallbackDone: p,
              types: new Set(),
              skipTransition() {},
            } as unknown as ViewTransition;
          }) as typeof document.startViewTransition;
        });

        const month = page.getByTestId(`history-fold-${CURRENT_OLD_MONTH}`);
        await expect(month).toHaveAttribute("data-fold-open", "false");
        await hydratedClick(page, month.locator("a"));
        await expect(month).toHaveAttribute("data-fold-open", "true");

        const calls = await page.evaluate(
          () => (window as unknown as { __svtCalls: number }).__svtCalls
        );
        if (reducedMotion) {
          expect(calls, "reduced motion should skip the view transition").toBe(
            0
          );
        } else {
          expect(
            calls,
            "the fold toggle never reached for startViewTransition"
          ).toBeGreaterThan(0);
        }
      } finally {
        await page.context().close();
      }
    }
    destroyFixture(fixture);
  });
});

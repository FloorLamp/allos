import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_SLEEP_WAITING,
  E2E_LOGIN_SLEEP_INPROGRESS,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { appContent, expectNoClippedContent } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";

// The morning waiting window (#2097), rendered.
//
// Both fixtures carry 14 synced nights ending YESTERDAY and nothing on today's
// wake-day — last night is not in hand, and something is still expected. Which side
// of the wake anchor the render lands on is fixed by each fixture's MEDIAN WAKE
// TIME against the suite's pinned 13:mm local clock, so neither assertion depends on
// the hour CI happens to start.
//
// What both tests are really pinning is an ABSENCE: no headline duration for a night
// nobody asked about. Before this, the surface filled the gap with the most recent
// recorded night — dated honestly since #2099, but still a large number the reader
// had to discount.

test("inside the arrival window, the sleep surfaces NAME the wait instead of showing an older night (#2097)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SLEEP_WAITING,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/sleep");
    const headline = page.getByTestId("sleep-waiting-headline");
    await expect(headline).toBeVisible();
    await expect(headline).toHaveAttribute("data-kind", "waiting");
    await expect(headline).toHaveText("Waiting for last night's sleep");

    // The hero it REPLACES is gone — the whole point is that no duration figure for
    // a different night is on screen under a headline.
    await expect(page.getByTestId("sleep-hero")).toHaveCount(0);
    // …and this is NOT the four-night "not synced" dead end either.
    await expect(page.getByTestId("sleep-stale")).toHaveCount(0);
    await expectNoClippedContent(page);

    // HOME SAYS THE SAME THING — one decision, three surfaces (#2097) — AND IT STILL
    // DOES. This arm read a ranked row (`[data-candidate-id^="sleep.waiting"]`
    // carrying its own `sleep-waiting-headline`) until #5435 §4 retired the ranker;
    // the STATEMENT did not go with it. Home's composer builds `sleepLine` from the
    // same `getSleepWaitingState` atom — `app/(app)/page.tsx` reads it beside
    // `getLastNightSummary` and hands its `headline` to the facts line — so what
    // changed is the seat, not the coverage. Asserted where it now lives rather than
    // re-pinned to a row that no longer exists; #2097's other two surfaces are the
    // `/sleep` arm above and the record's day view in the #4918 case below.
    await page.goto("/");
    const facts = appContent(page).getByTestId("home-facts");
    await expect(facts).toBeVisible();
    // AND THE ABSENCE IS CARRIED BY THE ANCHOR, which is why this is `^` and not a
    // `toContainText`. The facts line composes `[sleepLine, napsLine, stepsLine,
    // proteinLine, ...dayFacts]`, so the sleep statement is the FIRST part whenever
    // there is one, and `sleepLine` is a ternary: the waiting headline OR the
    // recorded night's label-and-duration, never both. A head that lost the waiting
    // state would therefore put "Last night · 7h 30m" (or a dated label for an older
    // night — the very figure #2097 exists to suppress) exactly where this regex
    // requires the headline, and a head that lost the sleep statement altogether
    // would start the line on naps or steps. Both fail it. That is the same claim
    // the retired `sleep-last-night-duration` absence made, made against markup that
    // is actually rendered: that testid is emitted by NOTHING at this head (it left
    // with the ranker), so asserting its count is 0 would now pass on an empty page.
    await expect(facts).toHaveText(/^Waiting for last night's sleep/);
  } finally {
    await page.context().close();
  }
});

test("before the wake anchor, it names the night in progress and says nothing about the reader (#2097)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SLEEP_INPROGRESS,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/sleep");
    const headline = page.getByTestId("sleep-waiting-headline");
    await expect(headline).toBeVisible();
    await expect(headline).toHaveAttribute("data-kind", "in-progress");
    await expect(headline).toHaveText("Tonight's sleep is still in progress");

    // The state is about the DATA. Nothing on this surface may comment on the hour
    // the reader is keeping — the app cannot know why anyone is awake, and a line
    // about when they are "usually asleep" would only mean anything as an implied
    // should.
    const card = page.getByTestId("sleep-waiting");
    await expect(card).not.toContainText("usually asleep", {
      ignoreCase: true,
    });
    await expect(card).not.toContainText("you're", { ignoreCase: true });
    await expect(page.getByTestId("sleep-hero")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

// Insert one more synced night for TODAY's wake-day, matching the fixture's own 14
// (health-connect sleep_min, 23:30 bed → the given wake time) — the shape that makes
// `hasLastNight` true and closes the window this describes. Returns a cleanup
// closure keyed on the inserted row's own id, mirroring
// e2e/dashboard-now.mobile.spec.ts's insertRecentlyEndedNap: this fixture is shared
// across repeats, so the row must not outlive the test that planted it.
function insertTonightsSession(
  username: string,
  wakeDay: string,
  wakeHhmm: string
): () => void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare(
        `SELECT lp.profile_id
           FROM logins l JOIN login_profiles lp ON lp.login_id = l.id
          WHERE l.username = ?
          ORDER BY lp.profile_id
          LIMIT 1`
      )
      .get(username) as { profile_id: number };
    const tz = pinnedTimezone(frozenNow().toISOString()).zone;
    const id = Number(
      db
        .prepare(
          `INSERT INTO metric_samples
             (profile_id, source, metric, date, started_at, ended_at, value)
           VALUES (?, 'health-connect', 'sleep_min', ?, ?, ?, 450)`
        )
        .run(
          profile.profile_id,
          wakeDay,
          zonedWallTimeToUtc(
            tz,
            shiftDateStr(wakeDay, -1),
            "23:30"
          )!.toISOString(),
          zonedWallTimeToUtc(tz, wakeDay, wakeHhmm)!.toISOString()
        ).lastInsertRowid
    );
    return () => {
      const cleanupDb = new Database(workerDbPath());
      try {
        cleanupDb.pragma("busy_timeout = 5000");
        cleanupDb.prepare("DELETE FROM metric_samples WHERE id = ?").run(id);
      } finally {
        cleanupDb.close();
      }
    };
  } finally {
    db.close();
  }
}

// #4918 ruling 7: today names its sleep wait on the DAY VIEW too, in words and on
// the plot — not only /sleep and the dashboard row. The #4923 partial ruled this
// unreachable through the acceptance criterion's own fixture (`getIntradayDay`
// returned null with nothing else on today, so there was no `intraday-panel` for
// the headline to render inside); the empty-day ruling that followed made
// `getIntradayDay` always return a model, which is exactly what unblocks this.
test("the day view names the wait too, and draws the expected sleep band — gone once a session lands (#4918 ruling 7)", async ({
  browser,
}) => {
  test.slow();

  const page = await loginAs(browser, {
    username: E2E_LOGIN_SLEEP_WAITING,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // The fixture's newest recorded wake-day is yesterday (14 nights ending
    // today−1, nothing on today's own wake-day yet) — today itself is read off the
    // page rather than recomputed from the run's frozen clock.
    await page.goto("/history");
    // eslint-disable-next-line no-restricted-properties -- first-ok: newest day group, the fixture's own yesterday
    const newest = (await page
      .locator("[id^='timeline-day-']")
      .first()
      .getAttribute("id"))!.replace("timeline-day-", "");
    const todayStr = shiftDateStr(newest, 1);

    await page.goto(`/history?day=${todayStr}`);
    const panel = page.getByTestId("intraday-panel");
    await expect(panel).toBeVisible();
    const headline = panel.getByTestId("sleep-waiting-headline");
    await expect(headline).toBeVisible();
    await expect(headline).toHaveAttribute("data-kind", "waiting");
    // The freshness sentence and the waiting line say different things — both
    // stay, same as #4923 already proved at the component tier.
    await expect(panel.getByTestId("intraday-context")).toBeVisible();

    // THE PLOT CARRIES THE BAND TOO, in the variant this viewport actually shows.
    const wideChart = panel.locator('[data-variant="wide"]');
    await expect(
      wideChart.locator('[data-testid="intraday-expected-sleep"]')
    ).toHaveCount(1);

    // ONCE A SESSION FOR THE WAKE DAY EXISTS, NEITHER RENDERS.
    const cleanup = insertTonightsSession(
      E2E_LOGIN_SLEEP_WAITING,
      todayStr,
      "12:00"
    );
    try {
      await page.reload();
      await expect(page.getByTestId("sleep-waiting-headline")).toHaveCount(0);
      await expect(
        page
          .getByTestId("intraday-panel")
          .locator('[data-testid="intraday-expected-sleep"]')
      ).toHaveCount(0);
    } finally {
      cleanup();
    }
  } finally {
    await page.context().close();
  }
});

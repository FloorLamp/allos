import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { loginAs } from "./nav";
import { followLink, openDashboardAll, settledClick } from "./helpers";
import { E2E_LOGIN_WEATHER, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { WEATHER_PROFILE } from "./logins/findings";
import { workerDbPath, frozenSyncInstant } from "./worker-env";

// Open-Meteo weather/UV integration + the two-sided UV-dose sun model (#1172). The
// fixture profile (E2E_LOGIN_WEATHER) is seeded with a home location, skin type, the
// weather connection ENABLED, an outdoor activity today, and cached LIVE UV, so every
// READ here is offline. Isolated from profile 1 so the enable/disable toggles +
// timeline surfaces don't disturb the shared session's specs.
//
// ONE exception, and it is deliberate: `enableWeatherAction` kicks an initial
// `runWeatherSync` with the real openMeteoSource (the WeatherSource seam is on
// runWeatherSync, which the action does not thread), so the re-enable in the last
// test below makes a genuine outbound request. That is the PRODUCT behaviour and the
// test must not pretend otherwise — see restoreWeatherFixture() for how the run's
// side effects are undone.

// The two events e2e/seed/findings.ts seeds for the weather profile — an hour and two
// hours before the run's frozen clock, through the SAME derivation the seed writes
// them with. Relative rather than fixed because the standing composes the silence
// tolerance (#1685, unified in #2263) and weather's is twelve hours: a fixed
// time-of-day would read as a silent stop on any run starting later in the day.
// Anything else on the provider was written by a kicked sync during this file's run.
const SEEDED_SYNC_EVENTS = [frozenSyncInstant(2), frozenSyncInstant(1)];

// How long the ENABLE click's Server Action may honestly take (#4722).
//
// `enableWeatherAction` AWAITS `runWeatherSync` before it returns, and that sync
// spends its time in up to three SEQUENTIAL Open-Meteo requests — hourly, then the
// daily half's weather and air-quality calls — each bounded by
// `AbortSignal.timeout(TIMEOUT_MS)` with TIMEOUT_MS = 15_000
// (lib/integrations/open-meteo.ts). So the POST has a worst case of 3 x 15 s, and
// settledClick's 15 s default is smaller than ONE of those timeouts: whenever the
// runner's route to open-meteo stalls rather than refusing, the wait expires by
// arithmetic. That is how main went red at c72fa628 — the helper's own diagnosis
// there was that the POST was issued and no response arrived before the deadline.
//
// A PRESENCE wait, so the wider ceiling hides nothing: an action that never posts,
// or never answers, still fails — later. `test.slow()` on the case supplies the
// test budget the ceiling needs.
const WEATHER_ENABLE_POST_CEILING_MS = 3 * 15_000 + 5_000;

// Undo what the re-enable's kicked sync wrote. Whatever the network did, the run
// appends an integration_sync_events row — ok:1 with a today-relative window where
// open-meteo is reachable, ok:0 where it is not — and the sibling tests in this file
// read that provider's events: the first asserts its badge, and the history test
// asserts both the latest outcome line and runWindowNorm, which is decided by a
// majority over the event set. Two seeded rows survive one stray row; under
// --repeat-each they would not survive three. So the fixture is restored to exactly
// the seeded pair. Short-lived connection with a busy timeout so it never contends
// with the running server on the WAL DB (the shell.mobile / adherence-patterns
// pattern).
function restoreWeatherFixture(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(WEATHER_PROFILE) as { id: number } | undefined;
    if (!profile) return;
    db.prepare(
      `DELETE FROM integration_sync_events
        WHERE profile_id = ? AND source_id = 'weather' AND at NOT IN (?, ?)`
    ).run(profile.id, ...SEEDED_SYNC_EVENTS);
  } finally {
    db.close();
  }
}

// Put TODAY's cached day into the two legacy wet-weather shapes #1985 needs to pin.
// The fixture already owns eight historical rides, so its cycling tolerance envelope
// is revealed; this helper changes only the worker-private copy of today's GLOBAL
// location cache. `weatherCode = null` is the old cache shape where rain vs snow is
// unknowable. A real code beside NULL hourly precipitation is migration 149's
// transitional shape: intensity is known from the daily row, timing is not.
function setTodayWetWeather(weatherCode: number | null): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(WEATHER_PROFILE) as { id: number } | undefined;
    if (!profile) throw new Error(`Missing E2E profile: ${WEATHER_PROFILE}`);

    const settings = db
      .prepare(
        `SELECT key, value FROM profile_settings
          WHERE profile_id = ? AND key IN ('home_lat', 'home_lng')`
      )
      .all(profile.id) as { key: string; value: string }[];
    const value = (key: string): string => {
      const found = settings.find((row) => row.key === key)?.value;
      if (found == null)
        throw new Error(`Missing ${key} for ${WEATHER_PROFILE}`);
      return found;
    };
    const todayRide = db
      .prepare(
        `SELECT date FROM activities
          WHERE profile_id = ? AND title = 'Cycling' AND start_time = '07:00'
          LIMIT 1`
      )
      .get(profile.id) as { date: string } | undefined;
    if (!todayRide)
      throw new Error(`Missing today's cycling fixture for ${WEATHER_PROFILE}`);
    const date = todayRide.date;
    const lat = Number(value("home_lat"));
    const lng = Number(value("home_lng"));

    const changed = db
      .prepare(
        `UPDATE weather_days
            SET temp_max_c = 18,
                temp_min_c = 10,
                precipitation_mm = 45,
                weather_code = ?
          WHERE lat = ? AND lng = ? AND date = ?`
      )
      .run(weatherCode, lat, lng, date);
    if (changed.changes !== 1)
      throw new Error(`Expected one weather day for ${date}`);

    db.prepare(
      `UPDATE weather_uv_hours
          SET precipitation_mm = NULL
        WHERE lat = ? AND lng = ? AND hour_ts LIKE ?`
    ).run(lat, lng, `${date}%`);
  } finally {
    db.close();
  }
}
// The record's newest day, read off the page rather than recomputed from the run's
// frozen clock. The day CONTEXT (daylight, UV, weather) lives on the day view since
// #3958 phase 2 — the scrolling record's day header is one line and a count — so the
// chip assertions below open that day first.
async function newestDay(page: Page): Promise<string> {
  await page.goto("/history");
  // eslint-disable-next-line no-restricted-properties -- first-ok: the newest day group; the assertion is about position
  const id = await page
    .locator("[id^='timeline-day-']")
    .first()
    .getAttribute("id");
  expect(id, "the record rendered no day group to open").not.toBeNull();
  return id!.replace("timeline-day-", "");
}

test.describe("Weather & UV integration (#1172)", () => {
  test("the integration page renders the connected state and UV surfaces", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    const member = await loginAs(browser, {
      username: E2E_LOGIN_WEATHER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/weather");
      const main = member.getByRole("main");
      await expect(
        main.getByRole("heading", { name: /Weather & UV/i })
      ).toBeVisible();
      // Seeded enabled → the connected badge from the shared state model (#1772);
      // the page's own weather-status badge is the not-enabled / no-location one.
      await expect(member.getByTestId("sync-status-weather")).toContainText(
        "Connected"
      );
      // Today's outdoor activity + cached UV → the dose summary card shows UV-min.
      await expect(member.getByTestId("weather-today-dose")).toContainText(
        "UV-min"
      );
      // The manual Sync-now control exists — the SHARED button now, the same one
      // Review's inbox offers, instead of this page's own redirecting form.
      await expect(member.getByTestId("sync-now-weather")).toBeVisible();
    } finally {
      await member.context().close();
    }
  });

  test("the setup page owns the history table, and Review collapses the healthy source (#1614/#1772)", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_WEATHER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/weather");

      // #1614 made Weather's successful history reachable at all (it had been
      // excluded from Connected sources by kind). #1772 then moved every recurring
      // provider's history HOME: the setup page renders the real table, and Review
      // links back to it. So the history is here, in the provider's own page.
      const history = member.getByTestId("sync-history");
      await expect(history).toBeVisible();

      // A CACHE provider speaks cache language: its counts are revised forecast
      // cells of a global location-keyed cache, not user records, so the run reads
      // "16 readings revised" — never "16 changed · 320 unchanged".
      //
      // `exact` is load-bearing, not decoration. The day header states the same
      // phrase with its own tally in front of it ("1 refresh · 16 readings
      // revised"), so a SUBSTRING match claims both the header and the run, and
      // whether that is one element or two depends on how many day groups the
      // seeded pair falls into — which is a function of the run's frozen hour
      // (see SEEDED_SYNC_EVENTS above: the pair is placed 1h and 2h back, and the
      // fixture profile keeps a FIXED America/New_York clock while the frozen
      // instant rotates, so the pair straddles local midnight for runs frozen in
      // [05:00, 06:00) UTC — [06:00, 07:00) under EST). Asserting on the run's own
      // whole text is true in every grouping; the header is asserted separately.
      await expect(
        history.getByText("16 readings revised", { exact: true })
      ).toBeVisible();
      await expect(history.getByText(/320 unchanged/)).toHaveCount(0);
      // The window both runs cover is stated once above the table, as coverage.
      await expect(history.getByTestId("sync-history-window")).toContainText(
        "covers 2026-06-25 → 2026-07-09"
      );

      // Review is an inbox: a healthy provider is one line there, not a second copy
      // of this page — same badge, same outcome sentence, linking home.
      await member.goto("/data?section=review");
      const weatherRow = member
        .getByTestId("review-inbox")
        .getByTestId("source-weather");
      await expect(weatherRow).toBeVisible();
      await expect(weatherRow.getByTestId("sync-status-weather")).toContainText(
        "Connected"
      );
      await expect(
        weatherRow.getByText("Forecast refreshed · 16 readings revised")
      ).toBeVisible();
      // Nothing to act on, so no controls at all — just the way back.
      await expect(
        weatherRow.getByRole("button", { name: "Sync now" })
      ).toHaveCount(0);
      const back = weatherRow.getByRole("link");
      await expect(back).toHaveAttribute("href", "/integrations/weather");
    } finally {
      await member.context().close();
    }
  });

  test("the day view shows the live UV badge for the seeded outdoor day", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_WEATHER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto(`/history?day=${await newestDay(member)}`);
      // The seeded walk today logged 120 daylight-outdoor minutes → the minutes chip
      // (the offline #571 behavior) AND, because live UV is cached, the UV badge on
      // top of it (the #1172 enrichment). Scope to the fixture's own day header.
      const uvBadge = member.getByTestId("daylight-uv").first(); // eslint-disable-line no-restricted-properties -- first-ok: fixture-owned single seeded outdoor day
      await expect(uvBadge).toBeVisible();
      await expect(uvBadge).toContainText("UV");
      // Degradation guarantee: the minutes-outdoors chip is always present too.
      await expect(
        member.getByTestId("daylight-outdoor-minutes").first() // eslint-disable-line no-restricted-properties -- first-ok: fixture-owned single seeded outdoor day
      ).toBeVisible();
    } finally {
      await member.context().close();
    }
  });

  test("conditions are stamped on the outdoor session and the notable day (#1728)", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_WEATHER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // The seeded RIDE is outdoor-flagged, so its training log record carries the
      // conditions it happened in. The seeded walk is not outdoor-flagged and
      // carries none — the catalog flag decides, not the availability of data.
      // The feed is slim rows: follow the ride to its canonical page for metrics.
      await member.goto("/training?tab=log");
      // eslint-disable-next-line no-restricted-properties -- first-ok: fixture-owned single seeded ride
      const rideRow = member
        .getByTestId("history-row")
        .filter({ hasText: "Cycling" })
        .first();
      await followLink(
        member,
        rideRow.getByRole("link", { name: "Cycling", exact: true }),
        /\/training\/activity\/\d+$/
      );
      const rideCard = member.getByTestId("training-activity-page");
      await expect(rideCard).toBeVisible();
      // Rendered in the LOGIN's scale (the fixture login reads Fahrenheit), which is
      // the point: the stamp is a display concern over a canonical °C reading.
      await expect(rideCard.getByTestId("activity-metrics")).toContainText(
        "93°F · clear"
      );

      // The three-day hot spell makes today NOTABLE, so the record's DAY VIEW
      // carries its conditions summary. Quiet days carry none.
      await member.goto(`/history?day=${await newestDay(member)}`);
      const context = member.getByTestId("history-day-weather");
      await expect(context).toBeVisible();
      await expect(context).toContainText("Heatwave");
    } finally {
      await member.context().close();
    }
  });

  test("the outdoor-session plan names the best window on Upcoming (#1724)", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_WEATHER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // The fixture is behind a 2x/week cardio target with a season of rides and a
      // forecast whose only dry day is two days out — scarce viability, so the plan is
      // signal. Upcoming is the planning surface; the digest renders the SAME line.
      await member.goto("/upcoming");
      await expect(
        member.getByRole("link", {
          name: "Best window for your cycling this week",
        })
      ).toBeVisible();
      // The detail is the SAME planningLine string the digest renders: it names the
      // weekday and the target's progress, and it hedges ("so far") because the week
      // reaches past the reliable forecast horizon.
      await expect(
        member.getByText(/looks like the best window for your cycling/)
      ).toContainText("cycling 1/2");
    } finally {
      await member.context().close();
    }
  });

  test("the coaching disclosure preserves both legacy wet-cache states (#1985)", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_WEATHER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // No weather code means the cache cannot distinguish rain from snow. The ride is
      // still parked by the measured precipitation, but the card deliberately renders
      // no parenthesized figure rather than guessing a precipitation kind.
      setTodayWetWeather(null);
      await member.goto("/");
      await openDashboardAll(member);
      const noCode = member.getByText(
        "Too wet for cycling — picking something indoors instead. Outdoor cycling resumes when it dries out."
      );
      await expect(noCode).toBeVisible();
      await expect(noCode).not.toContainText("(");

      // Migration 149 added hourly precipitation to an already-populated cache. Until
      // the next sync those hourly values are NULL, so the daily WMO code can name heavy
      // rain but cannot honestly invent morning/afternoon/evening timing.
      setTodayWetWeather(65);
      await member.reload();
      const legacyHours = member.getByText(
        "Too wet for cycling (heavy rain) — picking something indoors instead. Outdoor cycling resumes when it dries out."
      );
      await expect(legacyHours).toBeVisible();
      await expect(legacyHours).not.toContainText(/morning|afternoon|evening/);
    } finally {
      await member.context().close();
    }
  });

  test("disabling the integration turns the connection off", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_WEATHER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/weather");
      // Connected → the page renders the shared status header, so the connection is
      // evidenced by the controls only that branch has.
      await expect(member.getByTestId("sync-now-weather")).toBeVisible();

      // Disable, then re-enable so the spec leaves the fixture as it found it (the
      // other tests in this file rely on the connected state).
      await settledClick(
        member,
        member.getByRole("button", { name: "Disable" })
      );
      // disconnectWeatherAction kicks no sync, so this badge is a pure function of
      // the connection row — deterministic, no budget needed.
      await expect(member.getByTestId("weather-status")).toContainText(
        /Not enabled/i
      );

      await settledClick(member, member.getByTestId("weather-enable"), {
        timeout: WEATHER_ENABLE_POST_CEILING_MS,
      });
      // This test is about the CONNECTION, so it asserts the connection — NOT the
      // sync-standing badge. Since #1772 `sync-status-weather` reports STANDING,
      // which folds in the recent runs' outcomes, and `enableWeatherAction` kicks a
      // real runWeatherSync before it revalidates: where open-meteo is reachable
      // that lands ok:1 and the badge reads "Connected", where it is not (CI has no
      // egress; openMeteoFetch catches and returns ok:false rather than throwing) it
      // lands ok:0 and the flap-aware badge (#1880) reads "Intermittent" — calm,
      // because one failed run beside this morning's seeded successes is a flap, not
      // an outage. Asserting "Connected" here was asserting the network, which is
      // why widening its budget to 20s did not help (run 30682). The connected VIEW
      // is the honest, offline-deterministic signal: only that branch renders these
      // controls.
      await expect(member.getByTestId("sync-now-weather")).toBeVisible();
      await expect(
        member.getByRole("button", { name: "Disable" })
      ).toBeVisible();
    } finally {
      // The kicked sync appended an event whatever the network did; drop it so the
      // siblings (and the next --repeat-each pass) see the seeded pair.
      restoreWeatherFixture();
      await member.context().close();
    }
  });
});

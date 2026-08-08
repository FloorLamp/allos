import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
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
        WHERE profile_id = ? AND provider = 'weather' AND at NOT IN (?, ?)`
    ).run(profile.id, ...SEEDED_SYNC_EVENTS);
  } finally {
    db.close();
  }
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

  test("the timeline shows the live UV badge for the seeded outdoor day", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_WEATHER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/timeline");
      // The seeded walk today logged 120 daylight-outdoor minutes → the minutes chip
      // (the offline #571 behavior) AND, because live UV is cached, the UV badge on
      // top of it (the #1172 enrichment). Scope to the fixture's own day header.
      const uvBadge = member.getByTestId("daylight-uv").first(); // first-ok: fixture-owned single seeded outdoor day
      await expect(uvBadge).toBeVisible();
      await expect(uvBadge).toContainText("UV");
      // Degradation guarantee: the minutes-outdoors chip is always present too.
      await expect(
        member.getByTestId("daylight-outdoor-minutes").first() // first-ok: fixture-owned single seeded outdoor day
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
      // The seeded RIDE is outdoor-flagged, so its journal card carries the conditions
      // it happened in. The seeded walk is not outdoor-flagged and carries none —
      // the catalog flag decides, not the availability of data.
      await member.goto("/training");
      const rideCard = member.locator(".card", { hasText: "Cycling" }).first(); // first-ok: fixture-owned single seeded ride
      await expect(rideCard).toBeVisible();
      // Rendered in the LOGIN's scale (the fixture login reads Fahrenheit), which is
      // the point: the stamp is a display concern over a canonical °C reading.
      await expect(rideCard.getByTestId("activity-metrics")).toContainText(
        "93°F · clear"
      );

      // The three-day hot spell makes today NOTABLE, so the Timeline day header
      // carries its conditions summary. Quiet days carry none.
      await member.goto("/timeline");
      const context = member.getByTestId("timeline-weather-context").first(); // first-ok: fixture-owned single notable day
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

      await settledClick(member, member.getByTestId("weather-enable"));
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

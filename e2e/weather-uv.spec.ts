import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_WEATHER, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Open-Meteo weather/UV integration + the two-sided UV-dose sun model (#1172). All
// offline — the fixture profile (E2E_LOGIN_WEATHER) is seeded with a home location,
// skin type, the weather connection ENABLED, an outdoor activity today, and cached
// LIVE UV, so nothing here touches the network. Isolated from profile 1 so the
// enable/disable toggles + timeline surfaces don't disturb the shared session's specs.
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
      await expect(history.getByText("16 readings revised")).toBeVisible();
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
      await expect(member.getByTestId("sync-status-weather")).toContainText(
        "Connected"
      );
      // Disable, then re-enable so the spec leaves the fixture as it found it
      // (the other tests in this file rely on the connected state).
      await settledClick(
        member,
        member.getByRole("button", { name: "Disable" })
      );
      // Server-truth budget (#1556): the badge is server-rendered from the
      // connection row, so it only swaps after the disable action's write +
      // revalidate round-trip completes and the RSC tree repaints. Observed
      // losing the 5s default under CI shard load at retries=0 (run 30682); the
      // assertion still waits on the real commit, so it masks nothing.
      await expect(member.getByTestId("weather-status")).toContainText(
        /Not enabled/i,
        { timeout: 20_000 }
      );
      await settledClick(member, member.getByTestId("weather-enable"));
      // Same class, and the wider half of it: enableWeather also kicks an initial
      // runWeatherSync before revalidating, so the badge waits on a write + a sync
      // attempt + the repaint. This is the assertion run 30682 lost.
      await expect(member.getByTestId("sync-status-weather")).toContainText(
        "Connected",
        { timeout: 20_000 }
      );
    } finally {
      await member.context().close();
    }
  });
});

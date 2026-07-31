import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { followLink, settledClick } from "./helpers";
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
      // Seeded enabled → the connected badge (not "Not enabled"/"needed").
      await expect(member.getByTestId("weather-status")).toContainText(
        "Connected"
      );
      // Today's outdoor activity + cached UV → the dose summary card shows UV-min.
      await expect(member.getByTestId("weather-today-dose")).toContainText(
        "UV-min"
      );
      // The manual Sync-now control exists (drives the same idempotent sync).
      await expect(member.getByTestId("weather-sync")).toBeVisible();
    } finally {
      await member.context().close();
    }
  });

  test("the setup page's Sync history link reaches the Weather card in Review (#1614)", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_WEATHER,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/weather");
      // The setup page has always offered this link; Weather was excluded from
      // "Connected sources" by kind, so its successful history had no destination.
      const historyLink = member.getByTestId("sync-history-link");
      await expect(historyLink).toBeVisible();
      await followLink(member, historyLink, /\/data\?section=review/);

      const weatherCard = member
        .getByTestId("review-inbox")
        .getByTestId("source-weather");
      await expect(weatherCard).toBeVisible();
      await expect(weatherCard.getByText("Connected")).toBeVisible();
      // Latest state = the newest seeded run's split.
      await expect(
        weatherCard.getByText("12 new · 4 changed · 320 unchanged").first() // first-ok: the latest-state line repeats inside the collapsed history list of this fixture-owned card
      ).toBeVisible();
      // Keyless and tick-driven: no on-demand pull button, and not the push-only
      // explainer either — just a way back to its own settings.
      await expect(
        weatherCard.getByRole("button", { name: "Sync now" })
      ).toHaveCount(0);
      await expect(weatherCard.getByText(/Push-only/)).toHaveCount(0);
      const back = weatherCard.getByRole("link", {
        name: /Open Weather & UV .* settings/,
      });
      await expect(back).toHaveAttribute("href", "/integrations/weather");
      // The history tail is reachable from the card too.
      await expect(weatherCard.getByText(/Recent syncs \(2\)/)).toBeVisible();
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
      await expect(member.getByTestId("weather-status")).toContainText(
        "Connected"
      );
      // Disable, then re-enable so the spec leaves the fixture as it found it
      // (the other tests in this file rely on the connected state).
      await settledClick(
        member,
        member.getByRole("button", { name: "Disable" })
      );
      await expect(member.getByTestId("weather-status")).toContainText(
        /Not enabled/i
      );
      await settledClick(member, member.getByTestId("weather-enable"));
      await expect(member.getByTestId("weather-status")).toContainText(
        "Connected"
      );
    } finally {
      await member.context().close();
    }
  });
});

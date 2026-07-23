import { test, expect } from "@playwright/test";
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

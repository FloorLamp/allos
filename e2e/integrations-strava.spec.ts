import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_CHILD,
  E2E_LOGIN_STRAVA,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// /integrations/strava (issue #391, gap 4). Its siblings (Oura, Withings) each
// have a spec; Strava — freshly churned by the #326/#352 needs_reauth state — had
// none. The live OAuth exchange can't run offline, so this asserts the two rendered
// states that matter: the disconnected setup form, and the terminal needs_reauth
// reconnect CTA. Both run as isolated member sessions so neither depends on (nor
// disturbs) profile 1's seeded "connected" Strava that the review-inbox spec needs.
test.describe("Strava integration (#391)", () => {
  test("a profile with no Strava connection renders the credentials setup form", async ({
    browser,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    // Riley (child) has no Strava connection → the disconnected state. Integration
    // setup is not age-gated, so the page renders for this restricted profile.
    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/strava");
      const main = member.getByRole("main");
      await expect(
        main.getByRole("heading", { name: "Strava", exact: true })
      ).toBeVisible();
      // The Client ID / Secret credentials form that begins the OAuth setup.
      await expect(main.getByLabel("Client ID")).toBeVisible();
      await expect(
        main.getByRole("button", { name: "Save credentials" })
      ).toBeVisible();
      // No reauth notice in the clean disconnected state.
      await expect(member.getByTestId("strava-needs-reauth")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });

  test("a needs_reauth connection surfaces the reconnect CTA", async ({
    browser,
  }) => {
    test.slow();

    // The Strava-reauth member's profile carries a seeded needs_reauth connection.
    const member = await loginAs(browser, {
      username: E2E_LOGIN_STRAVA,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/strava");
      const cta = member.getByTestId("strava-needs-reauth");
      await expect(cta).toBeVisible();
      await expect(cta).toContainText(/connection expired|reconnect/i);
    } finally {
      await member.context().close();
    }
  });
});

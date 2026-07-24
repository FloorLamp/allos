import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_SUN, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Daylight-outdoor-minutes trend chart on Trends → Vitals (issue #1171). The chart is
// a formatter over the SAME getDaylightOutdoorMinutes computation the DaylightChip and
// the coaching average read (#221). The E2E_LOGIN_SUN fixture profile has a home
// location + outdoor daytime walks on several recent days, so the "Sun / outdoor time"
// card renders a real multi-day series. Data-gated: it's HIDDEN for a profile with no
// home location (sun features quietly off) — proven here with the default admin
// (profile 1), which has no seeded home. Isolated fixture; reads only, no writes.
test.describe("Sun / outdoor trend chart (#1171)", () => {
  test("renders the Sun / outdoor time card for a home-located profile", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit

    const member = await loginAs(browser, {
      username: E2E_LOGIN_SUN,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/trends?tab=vitals");
      await expect(member.getByRole("tab", { name: "Vitals" })).toHaveAttribute(
        "aria-selected",
        "true"
      );

      const card = member.getByTestId("vitals-sun-outdoor");
      await expect(card).toBeVisible();
      await expect(
        card.getByRole("heading", { name: "Sun / outdoor time" })
      ).toBeVisible();
    } finally {
      await member.context().close();
    }
  });

  test("is hidden for a profile with no home location", async ({ page }) => {
    // Default authed session = admin/profile 1, which has no seeded home location, so
    // the sun features are off and the card must not render.
    await page.goto("/trends?tab=vitals");
    await expect(page.getByRole("tab", { name: "Vitals" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(
      page.getByRole("main").getByTestId("vitals-sun-outdoor")
    ).toHaveCount(0);
  });
});

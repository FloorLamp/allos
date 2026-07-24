import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_SITIMPACT, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Situation-window analytics (#1297): the pooled protocol-compare engine pointed at the
// declared situation transition log renders a per-situation "Situation impact" card on
// Trends → Insights. Driven against the dedicated SITUATION_IMPACT_PROFILE, seeded with a
// past Travel window (with during + baseline weight/resting-HR readings) and a one-day
// High-stress toggle that has too little history to render (the absent-pillar rule).

test.describe("Situation impact cards (#1297)", () => {
  test("a seeded Travel window renders a pooled impact card; a thin situation renders nothing", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SITIMPACT,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/trends?tab=insights");

    const impacts = page.getByTestId("situation-impacts");
    await expect(impacts).toBeVisible();

    // Travel has a real window with enough data → its card renders, tagged with the window
    // + day count and the pooled outcome chips (weight + resting HR).
    const travel = page.getByTestId("situation-impact-Travel");
    await expect(travel).toBeVisible();
    await expect(travel).toContainText("Travel");
    await expect(travel).toContainText(/window/);
    await expect(
      travel.getByTestId("situation-impact-Travel-metric:weight")
    ).toBeVisible();
    await expect(
      travel.getByTestId("situation-impact-Travel-metric:resting_hr")
    ).toBeVisible();
    // The pooled resting-HR shift (baseline 50 → during 56) reads +6.
    await expect(
      travel.getByTestId("situation-impact-Travel-metric:resting_hr")
    ).toContainText("+6");

    // High stress toggled for a single day → below the during-days floor → no card at all.
    await expect(page.getByTestId("situation-impact-High stress")).toHaveCount(
      0
    );
  });
});

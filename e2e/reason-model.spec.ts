import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_REASON, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Shared reason model — the surface proof (issue #656 item 4). The REASON_MODEL
// fixture profile has a family history of heart disease AND a fresh out-of-range
// LDL, so the biomarker-flag item on /upcoming gains its risk-layer "why-for-this-
// profile" line. Isolated fixture login (never a shared-seed profile), read-only, so
// it's safe under --repeat-each. The model itself (the SAME reason reaching the
// Upcoming item, the attention model, and the digest) is pinned at the pure + DB
// tiers (lib/__db_tests__/reason-model.test.ts); this proves the line renders.
test.describe("shared reason model (#656)", () => {
  test("a risk-elevated flagged biomarker shows a why-for-this-profile line on Upcoming", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_REASON,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/upcoming");

    // The flagged LDL surfaces as a biomarker-flag action item under "Flagged".
    const item = page.getByTestId(
      "upcoming-item-biomarker-flag:ldl cholesterol"
    );
    await expect(item).toBeVisible();
    await expect(item).toContainText("Review LDL Cholesterol");
    // The new why-line: the elevation is explained, not just ordered.
    await expect(item).toContainText("Family history of heart disease");
  });
});

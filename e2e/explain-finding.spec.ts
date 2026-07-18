import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_REASON, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// "Why is this flagged?" explainer (issue #878, Phase 1) — the surface proof. Reuses
// the isolated REASON_MODEL fixture (a family history of heart disease + a fresh
// out-of-range LDL), whose /upcoming biomarker-flag item carries structured reasons.
// The e2e DB boots WITHOUT an AI tier, so clicking "Why?" returns the deterministic
// STRUCTURED fallback (the graceful-degradation surface) — narration over the item's
// OWN reasons, no model, no re-derived fact. Read-only + isolated fixture, so it's
// safe under --repeat-each.
test.describe("explain a flagged finding (#878)", () => {
  test("clicking Why? narrates the flagged biomarker's own reasons (offline fallback)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_REASON,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/upcoming");
    const item = page.getByTestId(
      "upcoming-item-biomarker-flag:ldl cholesterol"
    );
    await expect(item).toBeVisible();

    // The explain affordance is present on a reasoned item.
    const why = item.getByTestId("explain-finding-button");
    await expect(why).toBeVisible();
    await why.click();

    // Keyless → the deterministic structured reasons render (the offline floor),
    // built ONLY from the item's own reason payload — so the risk "why-for-this-
    // profile" line appears verbatim, never a re-derived fact.
    const explanation = page.getByTestId("explain-finding-text");
    await expect(explanation).toBeVisible();
    await expect(explanation).toContainText(/flagged because/i);
    await expect(explanation).toContainText("Family history of heart disease");
  });
});

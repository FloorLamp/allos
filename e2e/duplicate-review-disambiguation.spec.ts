import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_DUP, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Duplicate-review candidate disambiguation (issue #531). seed-events plants ONE
// same-source duplicate on a dedicated profile: two manual weigh-ins on one day,
// both labelled "Manual entry". Labelling the merge/keep buttons by source alone
// would render "Merge, keep Manual entry" / "Keep Manual entry instead" — the two
// actions indistinguishable. The fix falls back to A/B with an on-card badge. We
// assert the badges + A/B button labels; this spec never merges, so the isolated
// member session's fixture is untouched.
test.describe("Duplicate review disambiguation (#531)", () => {
  test("labels a same-source pair A/B with on-card badges", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DUP,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/data?section=review");
      const review = page.getByTestId("review-inbox");
      const pair = review.getByTestId("dup-body-metric-pair");
      await expect(pair).toHaveCount(1);

      // Both candidate cards carry an A/B badge (the on-element referent, correct
      // in the stacked and side-by-side layouts alike).
      const badges = pair.getByTestId("dup-candidate-badge");
      await expect(badges).toHaveCount(2);
      await expect(badges.nth(0)).toHaveText("A");
      await expect(badges.nth(1)).toHaveText("B");

      // The buttons reference the badge, not the collapsed source label.
      await expect(
        pair.getByRole("button", { name: /Merge, keep A\b/ })
      ).toBeVisible();
      await expect(
        pair.getByRole("button", { name: /Keep B instead/ })
      ).toBeVisible();
      // The old collapsed label must not appear on a button.
      await expect(
        pair.getByRole("button", { name: /keep Manual entry/i })
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});

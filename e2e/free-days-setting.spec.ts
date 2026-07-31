import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { settledCheck } from "./helpers";
import { E2E_LOGIN_SUN, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Per-profile "free days" setting (issue #1241) on Settings → Profile — the off-day
// set that drives the Sleep Regularity card's social-jetlag split. Defaults to the
// weekend (Sat/Sun); a shift worker overrides it. Autosaves on toggle (the Settings
// convention, #794). Driven on the dedicated E2E_LOGIN_SUN fixture profile (its own
// cookie context), so toggling its free_days never disturbs profile 1's shared sleep
// surfaces. Settings state is profile-owned here, so this runs in its own context.
test.describe("Free days setting (#1241)", () => {
  test("shows the Sat/Sun default and persists a toggled off-day", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Settings route on first hit

    const member = await loginAs(browser, {
      username: E2E_LOGIN_SUN,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/health");

      const card = member.getByTestId("free-days-form");
      await expect(card).toBeVisible();

      // Default: Sunday (0) and Saturday (6) checked, the weekday boxes clear.
      await expect(card.getByTestId("free-day-0")).toBeChecked(); // Sun
      await expect(card.getByTestId("free-day-6")).toBeChecked(); // Sat
      await expect(card.getByTestId("free-day-3")).not.toBeChecked(); // Wed

      // Check Wednesday (a shift worker's off day) — settledCheck waits for React to
      // hydrate the controlled checkbox before toggling, so the onChange fires and
      // the autosave posts.
      await settledCheck(member, card.getByTestId("free-day-3"), true);
      // The SaveStatus check (aria-label "Saved") appears only once the action lands;
      // wait for it before reloading so the reload can't race the write.
      await expect(card.getByLabel("Saved")).toBeVisible();

      // Reload: Wednesday persisted alongside the untouched weekend defaults.
      await member.reload();
      const reloaded = member.getByTestId("free-days-form");
      await expect(reloaded.getByTestId("free-day-3")).toBeChecked();
      await expect(reloaded.getByTestId("free-day-0")).toBeChecked();
      await expect(reloaded.getByTestId("free-day-6")).toBeChecked();

      // Uncheck Wednesday again and confirm the removal persists too.
      await settledCheck(member, reloaded.getByTestId("free-day-3"), false);
      await expect(reloaded.getByLabel("Saved")).toBeVisible();
      await member.reload();
      await expect(
        member.getByTestId("free-days-form").getByTestId("free-day-3")
      ).not.toBeChecked();
    } finally {
      await member.context().close();
    }
  });
});

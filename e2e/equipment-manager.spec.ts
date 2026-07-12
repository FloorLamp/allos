import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Settings → Equipment (issue #391, gap 3). equipment-lifecycle covers retire/
// restore; this covers the untested rest: adding an implement WITH its own weight
// (shown in the login's weight unit), deleting one that a logged set references
// (the link nulls, no FK 500, history survives — the #342 side-state rule), and the
// age-gate bounce that keeps a restricted profile off the tab even by direct URL.
test.describe("Equipment manager (#391)", () => {
  test("add an implement with its own weight — listed with the weight unit", async ({
    page,
  }) => {
    // Local `next dev` compiles the equipment route on first hit.
    test.slow();

    await page.goto("/settings/equipment");
    await expect(
      page.getByRole("heading", { name: "Your equipment" })
    ).toBeVisible();

    // Unique name so a CI retry against the same DB doesn't collide on the
    // per-profile name-uniqueness guard.
    const name = `E2E Own Weight Bar ${Date.now()}`;
    await page.getByRole("button", { name: "Add equipment" }).click();
    await page.getByLabel("Name").fill(name);
    // The bar-weight label carries the login's unit — match it unit-agnostically.
    await page.getByLabel(/Bar weight/).fill("15");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Equipment added")).toBeVisible();

    // The row lists the recorded own-weight rendered in the login's weight unit
    // ("15 kg" by default; "15 lb" if a sibling spec left the unit on lb — either
    // way the round-tripped number is what was entered).
    const row = page.getByTestId("equipment-row").filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/15\s*(kg|lb)/);
  });

  test("deleting a referenced implement nulls the link and the logged set still renders", async ({
    page,
  }) => {
    test.slow();

    // The seeded "E2E Delete Bar" is referenced by a logged strength set (see
    // seed-events). Delete it; the confirm dialog's own button is scoped to the
    // dialog so it can't be confused with the row's Delete icon. Guarded so a CI
    // retry (which reuses the DB where the bar is already gone) is a no-op.
    await page.goto("/settings/equipment");
    const row = page
      .getByTestId("equipment-row")
      .filter({ hasText: "E2E Delete Bar" });
    if (await row.count()) {
      await row.getByRole("button", { name: "Delete" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete" })
        .click();
      await expect(page.getByText("Deleted E2E Delete Bar")).toBeVisible();
      await expect(
        page.getByTestId("equipment-row").filter({ hasText: "E2E Delete Bar" })
      ).toHaveCount(0);
    }

    // The strength session that referenced the deleted bar still renders on the
    // Journal — the set's equipment_id was detached, not cascade-dropped.
    await page.goto("/training");
    await expect(
      page
        .locator('[id^="activity-"]')
        .filter({ hasText: "E2E Equipment Delete Session" })
        .first()
    ).toBeVisible();
  });

  test("an age-restricted profile is bounced off the Equipment tab by direct URL", async ({
    browser,
  }) => {
    test.slow();

    // A member whose sole active profile is Riley (child) — under the seeded
    // min-training-age gate. Navigating straight to /settings/equipment must
    // redirect to /settings (the tab is hidden for restricted profiles).
    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/equipment");
      await member.waitForURL(/\/settings$/, { timeout: 20_000 });
      await expect(member).toHaveURL(/\/settings$/);
      // The manager heading never renders for the bounced profile.
      await expect(
        member.getByRole("heading", { name: "Your equipment" })
      ).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});

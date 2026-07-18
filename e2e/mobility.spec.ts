import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_MOBILITY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Mobility on the Training overview (issue #840). Drives a dedicated fixture profile (an
// isolated member login) so tapping moves never perturbs a shared-seed profile under
// --repeat-each. The fixture carries a LOW sit-and-reach vital, so a deficit→habit
// SUGGESTION renders. Exactly ONE test in this spec MUTATES the profile (the log-flow
// test, which cleans up its own toggle); the render test is read-only, and neither clicks
// Accept (which would create a persistent target and hide the suggestion on a later run).
test.describe("Mobility (#840)", () => {
  test("renders the mobility section, region coverage, and a deficit suggestion", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MOBILITY,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow(); // local next dev compiles the training route on first hit

    await page.goto("/training?tab=overview");

    const section = page.getByTestId("mobility-section");
    await expect(section).toBeVisible();

    // The tap-the-moves bar and the region-coverage strip both render.
    await expect(page.getByTestId("mobility-log-bar")).toBeVisible();
    await expect(page.getByTestId("mobility-coverage")).toBeVisible();
    // All 7 MuscleRegions surface (including 0-coverage ones — the point of the view).
    await expect(page.getByTestId("mobility-coverage-row")).toHaveCount(7);

    // The deficit→habit suggestion renders with a one-tap accept + dismiss (not clicked).
    await expect(page.getByTestId("mobility-suggestion").first()).toBeVisible();
    await expect(page.getByTestId("mobility-accept-Legs")).toBeVisible();
    await expect(page.getByTestId("mobility-dismiss-Legs")).toBeVisible();

    await page.close();
  });

  test("tapping a move logs a recovery session that persists and shows on the journal", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MOBILITY,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();

    await page.goto("/training?tab=overview");
    const chip = page.getByTestId("mobility-move-pigeon_pose");
    await expect(chip).toBeVisible();

    // Normalize to OFF so the flow is repeat-safe regardless of a prior run's leftovers.
    if ((await chip.getAttribute("aria-pressed")) === "true") {
      await settledClick(page, chip);
      await expect(chip).toHaveAttribute("aria-pressed", "false");
    }

    // Tap ON → then prove PERSISTENCE across a reload (one recovery activity row
    // holds the move). The chip is purely optimistic (no disabled-while-saving
    // state), so the pressed attribute alone can't prove the server write — and
    // settledClick's any-POST arm can be satisfied by an unrelated on-load POST
    // while the action POST is still in flight, which a reload then kills (this
    // failed exactly so in CI's repeat lane). toPass is justified: "my tap landed
    // AND persisted" is non-atomic, there's no navigation for followLink, and a
    // dropped tap must be re-tapped — the loop can't false-pass because only the
    // POST-RELOAD state satisfies it.
    await expect(async () => {
      const c = page.getByTestId("mobility-move-pigeon_pose");
      if ((await c.getAttribute("aria-pressed")) !== "true") {
        await c.click();
        await expect(c).toHaveAttribute("aria-pressed", "true", {
          timeout: 3000,
        });
      }
      await page.reload();
      await expect(
        page.getByTestId("mobility-move-pigeon_pose")
      ).toHaveAttribute("aria-pressed", "true", { timeout: 3000 });
    }).toPass({ timeout: 45_000 });

    // The recovery session rides the shared journal feed (Training → Log) like any activity.
    await page.goto("/training?tab=log");
    await expect(page.getByText("Mobility").first()).toBeVisible();

    // Cleanup: untap so the fixture is clean for the next repeat.
    await page.goto("/training?tab=overview");
    const chipBack = page.getByTestId("mobility-move-pigeon_pose");
    if ((await chipBack.getAttribute("aria-pressed")) === "true") {
      await settledClick(page, chipBack);
      await expect(chipBack).toHaveAttribute("aria-pressed", "false");
    }

    await page.close();
  });
});

import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { followLink } from "./helpers";
import {
  E2E_LOGIN_EMPTY_TRAINING,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Training → Log first-run empty state (issue #809). A brand-new / post-onboarding
// profile has NO activities. HistorySection used to early-return a bare EmptyState
// ("No activities logged yet. Use 'Log activity' to start.") BEFORE JournalView —
// which owns the Log-activity action row (New activity / Start workout) and the
// activity-editor wiring — ever mounted, so the very users who need "New activity"
// had no way to reach it. Every seeded fixture profile has activities (No Gear even
// seeds one on purpose so its Log tab renders the Journal), which is exactly why this
// shipped uncaught. These drive a dedicated ACTIVITY-FREE adult profile (its own
// member login, isolated context) and assert the first-run variant.
test.describe("Training Log first-run empty state (#809)", () => {
  test("an activity-free profile reaches New activity on desktop", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_EMPTY_TRAINING,
      password: E2E_MEMBER_PASSWORD,
    });
    // Local `next dev` compiles the training route on first hit.
    test.slow();

    await page.goto("/training?tab=log");

    // First-run copy — NOT the filter-empty copy (there is nothing to filter).
    await expect(
      page.getByText("No activities logged yet. Log your first workout", {
        exact: false,
      })
    ).toBeVisible();
    await expect(
      page.getByText("No activities match your filters")
    ).toHaveCount(0);

    // The action row is present and prominent (viewport width 1280 ≥ md, so the
    // `md:flex` desktop row shows): New activity + Start workout, but NOT Repeat
    // last — nothing has been logged, so there is nothing to repeat.
    const actions = page.getByTestId("journal-actions");
    await expect(actions).toBeVisible();
    await expect(
      actions.getByRole("button", { name: "New activity" })
    ).toBeVisible();
    await expect(
      actions.getByRole("button", { name: "Start workout" })
    ).toBeVisible();
    await expect(page.getByTestId("repeat-last")).toHaveCount(0);

    // Search / filter controls are meaningless over an empty history and are hidden,
    // as is the routine/cadence row.
    await expect(page.getByTestId("journal-controls")).toHaveCount(0);
    await expect(
      page.getByPlaceholder("Search activities or exercises…")
    ).toHaveCount(0);
    await expect(page.getByTestId("journal-routine-row")).toHaveCount(0);

    // Tapping New activity opens the editor (its activity-name combobox appears) —
    // the affordance the early return used to strand.
    await actions.getByRole("button", { name: "New activity" }).click();
    await expect(page.getByPlaceholder(/What did you do/)).toBeVisible();

    await page.close();
  });

  test("the mobile log affordance survives first-run", async ({ browser }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_EMPTY_TRAINING,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/training?tab=log");
    await expect(
      page.getByText("No activities logged yet. Log your first workout", {
        exact: false,
      })
    ).toBeVisible();

    // The desktop action row is `hidden` below md; the mobile entry point is
    // MobileNav's always-mounted quick-log chrome (the responsive shared-content
    // rule — the first-run empty state must not strand mobile users either). Both
    // the "Log activity" (+) and "Start workout" (bolt) controls are present, and
    // "Log activity" opens the editor overlay.
    await expect(page.getByTestId("journal-actions")).toBeHidden();
    await expect(page.getByTestId("start-workout-mobile")).toBeVisible();
    const mobileLog = page.getByRole("button", { name: "Log activity" });
    await expect(mobileLog).toBeVisible();
    await mobileLog.click();
    await expect(page.getByPlaceholder(/What did you do/)).toBeVisible();

    await page.close();
  });

  // #812: an EmptyState that names a destination now links to it. The Analyze tab's
  // "No training data yet. Log an activity…" empty state carries a typed action link
  // to the Log tab. Same activity-free fixture — a representative of the whole sweep.
  test("the Analyze empty state links to the Log tab", async ({ browser }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_EMPTY_TRAINING,
      password: E2E_MEMBER_PASSWORD,
    });
    test.slow();

    await page.goto("/training?tab=analyze");
    await expect(
      page.getByText("No training data yet. Log an activity", { exact: false })
    ).toBeVisible();

    // Follow the empty state's action link — it lands on the Log tab.
    await followLink(
      page,
      page.getByRole("link", { name: /Go to Log/ }),
      /\/training\?tab=log/
    );
    await expect(
      page.getByText("No activities logged yet. Log your first workout", {
        exact: false,
      })
    ).toBeVisible();

    await page.close();
  });
});

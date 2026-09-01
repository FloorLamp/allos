import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { settledBoxes } from "./helpers";
import { CONTROL_BOX_PX } from "@/lib/tap-floor-tokens";
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
  test("connected controls fit one phone card and expose keyboard focus", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/integrations/strava");
    await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();

    const status = page.getByTestId("strava-integration-status");
    const controls = status.locator(
      "[data-button-control], [data-integration-disconnect] button"
    );
    const count = await controls.count();
    expect(count).toBeGreaterThanOrEqual(3);
    const boxes = await settledBoxes(
      Array.from({ length: count }, (_, index) => controls.nth(index))
    );
    const [owner] = await settledBoxes([status]);
    expect(
      [...new Set(boxes.map((box) => Math.round(box.height)))],
      `the integration status row renders more than one control height: ${boxes
        .map((box) => box.height)
        .join(", ")}`
    ).toHaveLength(1);
    for (const box of boxes) {
      expect(box.height).toBeGreaterThanOrEqual(CONTROL_BOX_PX);
      expect(box.x).toBeGreaterThanOrEqual(owner.x);
      expect(box.x + box.width).toBeLessThanOrEqual(owner.x + owner.width);
      expect(box.y).toBeGreaterThanOrEqual(owner.y);
      expect(box.y + box.height).toBeLessThanOrEqual(owner.y + owner.height);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    for (let index = 1; index < boxes.length; index += 1) {
      const previous = boxes[index - 1];
      const current = boxes[index];
      expect(
        previous.x + previous.width <= current.x ||
          previous.y + previous.height <= current.y
      ).toBe(true);
    }

    const disconnect = status.locator("[data-integration-disconnect] button");
    const focusStyle = () =>
      disconnect.evaluate((button) => {
        const style = getComputedStyle(button);
        return {
          shadow: style.boxShadow,
          ringShadow: style.getPropertyValue("--tw-ring-shadow").trim(),
          ringColor: style.getPropertyValue("--tw-ring-color").trim(),
          brand: style.getPropertyValue("--color-brand-500").trim(),
        };
      });
    const unfocused = await focusStyle();
    await controls.nth(count - 2).focus();
    await page.keyboard.press("Tab");
    await expect(disconnect).toBeFocused();
    await expect
      .poll(async () => (await focusStyle()).shadow)
      .not.toBe(unfocused.shadow);
    const focused = await focusStyle();
    expect(focused.shadow).not.toBe(unfocused.shadow);
    expect(focused.ringShadow).not.toBe(unfocused.ringShadow);
    expect(focused.ringColor).toBe(focused.brand);
    await page.keyboard.press("Tab");
    await expect(disconnect).not.toBeFocused();
    await expect.poll(focusStyle).toEqual(unfocused);
  });

  test("a connected profile can backfill older session details", async ({
    page,
  }) => {
    await page.goto("/integrations/strava");
    const backfill = page.getByTestId("strava-backfill-details");
    await expect(backfill).toBeVisible();
    // "session", not "ride": the backfill covers every Strava activity since
    // #2870 step 4 widened the stream fetch past the cycling allowlist. The
    // JOB ID stays `ride-details` — it is a persisted key in
    // integration_backfill_jobs, so the testid below is unchanged.
    await expect(backfill).toContainText("Backfill session details");

    const progress = page.getByTestId("backfill-job-ride-details");
    await expect(progress).toBeVisible();
    await expect(progress.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "40"
    );
    await expect(progress).toContainText("4 sessions of 10");
    await expect(progress).toContainText("Waiting for quota");
    await expect(progress).toContainText(/Next retry in .*ETA/);

    await page.goto("/data?section=review");
    const reviewSource = page.getByTestId("source-strava");
    await expect(
      reviewSource.getByTestId("backfill-job-ride-details")
    ).toContainText("4 sessions of 10");
  });

  test("a profile with no Strava connection renders the credentials setup form", async ({
    browser,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    // Riley (child) has no Strava connection → the disconnected state. Integration
    // Integration setup remains available when the workout product is not, so
    // the page still renders for this early-childhood profile.
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

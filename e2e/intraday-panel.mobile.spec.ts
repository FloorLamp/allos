import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  expectNoClippedContent,
  expectSvgTextInsidePlot,
  expectSvgTextLegible,
} from "./helpers";
import { E2E_LOGIN_INTRADAY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The day chart at 390px — the surface #1518 and #1512 F were written about.
//
// What shipped: one 720-unit viewBox at `width: 100%`. On a phone the content
// column is ~358px, so the scale factor was 358 ÷ 720 ≈ 0.497 and the panel's
// 7-unit labels painted at ~3.5 CSS px. The whole chart scaled down into
// illegibility, and the guard that should have caught it had exempted this file
// outright (#1518).
//
// What replaced it: a compact variant whose box is close to the mobile container,
// so the ratio is ~1 and the label size is COMPUTED from that ratio rather than
// typed in. This spec is the browser-side proof — it measures what the browser
// actually painted, which is the only number a reader experiences.
test.describe("the day chart at phone width (#1512 F / #1518)", () => {
  test("renders the compact variant with legible, contained labels", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/timeline");
      const date = (await member
        .locator("[id^='timeline-day-']")
        .first() // first-ok: spec-owned profile, newest day is the fixture's today
        .getAttribute("id"))!.replace("timeline-day-", "");
      await member.goto(`/timeline?from=${date}&to=${date}`);

      const panel = member.getByTestId("intraday-panel");
      await expect(panel).toBeVisible();

      // The COMPACT variant is what a phone gets; the wide one is not displayed.
      const compact = panel.locator('[data-variant="compact"]');
      const wide = panel.locator('[data-variant="wide"]');
      await expect(compact).toBeVisible();
      await expect(wide).toBeHidden();

      // Every layer still renders — the variant is geometry, not a content fork.
      await expect(compact.getByTestId("intraday-hr")).toBeVisible();
      await expect(compact.getByTestId("intraday-sleep-block")).toHaveCount(1);
      await expect(compact.getByTestId("intraday-workout")).toHaveCount(1);
      await expect(compact.getByTestId("intraday-sleep-time")).toHaveCount(1);

      // The measurement that matters: painted type size, not the source number.
      await expectSvgTextLegible(member);
      // …and painted position: nothing leaves its plot or the viewport (#1573).
      await expectSvgTextInsidePlot(member);
      await expectNoClippedContent(member);
    } finally {
      await member.context().close();
    }
  });

  // #1512 C. An AI insight is stamped by the generation job's created_at, so its
  // minute describes the app rather than the person's day.
  test("shows the day's AI insight in the feed and gives it no tick", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/timeline");
      const date = (await member
        .locator("[id^='timeline-day-']")
        .first() // first-ok: spec-owned profile, newest day is the fixture's today
        .getAttribute("id"))!.replace("timeline-day-", "");
      await member.goto(`/timeline?from=${date}&to=${date}`);

      // The insight IS on this day, in the list below.
      await expect(member.getByText("AI insight").first()).toBeVisible(); // first-ok: spec-owned profile, one insight seeded on this day

      // And the rail still carries only the two clock-timed document uploads —
      // the machine event is not plotted beside the physiological ones.
      const chart = member
        .getByTestId("intraday-panel")
        .locator('[data-variant="compact"]');
      await expect(chart.getByTestId("intraday-tick")).toHaveCount(2);
      const titles = await chart
        .getByTestId("intraday-tick")
        .locator("title")
        .allTextContents();
      expect(titles.some((t) => t.includes("AI insight"))).toBe(false);
    } finally {
      await member.context().close();
    }
  });
});

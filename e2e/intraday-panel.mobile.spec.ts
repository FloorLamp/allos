import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  expectNoClippedContent,
  expectSvgTextInsidePlot,
  expectSvgTextLegible,
  touchPinch,
} from "./helpers";
import { E2E_LOGIN_INTRADAY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { INTRADAY_VARIANTS } from "@/lib/intraday-layout";

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
      await member.goto("/history");
      const date = (await member
        .locator("[id^='timeline-day-']")
        .first() // first-ok: spec-owned profile, newest day is the fixture's today
        .getAttribute("id"))!.replace("timeline-day-", "");
      await member.goto(`/history?day=${date}`);

      const panel = member.getByTestId("intraday-panel");
      await expect(panel).toBeVisible();

      // The COMPACT geometry is what this card's WIDTH earns (#4973 — the chart
      // reads its own container, and nothing on this page names a variant); the
      // wide one is not displayed. Asserted as the relationship that decides it:
      // the container is under the wide variant's own narrowest, and the compact
      // viewBox is what the browser got.
      const compact = panel.locator('[data-variant="compact"]');
      const wide = panel.locator('[data-variant="wide"]');
      await expect(compact).toBeVisible();
      await expect(wide).toBeHidden();
      // One chart per mount — the panel used to render a second, hidden one.
      await expect(panel.getByTestId("intraday-chart")).toHaveCount(1);
      await expect(compact.getByTestId("intraday-svg")).toHaveAttribute(
        "viewBox",
        /^0 0 360 /
      );
      expect(
        await panel
          .getByTestId("intraday-chart")
          .evaluate((el) => el.getBoundingClientRect().width)
      ).toBeLessThan(INTRADAY_VARIANTS.wide.minContainerPx);

      // Every layer still renders — the variant is geometry, not a content fork.
      await expect(compact.getByTestId("intraday-hr")).toBeVisible();
      await expect(compact.getByTestId("intraday-sleep-block")).toHaveCount(1);
      // Two blocks on two rows since #4852 — the ride on Train, the morning
      // practice on Practice — and both rows named in the compact gutter.
      await expect(compact.getByTestId("intraday-block")).toHaveCount(2);
      await expect(compact.locator('[data-row="Train"]')).toHaveCount(1);
      await expect(compact.locator('[data-row="Practice"]')).toHaveCount(1);
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

  // #4852 — PINCH. #1515 named "drag-to-select / pinch" as the primary gesture and
  // only the drag ever shipped; on a phone the drag is the ONLY way in, which is
  // what this closes. Driven as a real two-finger CDP touch sequence, because a
  // synthesised PointerEvent would bypass the browser's own touch-action
  // arbitration — the thing `touch-none` exists to win.
  test("two fingers spreading zoom the chart, and closing them restore the day", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/history");
      const date = (await member
        .locator("[id^='timeline-day-']")
        .first() // first-ok: spec-owned profile, newest day is the fixture's today
        .getAttribute("id"))!.replace("timeline-day-", "");
      await member.goto(`/history?day=${date}`);

      const chart = member
        .getByTestId("intraday-panel")
        .locator('[data-variant="compact"]');
      await expect(chart).toBeVisible();
      // The drawing, not the frame — a window read before the layers land is a
      // claim about an empty box.
      await expect(chart.getByTestId("intraday-hr")).toBeVisible();
      await expect(chart).toHaveAttribute("data-zoomed", "false");

      const svg = chart.getByTestId("intraday-svg");
      await svg.scrollIntoViewIfNeeded();
      const box = (await svg.boundingBox())!;
      const centre = { x: box.x + box.width / 2, y: box.y + box.height * 0.6 };

      // SPREAD: the fingers' gap triples, so the window narrows to about a third
      // about their midpoint.
      await touchPinch(member, centre, 40, 120);
      await expect(chart).toHaveAttribute("data-zoomed", "true");
      const zoomed = {
        from: Number(await chart.getAttribute("data-view-from")),
        to: Number(await chart.getAttribute("data-view-to")),
      };
      expect(zoomed.to - zoomed.from).toBeLessThan(900);
      // About the MIDPOINT: the fingers straddle the middle of the plot, so the
      // window keeps the day's midpoint rather than sliding to an edge.
      expect(zoomed.from).toBeGreaterThan(0);
      expect(zoomed.to).toBeLessThan(1440);

      // …and `touch-pan-y` is BACK once the fingers lift, so a vertical swipe
      // still scrolls the day view rather than being eaten by the chart.
      await expect(svg).not.toHaveAttribute("data-pinching", "true");

      // CLOSING them widens again, and the reset button is still the way out.
      await touchPinch(member, centre, 120, 30);
      await expect
        .poll(
          async () =>
            Number(await chart.getAttribute("data-view-to")) -
            Number(await chart.getAttribute("data-view-from"))
        )
        .toBeGreaterThan(zoomed.to - zoomed.from);
      await chart.getByTestId("intraday-zoom-reset").click();
      await expect(chart).toHaveAttribute("data-zoomed", "false");
      await expect(chart).toHaveAttribute("data-view-from", "0");
      await expect(chart).toHaveAttribute("data-view-to", "1440");
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
      await member.goto("/history");
      const date = (await member
        .locator("[id^='timeline-day-']")
        .first() // first-ok: spec-owned profile, newest day is the fixture's today
        .getAttribute("id"))!.replace("timeline-day-", "");
      await member.goto(`/history?day=${date}`);

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

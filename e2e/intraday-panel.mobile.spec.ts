import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  appContent,
  expectNoClippedContent,
  expectSvgTextInsidePlot,
  expectSvgTextLegible,
  touchPinch,
} from "./helpers";
import { E2E_LOGIN_INTRADAY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { INTRADAY_VARIANTS } from "@/lib/intraday-layout";

/** The fixture's intraday day IS the profile's today, resolved from the page. */
async function openFixtureDay(
  page: Awaited<ReturnType<typeof loginAs>>
): Promise<string> {
  await page.goto("/history");
  // eslint-disable-next-line no-restricted-properties -- first-ok: spec-owned profile, newest day is the fixture's today
  const date = (await page
    .locator("[id^='timeline-day-']")
    .first()
    .getAttribute("id"))!.replace("timeline-day-", "");
  await page.goto(`/history?day=${date}`);
  return date;
}

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
      // eslint-disable-next-line no-restricted-properties -- first-ok: spec-owned profile, newest day is the fixture's today
      const date = (await member
        .locator("[id^='timeline-day-']")
        .first()
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
      // eslint-disable-next-line no-restricted-properties -- first-ok: spec-owned profile, newest day is the fixture's today
      const date = (await member
        .locator("[id^='timeline-day-']")
        .first()
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
      // eslint-disable-next-line no-restricted-properties -- first-ok: spec-owned profile, newest day is the fixture's today
      const date = (await member
        .locator("[id^='timeline-day-']")
        .first()
        .getAttribute("id"))!.replace("timeline-day-", "");
      await member.goto(`/history?day=${date}`);

      // The insight IS on this day, in the list below.
      await expect(member.getByText("AI insight").first()).toBeVisible(); // eslint-disable-line no-restricted-properties -- first-ok: spec-owned profile, one insight seeded on this day

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

  // ── THE WINDOW THE ADD ROW WRITES INTO (#4950, as amended) ─────────────────
  //
  // No mode, no chip to arm, no second selection rect: the chart's two existing
  // interactions ARE the window. This is the browser-side proof of both, because both
  // are gestures — a component test can hand the row a view, but only a browser can
  // show that a drag on the plot produces one.
  //
  // Reads only, like the rest of this spec. What is asserted is the URL the chip mints
  // and the clocks the opened form holds; the door's own posting is pinned at the
  // component tier, where every kind's payload is read.
  test("a drag on the plot becomes the window the add row opens on", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      const date = await openFixtureDay(member);
      const chart = appContent(member)
        .getByTestId("intraday-panel")
        .locator('[data-variant="compact"]');
      await expect(chart).toBeVisible();

      // Drag across the middle of the plot. The gesture is the zoom that already
      // shipped (#1515) — this asserts a SECOND READER of it, not a second meaning.
      const svg = chart.getByTestId("intraday-svg");
      const box = (await svg.boundingBox())!;
      const y = box.y + box.height / 2;
      await member.mouse.move(box.x + box.width * 0.4, y);
      await member.mouse.down();
      await member.mouse.move(box.x + box.width * 0.65, y, { steps: 8 });
      await member.mouse.up();
      await expect(chart).toHaveAttribute("data-zoomed", "true");

      // The row states the span it would write into, in the profile's own format.
      const label = appContent(member).getByTestId("history-add-label");
      await expect(label).toHaveText(/^Add at \d{2}:\d{2}–\d{2}:\d{2}$/);
      const [from, to] = (await label.textContent())!
        .replace("Add at ", "")
        .split("–");

      // The chip carries it. The URL learns the window HERE and not on the drag:
      // zoom itself stays ephemeral.
      await appContent(member).getByTestId("history-add-practice").click();
      await expect(member).toHaveURL(
        new RegExp(`day=${date}.*from=${from.replace(":", "%3A")}`)
      );
      await expect(member).toHaveURL(/to=/);

      // And the form behind that door opens on both clocks — a default the person
      // confirms. The door is a toggle, as every kind's is (#4045 §1).
      await appContent(member).getByTestId("history-add-open-practice").click();
      await expect(member.locator("#practice-start-time")).toHaveValue(from);
      await expect(member.locator("#practice-end-time")).toHaveValue(to);
    } finally {
      await member.context().close();
    }
  });

  test("at full day the crosshair is a start alone, and the chip carries it", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await openFixtureDay(member);
      const chart = appContent(member)
        .getByTestId("intraday-panel")
        .locator('[data-variant="compact"]');
      await expect(chart).toBeVisible();

      // The keyboard cursor, unzoomed: a start and no end. Nothing here invents one —
      // an end nobody stated is a length nobody gave.
      await chart.getByTestId("intraday-svg").focus();
      await member.keyboard.press("Home");
      await member.keyboard.press("ArrowRight");
      await expect(chart).toHaveAttribute("data-zoomed", "false");

      const label = appContent(member).getByTestId("history-add-label");
      await expect(label).toHaveText(/^Add at \d{2}:\d{2}$/);
      const from = (await label.textContent())!.replace("Add at ", "");

      await appContent(member).getByTestId("history-add-practice").click();
      await expect(member).toHaveURL(
        new RegExp(`from=${from.replace(":", "%3A")}`)
      );
      await expect(member).not.toHaveURL(/[?&]to=/);
      await appContent(member).getByTestId("history-add-open-practice").click();
      await expect(member.locator("#practice-start-time")).toHaveValue(from);
      // The End shortcut's job, not this window's: an end nobody stated is a length
      // nobody gave.
      await expect(member.locator("#practice-end-time")).toHaveValue("");
    } finally {
      await member.context().close();
    }
  });
});

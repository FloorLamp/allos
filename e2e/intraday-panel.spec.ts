import { test, expect } from "./fixtures";
import { type Locator } from "@playwright/test";
import { loginAs } from "./nav";
import {
  expectSvgTextInsidePlot,
  expectSvgTextLegible,
  followLink,
} from "./helpers";
import {
  E2E_LOGIN_INTRADAY,
  E2E_MEMBER_PASSWORD,
  INTRADAY_ACTIVITY,
  INTRADAY_PRACTICE,
  INTRADAY_TICK_DOC,
} from "./fixture-logins";

// The Timeline day view's intraday panel (issue #1068) — the day rotated 90°: the
// SAME events the day's feed lists, projected onto a 00:00–24:00 clock axis.
//
// Spec-owned fixtures (#868): everything below lives on the dedicated
// E2E_LOGIN_INTRADAY profile seeded by e2e/seed-events.ts, so no shared-seed row is
// counted and no other spec's HR/zone numbers move. Reads only.
//
// TWO VARIANTS (#1512 F). The panel renders the chart twice with different
// GEOMETRY — a compact box for phones, a wide one from `sm` — because a fixed
// viewBox scaled to `width: 100%` cannot keep its type legible across both. Only
// one is displayed at a time, so every locator below is scoped to the variant this
// project's viewport actually shows; an unscoped last-resort match would reach
// into the hidden one.
const WIDE = '[data-variant="wide"]';

/** The fixture's intraday day IS the profile's today. Resolved from the page
 *  rather than by recomputing the run's frozen clock here. */
async function openFixtureDay(page: Awaited<ReturnType<typeof loginAs>>) {
  await page.goto("/history");
  const date = (await page
    .locator("[id^='timeline-day-']")
    .first() // first-ok: spec-owned profile, newest day is the fixture's today
    .getAttribute("id"))!.replace("timeline-day-", "");
  await page.goto(`/history?day=${date}`);
  return date;
}

/** The chart's visible window, in minutes — what every #4852 gesture moves. */
async function readWindow(
  chart: Locator
): Promise<{ from: number; to: number }> {
  return {
    from: Number(await chart.getAttribute("data-view-from")),
    to: Number(await chart.getAttribute("data-view-to")),
  };
}

test.describe("the day view's intraday panel (#1068)", () => {
  test("renders the day's layers and a tick jumps to its feed entry", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the record route on first hit

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      const date = await openFixtureDay(member);

      const panel = member.getByTestId("intraday-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute("data-intraday-date", date);
      const chart = panel.locator(WIDE);
      await expect(chart).toBeVisible();

      // Layer 1 — the HR band, downsampled at the model layer.
      await expect(chart.getByTestId("intraday-hr")).toBeVisible();
      // Layer 2 — the overnight session, clipped at midnight (it started 23:20
      // the previous day) with its deep-stage sub-band.
      await expect(chart.getByTestId("intraday-sleep-block")).toHaveCount(1);
      await expect(chart.getByTestId("intraday-sleep-stage")).toHaveCount(1);
      // Layer 3 — the two windowed sessions, ON THEIR OWN ROWS (#4852). The ride is
      // Train's, the morning sauna is Practice's; same shape and colour, different
      // line, because a workout and a sauna stacked together read as one thing.
      const blocks = chart.getByTestId("intraday-block");
      await expect(blocks).toHaveCount(2);
      await expect(
        chart.locator('[data-testid="intraday-block"][data-source="activity"]')
      ).toHaveAttribute("data-title", INTRADAY_ACTIVITY);
      await expect(
        chart.locator('[data-testid="intraday-block"][data-source="practice"]')
      ).toHaveAttribute("data-title", INTRADAY_PRACTICE);
      // Both rows are NAMED in the gutter…
      await expect(chart.locator('[data-row="Train"]')).toHaveCount(1);
      await expect(chart.locator('[data-row="Practice"]')).toHaveCount(1);
      // …and they are different LINES: the practice block's rect sits strictly
      // below the activity's, which is the whole of the ruling. Read off the drawn
      // rects rather than the row labels, because the block's placement is the
      // thing that used to be shared.
      const rowTops = await chart.evaluate((el) => {
        const y = (source: string) =>
          Number(
            el
              .querySelector(`[data-source="${source}"] rect`)
              ?.getAttribute("y")
          );
        return { activity: y("activity"), practice: y("practice") };
      });
      expect(rowTops.activity).toBeGreaterThan(0);
      expect(rowTops.practice).toBeGreaterThan(rowTops.activity);
      // Layer 5 — today only.
      await expect(chart.getByTestId("intraday-now")).toBeAttached();

      // Layer 4 — the tick rail. The two clock-timed document uploads are ticks;
      // the workout is drawn as a block, never double-drawn as a tick.
      const ticks = chart.getByTestId("intraday-tick");
      await expect(ticks).toHaveCount(2);

      // Chart as map, list as detail: the tick's fragment target IS the feed entry
      // rendered below, so tapping it scrolls the list to that entry.
      const morningTick = ticks.first(); // first-ok: ticks are time-ordered and spec-owned; 07:15 is the earliest
      const href = await morningTick.getAttribute("href");
      // `feed:` is the record's namespace for a re-housed timeline event (a timeline
      // event id and a Logs row id both spell `body:12`), and the tick is built from
      // the SAME id the row is, so the two cannot drift into different anchors.
      expect(href).toMatch(/^#timeline-entry-feed-document-\d+$/);

      const target = member.locator(href!);
      await expect(target).toContainText(INTRADAY_TICK_DOC);
      // followLink, not a bare click: the fragment navigation is subject to the
      // same pre-hydration swallow as any other link (#500/#830), so the helper
      // retries until the URL commits AND holds.
      await followLink(member, morningTick, new RegExp(`${href!.slice(1)}$`));
      await expect(target).toBeInViewport();
    } finally {
      await member.context().close();
    }
  });

  // #1512 A + B. The two things a person actually reads off a day chart were in
  // the model all along and reached only the SVG `<title>` tooltip, which a touch
  // device never shows.
  test("labels the wake time and names the activity block", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await openFixtureDay(member);
      const chart = member.getByTestId("intraday-panel").locator(WIDE);
      await expect(chart).toBeVisible();

      // The fixture's session ran 23:20 (yesterday) → 06:35. The START edge is
      // CLIPPED — it bled in from the previous day — so it carries no bed time:
      // stamping midnight on it would be an invented fact. The wake edge does.
      const times = chart.getByTestId("intraday-sleep-time");
      await expect(times).toHaveCount(1);
      await expect(times).toHaveAttribute("data-edge", "wake");
      await expect(times).toHaveText(/6:35/);

      // The 08:00–09:00 ride is named inside its own block (elided to the block's
      // width), so a 45-minute run and a 45-minute lift are no longer identical
      // rectangles. Since #4852 the morning practice carries its own name on its
      // own row — and names are placed PER ROW, so neither can drop the other.
      const names = chart.getByTestId("intraday-block-name");
      await expect(names).toHaveCount(2);
      const drawn = (await names.allTextContents()).map((t) =>
        t.replace("…", "")
      );
      expect(drawn.every((t) => t.length > 0)).toBe(true);
      expect(
        drawn.some((t) => INTRADAY_ACTIVITY.startsWith(t)) &&
          drawn.some((t) => INTRADAY_PRACTICE.startsWith(t))
      ).toBe(true);
    } finally {
      await member.context().close();
    }
  });

  // #1515 B/C/D. The interaction layer is ADDITIVE: the chart above is complete
  // before any of this runs.
  test("scrubs with the keyboard and zooms to an activity block", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await openFixtureDay(member);
      const chart = member.getByTestId("intraday-panel").locator(WIDE);
      await expect(chart).toBeVisible();

      const readout = chart.getByTestId("intraday-readout");
      // The live region exists (and is empty) BEFORE the first scrub, so the first
      // announcement is not swallowed.
      await expect(readout).toBeAttached();
      await expect(readout).toHaveText("");

      // Keyboard cursor: the values are reachable without a pointer at all.
      await chart.getByTestId("intraday-svg").focus();
      await member.keyboard.press("Home");
      await expect(chart.getByTestId("intraday-cursor")).toBeAttached();
      await expect(readout).not.toHaveText("");
      await member.keyboard.press("ArrowRight");
      await expect(readout).not.toHaveText("");

      // Tapping the block selects its window. The anchor is still the
      // pre-hydration fallback, so this asserts the ENHANCED behavior. Scoped to
      // the Train row's block: the day carries a practice block too since #4852.
      await chart
        .locator('[data-testid="intraday-block"][data-source="activity"]')
        .click();
      await expect(chart).toHaveAttribute("data-zoomed", "true");
      const reset = chart.getByTestId("intraday-zoom-reset");
      await expect(reset).toBeVisible();

      // The finer series replaces the 5-minute line IN PLACE — no loading box ever
      // appears, and the HR layer stays drawn throughout.
      await expect(chart.getByTestId("intraday-hr")).toBeVisible();
      await expect
        .poll(async () =>
          chart.getByTestId("intraday-hr").getAttribute("data-resolution")
        )
        .toBe("minute");

      // Ephemeral: the reset returns the whole day, and so does a reload.
      await reset.click();
      await expect(chart).toHaveAttribute("data-zoomed", "false");
      await member.reload();
      await expect(
        member.getByTestId("intraday-panel").locator(WIDE)
      ).toHaveAttribute("data-zoomed", "false");
    } finally {
      await member.context().close();
    }
  });

  // #4852 — WHEEL ZOOM, AND THE ONE EXCEPTION THAT KEEPS IT FROM BEING A TRAP.
  // A chart that swallows every wheel is a chart a reader cannot scroll past, so
  // both directions at the full day are asserted, and the scroll-through case
  // FIRST: once the chart is zoomed the trap is invisible.
  test("the wheel zooms about the pointer, pans, and lets the page scroll at full day", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await openFixtureDay(member);
      const chart = member.getByTestId("intraday-panel").locator(WIDE);
      await expect(chart).toBeVisible();
      // WAIT FOR THE CONTENT, not the box: the wheel target is the drawing, and a
      // window read before the layers land is a claim about an empty frame.
      await expect(chart.getByTestId("intraday-hr")).toBeVisible();
      const fullDay = { from: "0", to: "1440" };
      await expect(chart).toHaveAttribute("data-view-from", fullDay.from);
      await expect(chart).toHaveAttribute("data-view-to", fullDay.to);

      const svg = chart.getByTestId("intraday-svg");
      await svg.scrollIntoViewIfNeeded();
      const overChart = async () => {
        const box = (await svg.boundingBox())!;
        await member.mouse.move(
          box.x + box.width / 2,
          box.y + box.height * 0.6
        );
      };

      // ZOOM OUT AT THE FULL DAY: nothing to widen, so the page keeps the wheel.
      await overChart();
      const before = await member.evaluate(() => window.scrollY);
      await member.mouse.wheel(0, 500);
      await expect
        .poll(() => member.evaluate(() => window.scrollY))
        .toBeGreaterThan(before);
      await expect(chart).toHaveAttribute("data-zoomed", "false");
      await expect(chart).toHaveAttribute("data-view-to", fullDay.to);

      // ZOOM IN ABOUT THE POINTER: aimed at the 07:15 tick, the window narrows
      // AROUND that minute rather than around the middle of the day — and the page
      // does NOT move, which is the preventDefault half of the ruling.
      const morningTick = chart.getByTestId("intraday-tick").first(); // first-ok: ticks are time-ordered and spec-owned; 07:15 is the earliest
      const tickBox = (await morningTick.boundingBox())!;
      const anchorX = tickBox.x + tickBox.width / 2;
      const settled = await member.evaluate(() => window.scrollY);
      for (let i = 0; i < 3; i++) {
        const box = (await svg.boundingBox())!;
        await member.mouse.move(anchorX, box.y + box.height * 0.6);
        await member.mouse.wheel(0, -400);
      }
      await expect(chart).toHaveAttribute("data-zoomed", "true");
      expect(await member.evaluate(() => window.scrollY)).toBe(settled);
      const zoomed = await readWindow(chart);
      expect(zoomed.to - zoomed.from).toBeLessThan(360);
      // 07:15 is minute 435. The pointer's minute stayed inside the window it
      // produced — an unanchored zoom about the day's centre could not.
      expect(zoomed.from).toBeLessThanOrEqual(435);
      expect(zoomed.to).toBeGreaterThanOrEqual(435);

      // HORIZONTAL WHEEL PANS a zoomed view: the window slides and its SPAN is the
      // one thing that may not change.
      const box = (await svg.boundingBox())!;
      await member.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
      await member.mouse.wheel(300, 0);
      await expect
        .poll(async () => (await readWindow(chart)).from)
        .toBeGreaterThan(zoomed.from);
      const panned = await readWindow(chart);
      expect(panned.to - panned.from).toBe(zoomed.to - zoomed.from);

      // Escape still returns the whole day — the gesture layer added a way IN, not
      // a second way out.
      await svg.focus();
      await member.keyboard.press("Escape");
      await expect(chart).toHaveAttribute("data-zoomed", "false");
      await expect(chart).toHaveAttribute("data-view-from", fullDay.from);
      await expect(chart).toHaveAttribute("data-view-to", fullDay.to);
    } finally {
      await member.context().close();
    }
  });

  // #4852 — A ctrlKey WHEEL IS A TRACKPAD PINCH, AND IT NEVER REACHES THE BROWSER
  // (PM ruling, 2026-09-03). Both directions, every zoom level. The scroll-through
  // exception the test above proves is about PLAIN wheels only: an unhandled plain
  // wheel scrolls, which is the thing a reader needs to get past a tall chart,
  // whereas an unhandled ctrlKey wheel PAGE-ZOOMS, which nobody asked for.
  //
  // Cancellation is asserted on a dispatched event because that is the claim
  // itself: `dispatchEvent` returns false exactly when a listener called
  // preventDefault, so the plain/ctrlKey pair is read off one mechanism at one
  // zoom level instead of inferred from what the viewport did afterwards. The real
  // ctrl+wheel below then proves it end to end through the browser's own input
  // path — where the listener has to be non-passive for any of it to be true.
  test("a ctrlKey wheel is always swallowed, where a plain one is handed back", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await openFixtureDay(member);
      const chart = member.getByTestId("intraday-panel").locator(WIDE);
      await expect(chart).toBeVisible();
      await expect(chart.getByTestId("intraday-hr")).toBeVisible();
      await expect(chart).toHaveAttribute("data-view-from", "0");
      await expect(chart).toHaveAttribute("data-view-to", "1440");

      const svg = chart.getByTestId("intraday-svg");
      await svg.scrollIntoViewIfNeeded();

      // `false` means a listener called preventDefault — the page never sees it.
      const wheel = (deltaY: number, ctrlKey: boolean) =>
        svg.evaluate(
          (el, { deltaY: dy, ctrlKey: ctrl }) => {
            const box = el.getBoundingClientRect();
            return el.dispatchEvent(
              new WheelEvent("wheel", {
                deltaY: dy,
                ctrlKey: ctrl,
                clientX: box.x + box.width / 2,
                clientY: box.y + box.height * 0.6,
                bubbles: true,
                cancelable: true,
              })
            );
          },
          { deltaY, ctrlKey }
        );

      // AT THE FULL DAY, BOTH DIRECTIONS. Zooming out moves nothing here — that is
      // precisely the case the plain-wheel exception releases and this one does not.
      expect(await wheel(500, true)).toBe(false);
      await expect(chart).toHaveAttribute("data-view-to", "1440");
      expect(await wheel(-400, true)).toBe(false);
      await expect(chart).toHaveAttribute("data-zoomed", "true");

      // AND AT A ZOOMED LEVEL, out to the full day and back in again: "every zoom
      // level" is the half of the ruling a full-day-only test would not carry.
      expect(await wheel(500, true)).toBe(false);
      expect(await wheel(-400, true)).toBe(false);

      // THE CONTRAST. Back at the full day a PLAIN zoom-out is handed to the page,
      // which is what keeps a reader able to scroll past the chart at all.
      await chart.getByTestId("intraday-zoom-reset").click();
      await expect(chart).toHaveAttribute("data-zoomed", "false");
      expect(await wheel(500, false)).toBe(true);
      await expect(chart).toHaveAttribute("data-view-to", "1440");

      // END TO END through the browser's own input path: a real ctrl+wheel at the
      // full day moves nothing, scrolls nothing, and — the behaviour the ruling
      // exists to remove — does not zoom the PAGE, which is what an unhandled one
      // does and what `devicePixelRatio` would report.
      const box = (await svg.boundingBox())!;
      await member.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
      const before = await member.evaluate(() => ({
        scrollY: window.scrollY,
        dpr: window.devicePixelRatio,
      }));
      await member.keyboard.down("Control");
      await member.mouse.wheel(0, 500);
      await member.keyboard.up("Control");
      await expect(chart).toHaveAttribute("data-view-to", "1440");
      expect(await member.evaluate(() => window.scrollY)).toBe(before.scrollY);
      expect(await member.evaluate(() => window.devicePixelRatio)).toBe(
        before.dpr
      );
    } finally {
      await member.context().close();
    }
  });

  // #1573 — the guard the element-level containment walk cannot provide: an SVG
  // <text> painting past its own plot still sits inside an <svg> box that fits.
  test("no chart label paints outside its plot, and none is micro-type", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await openFixtureDay(member);
      await expect(
        member.getByTestId("intraday-panel").locator(WIDE)
      ).toBeVisible();
      await expectSvgTextInsidePlot(member);
      // And #1518's half: a label in the right PLACE is still useless at 3.5px.
      await expectSvgTextLegible(member);
    } finally {
      await member.context().close();
    }
  });

  // #4767 item 2 — the dashboard mount. The chart is the SAME component and the
  // SAME day model; what this pins is that it is present on `/`, that it carries
  // the day's own causes (the shaded ride window), that the row states the lag in
  // the same words the panel does, and that tapping it lands on the panel.
  test("the dashboard's Today band draws today's chart and doors to the panel", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/");
      // THE FAMILY, NOT THE MEMBER (#4969): the chart mounts on the Day-so-far
      // family row now, alongside this fixture's own last-night sleep members —
      // there is no single-purpose "intraday-today" family left to scope to.
      const family = member.locator('[data-standing-family="day-so-far"]');
      await expect(family).toBeVisible();
      // It is in TODAY and nowhere else — the band the issue names.
      await expect(
        member
          .locator('[data-standing-section="today"]')
          .locator('[data-standing-family="day-so-far"]')
      ).toHaveCount(1);

      // The figure, in the compact geometry the day view's phone variant uses —
      // one implementation, selected by the prop that file already had. It is the
      // FAMILY's drawing now, not the member's — rendered once under every
      // member's facts rather than inside the intraday candidate's own `<li>`.
      const figure = family.getByTestId("dashboard-family-figure");
      const chart = figure.locator('[data-variant="compact"]');
      await expect(chart).toBeVisible();
      // WAIT FOR THE CONTENT, NOT THE BOX: the HR band is what makes this a chart
      // rather than an axis, and it is the layer the presence gate is about.
      await expect(chart.getByTestId("intraday-hr")).toBeVisible();
      // The seeded ride's window, shaded on the axis — the AC's "shaded window" —
      // beside the morning practice's on the row below it (#4852).
      await expect(chart.getByTestId("intraday-block")).toHaveCount(2);

      // The lag sentence, on the intraday member's OWN facts — scoped to that one
      // candidate, because the family now also carries the night's sleep members,
      // each with their own `standing-value`.
      const rowValue = family
        .locator('[data-candidate-id^="activity.intraday:"]')
        .getByTestId("standing-value");
      await expect(rowValue).toHaveText(/^Synced .+ ago$/);
      const dashboardLag = (await rowValue.textContent())!.trim();

      // THE WHOLE ROW IS ONE DOOR, THE CHART INCLUDED — a decision, so it is
      // MEASURED. RETARGETED FROM THE MEMBER'S LINK TO THE FAMILY ROW (#4969):
      // the door that reaches under the figure is whichever member's link the
      // family elects primary (`.standing-primary`, the first member in display
      // order that carries an href) — no longer necessarily the intraday
      // candidate's own, now that the family also carries the night's sleep
      // members ahead of it. The row's link carries `standing-stretch`, whose
      // `::after` insets to the WHOLE family's relatively-positioned box — which
      // is why this reaches the figure at all, sitting below every member's `<li>`
      // in the very same box — so a pointer anywhere on the drawing lands on a
      // door. That is what this mount is for ("tap → today's day view", by way of
      // whichever door the row currently surfaces), and it is why the figure is
      // `inert` — the chart's own tick anchors name `#timeline-entry-…` fragments
      // that exist on the day view and NOT here, so without it the keyboard would
      // reach a link that scrolls nowhere while the pointer could not.
      //
      // NOT asserted with a click: Playwright refuses to click an element that
      // another element intercepts, so `click(chart)` fails whether the figure is
      // correctly covered by the door or simply broken. This asks the question the
      // behaviour is actually about.
      const doorReach = await family.evaluate((el) => {
        const plot = el.querySelector(
          '[data-variant="compact"]'
        ) as HTMLElement | null;
        const door = el.querySelector(
          "a.standing-primary"
        ) as HTMLElement | null;
        if (!plot || !door)
          return { hitInsideDoor: false, ticks: 0, focusable: true };
        const box = plot.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2
        );
        // Through the FIGURE's own anchors — the ones this chart actually renders,
        // not a fresh query written to check the work.
        const ticks = Array.from(
          el.querySelectorAll<HTMLElement>(
            '[data-testid="dashboard-family-figure"] a[href^="#"]'
          )
        );
        const focusable = ticks.some((tick) => {
          tick.focus();
          return document.activeElement === tick;
        });
        return {
          hitInsideDoor: door.contains(hit),
          ticks: ticks.length,
          focusable,
        };
      });
      // The control that keeps the focus claim from being vacuous: the figure really
      // does render tick anchors, so "none is focusable" is about something.
      expect(doorReach.ticks).toBeGreaterThan(0);
      expect(doorReach.hitInsideDoor).toBe(true);
      expect(doorReach.focusable).toBe(false);

      await followLink(
        member,
        // Keyed on the DESTINATION, not on position.
        family.locator('a[href*="day-at-a-glance"]'),
        /\/history\?day=\d{4}-\d{2}-\d{2}#day-at-a-glance/
      );
      const panel = member.getByTestId("intraday-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toBeInViewport();
      await expect(panel.getByTestId("intraday-freshness")).toHaveText(
        dashboardLag
      );
    } finally {
      await member.context().close();
    }
  });

  test("is absent on a day with no intraday data", async ({ browser }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // Three days back the fixture profile has ONLY a weigh-in — a real feed
      // event with no clock time, no HR, no sleep, no windowed workout. The day
      // renders; the panel is data-gated away (no empty frame).
      await member.goto("/history");
      const dayIds = await member
        .locator("[id^='timeline-day-']")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.id.replace("timeline-day-", ""))
        );
      const quiet = dayIds.at(-1)!;

      await member.goto(`/history?day=${quiet}`);
      // THE POSITIVE CONTROL, RE-POINTED. It named the heading "Body metrics logged"
      // — `/timeline`'s card title for its day-aggregate body event. The record reads
      // body natively as its own Logs kind (one row per reading, titled by the
      // measure, one line and therefore no heading), so that locator now resolves to
      // nothing and "the panel is absent" would have passed on a page that rendered
      // no day at all. Keyed on the row's kind, which is what the day is being
      // asserted to contain.
      await expect(
        member.locator('[data-testid="history-row"][data-history-kind="body"]')
      ).not.toHaveCount(0);
      await expect(member.getByTestId("intraday-panel")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});

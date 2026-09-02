import { test, expect } from "./fixtures";
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
      // Layer 3 — the windowed ride. The block layer is not workout-only since
      // #3142; this profile logs no practice, so the ride is still the only block.
      const workout = chart.getByTestId("intraday-block");
      await expect(workout).toHaveCount(1);
      await expect(workout).toHaveAttribute("data-title", INTRADAY_ACTIVITY);
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
      // rectangles.
      const name = chart.getByTestId("intraday-block-name");
      await expect(name).toHaveCount(1);
      const drawn = (await name.textContent())!.replace("…", "");
      expect(drawn.length).toBeGreaterThan(0);
      expect(INTRADAY_ACTIVITY.startsWith(drawn)).toBe(true);
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
      // pre-hydration fallback, so this asserts the ENHANCED behavior.
      await chart.getByTestId("intraday-block").click();
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
      const family = member.locator('[data-standing-family="intraday-today"]');
      await expect(family).toBeVisible();
      // It is in TODAY and nowhere else — the band the issue names.
      await expect(
        member
          .locator('[data-standing-section="today"]')
          .locator('[data-standing-family="intraday-today"]')
      ).toHaveCount(1);

      // The figure, in the compact geometry the day view's phone variant uses —
      // one implementation, selected by the prop that file already had.
      const figure = family.getByTestId("dashboard-row-figure");
      const chart = figure.locator('[data-variant="compact"]');
      await expect(chart).toBeVisible();
      // WAIT FOR THE CONTENT, NOT THE BOX: the HR band is what makes this a chart
      // rather than an axis, and it is the layer the presence gate is about.
      await expect(chart.getByTestId("intraday-hr")).toBeVisible();
      // The seeded ride's window, shaded on the axis — the AC's "shaded window".
      await expect(chart.getByTestId("intraday-block")).toHaveCount(1);

      // The lag sentence, on the row's own facts. Compared against the PANEL's
      // rather than against a literal: both mounts read one `intradayFreshness`
      // over one model, so a drift between them is the only failure worth
      // catching here — and the run's frozen clock moves the minute, not the
      // sentence's construction.
      const rowValue = family.getByTestId("standing-value");
      await expect(rowValue).toHaveText(/^Synced .+ ago$/);
      const dashboardLag = (await rowValue.textContent())!.trim();

      // THE WHOLE ROW IS ONE DOOR, THE CHART INCLUDED — a decision, so it is
      // MEASURED. The row's link carries `standing-stretch`, whose `::after` insets
      // to the family's facts cell, and the figure renders inside that cell: a
      // pointer anywhere on the drawing lands on the door. That is what this mount
      // is for ("tap → today's day view"), and it is why the figure is `inert` —
      // the chart's own tick anchors name `#timeline-entry-…` fragments that exist
      // on the day view and NOT here, so without it the keyboard would reach a link
      // that scrolls nowhere while the pointer could not.
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
          'a[href*="day-at-a-glance"]'
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
            '[data-testid="dashboard-row-figure"] a[href^="#"]'
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

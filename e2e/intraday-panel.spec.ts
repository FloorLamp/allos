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
  await page.goto("/timeline");
  const date = (await page
    .locator("[id^='timeline-day-']")
    .first() // first-ok: spec-owned profile, newest day is the fixture's today
    .getAttribute("id"))!.replace("timeline-day-", "");
  await page.goto(`/timeline?from=${date}&to=${date}`);
  return date;
}

test.describe("Timeline intraday panel (#1068)", () => {
  test("renders the day's layers and a tick jumps to its feed entry", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Timeline route on first hit

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
      // Layer 3 — the windowed ride.
      const workout = chart.getByTestId("intraday-workout");
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
      expect(href).toMatch(/^#timeline-entry-document-\d+$/);

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
      const name = chart.getByTestId("intraday-workout-name");
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
      await chart.getByTestId("intraday-workout").click();
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
      await member.goto("/timeline");
      const dayIds = await member
        .locator("[id^='timeline-day-']")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.id.replace("timeline-day-", ""))
        );
      const quiet = dayIds.at(-1)!;

      await member.goto(`/timeline?from=${quiet}&to=${quiet}`);
      await expect(
        member.getByRole("heading", { name: "Body metrics logged" })
      ).toBeVisible();
      await expect(member.getByTestId("intraday-panel")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});

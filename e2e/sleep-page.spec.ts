import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Flip a Settings → Preferences select and wait for the autosave to LAND. The card
// shows a "Saved" check only after the Server Action's write commits, so gating on
// it can't race an uncommitted write (mirrors date-time-format-prefs.spec's helper).
async function selectAndSave(
  page: Page,
  testId: string,
  value: string
): Promise<void> {
  await page.getByTestId(testId).selectOption(value);
  await expect(page.getByLabel("Saved")).toBeVisible();
}

// The dedicated Sleep page (issue #1066). Profile 1 (the seeded admin) has the
// #160 SRI nights + the #1066 stage/nap fixture (e2e/seed-events.ts), so the page
// renders its hero and every section, the nav entry is present (data-gated), and
// the dashboard "last night" tile links through. The child fixture profile has NO
// sleep data, so it proves the nav gate hides the entry.
//
// Reads only; drives no writes on the shared profile-1 session, so it can't
// disturb neighbors.

test.describe("Sleep page (#1066)", () => {
  test("renders the last-night hero and every section on a sleep-seeded profile", async ({
    page,
  }) => {
    await page.goto("/sleep");

    const main = page.getByRole("main");

    // Hero: duration + the SEPARATE nap line (never summed into the night, #1118).
    const hero = main.getByTestId("sleep-hero");
    await expect(hero).toBeVisible();
    const duration = hero.getByTestId("sleep-hero-duration");
    await expect(duration).toBeVisible();
    const durationText = (await duration.innerText()).trim();
    // The seeded last night is a 5h overnight (23:00 → 04:00) — NOT 5h45m, which
    // is what a nap-summed total would read. The nap is its own line.
    expect(durationText).toBe("5h");
    const nap = hero.getByTestId("sleep-hero-nap");
    await expect(nap).toBeVisible();
    await expect(nap).toContainText("nap");
    await expect(nap).toContainText("45m");

    // The hero deep-links to the night's Timeline view ("see in day context").
    await expect(hero.getByTestId("sleep-hero-day-link")).toBeVisible();

    // Regularity (SRI) card — the same computation the healthspan pillar reads.
    const sri = main.getByTestId("sri-value");
    await expect(sri).toBeVisible();
    const sriValue = Number((await sri.innerText()).trim());
    expect(Number.isFinite(sriValue)).toBe(true);

    // Consistency strip + stage composition render on the seeded fixture.
    await expect(main.getByTestId("sleep-consistency")).toBeVisible();
    await expect(main.getByTestId("sleep-stages")).toBeVisible();
  });

  test("renders the attributed Oura vendor scores, never as the app's own (#1069)", async ({
    page,
  }) => {
    await page.goto("/sleep");
    const main = page.getByRole("main");

    // The "From Oura" section is present, labeled by the vendor (attribution, not
    // assessment) — a display-only value that feeds no engine.
    const scores = main.getByTestId("oura-scores");
    await expect(scores).toBeVisible();

    const sleepTile = scores.getByTestId("oura-sleep-score");
    await expect(sleepTile).toBeVisible();
    // Copy names the vendor — never a bare "sleep score".
    await expect(sleepTile).toContainText("Oura sleep score");
    // Latest = today's seeded score (78), out of 100.
    await expect(scores.getByTestId("oura-sleep-score-value")).toHaveText("78");

    const readinessTile = scores.getByTestId("oura-readiness-score");
    await expect(readinessTile).toBeVisible();
    await expect(readinessTile).toContainText("Oura readiness");
    await expect(scores.getByTestId("oura-readiness-score-value")).toHaveText(
      "70"
    );

    // Attribution footnote: Oura's proprietary score, not the app's own.
    await expect(scores).toContainText("proprietary");
  });

  test("the Sleep nav entry is present for a sleep-tracking profile", async ({
    page,
  }) => {
    await page.goto("/");
    // The shared SidebarContent renders <Nav> in BOTH the desktop sidebar and the
    // mobile drawer (#794), so the /sleep href appears in two <nav>s in the DOM.
    const sleepNav = page.locator('nav a[href="/sleep"]').first(); // first-ok: shared responsive nav rendered in both viewports; either instance proves the gated leaf is present
    await expect(sleepNav).toBeVisible();
  });

  test("the dashboard last-night tile renders and links to the Sleep page", async ({
    page,
  }) => {
    await page.goto("/");
    const tile = page.getByTestId("sleep-last-night-widget");
    await expect(tile).toBeVisible();

    // The tile reads the SAME model as the hero — its duration matches.
    const tileDuration = (
      await tile.getByTestId("sleep-last-night-duration").innerText()
    ).trim();
    expect(tileDuration).toBe("5h");

    // The tile's header link points at the full page.
    await expect(
      tile.getByRole("link", { name: /last night/i })
    ).toHaveAttribute("href", "/sleep");
  });

  test("the nav gate HIDES the entry for a profile with no sleep data", async ({
    browser,
  }) => {
    // The child fixture profile has no sleep sessions → the sleep relevance bit is
    // false → the nav leaf is hidden. Isolated login context so it never touches
    // the shared admin session's active profile.
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      // A visible surface proves the shell rendered…
      const timeline = page
        .getByRole("link", { name: "Timeline", exact: true })
        .first(); // first-ok: shared responsive nav leaf rendered in both viewports; first instance confirms the shell mounted
      await expect(timeline).toBeVisible();
      // …and the Sleep leaf is absent for this sleep-less profile (both navs).
      await expect(page.locator('nav a[href="/sleep"]')).toHaveCount(0);

      // The Sleep page renders no Oura scores for a profile without Oura data —
      // absence renders nothing (#1069, the absent-value rule).
      await page.goto("/sleep");
      await expect(
        page.getByRole("main").getByTestId("oura-scores")
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("chart tooltips render ROUNDED values, never raw unit-converted floats (#1162)", async ({
    page,
  }) => {
    await page.goto("/sleep");
    const main = page.getByRole("main");

    // Stage composition stacked bar: the page feeds bare minute→hour conversions
    // (r.deep / 60), so a 92-min stage is 1.5333… h. With decimals=1 the tooltip
    // reads a SHORT rounded number ("1.5 h"), never the raw float — the StackedBar
    // twin of the #403 LineChart fix (StackedBarCardInner used to skip it).
    const stagesCard = main.getByTestId("sleep-stages");
    await expect(stagesCard).toBeVisible();
    // Hover a bar directly: a recharts BarChart opens its tooltip only when the
    // pointer is over a bar element (not the plot area), so drive it with the
    // element's own .hover() and re-hover per attempt until the tooltip renders.
    const stageBar = stagesCard.locator(".recharts-bar-rectangle").first(); // first-ok: the first (deep) bar in the spec-owned stage chart; hovering any bar opens the same stacked tooltip
    await stageBar.waitFor({ state: "attached", timeout: 15_000 });
    const stageTip = stagesCard.locator(".recharts-tooltip-wrapper");
    await expect(async () => {
      await page.mouse.move(5, 5); // leave the chart so the next hover re-enters
      await stageBar.hover();
      const txt = (await stageTip.innerText()).trim();
      expect(txt).toContain("h");
      // No raw unit conversion: nowhere a number with 2+ decimals (e.g. 1.5333333).
      expect(txt).not.toMatch(/\d\.\d{2,}/);
    }).toPass({ timeout: 15_000 }); // topass-ok: recharts opens the tooltip only after a hover mousemove — re-hover per attempt, no single awaitable render event

    // SRI trend line: decimals=0 so the tooltip is an INTEGER — like the headline
    // (which is Math.round(sri)), never the raw "87 vs 87.34" mismatch #403 named.
    const sriCard = main.getByTestId("sleep-regularity");
    const sriDot = sriCard.locator(".recharts-dot").first(); // first-ok: any point on the spec-owned SRI trend line opens the same tooltip
    await sriDot.waitFor({ state: "attached", timeout: 15_000 });
    const sriTip = sriCard.locator(".recharts-tooltip-wrapper");
    await expect(async () => {
      await page.mouse.move(5, 5);
      await sriDot.hover();
      const txt = (await sriTip.innerText()).trim();
      expect(txt).toContain("SRI");
      // Integer only — never a fractional SRI in the tooltip.
      expect(txt).not.toMatch(/\d\.\d/);
    }).toPass({ timeout: 15_000 }); // topass-ok: recharts opens the tooltip only after a hover mousemove — re-hover per attempt, no single awaitable render event
  });

  test("clock times follow the login's 12h/24h pref on the hero + consistency strip (#1163)", async ({
    page,
  }) => {
    try {
      // Default (24h): the seeded main session (23:00 → 04:00 local) renders as a
      // 24-hour clock, and the consistency strip carries no AM/PM.
      await page.goto("/sleep");
      const main = page.getByRole("main");
      const hero = main.getByTestId("sleep-hero");
      await expect(hero).toContainText("23:00");
      await expect(hero).toContainText("04:00");
      const strip = main.getByTestId("sleep-consistency");
      await expect(strip).toBeVisible();
      await expect(strip).not.toContainText("PM");

      // Flip the login's clock to 12h on Settings → Preferences (autosave on change).
      await page.goto("/settings");
      await selectAndSave(page, "time-format-select", "12h");
      await expect(page.getByTestId("time-format-select")).toHaveValue("12h");

      // The SAME values now render 12-hour on BOTH surfaces — the pure model emits
      // time numbers, formatClock at the render layer picks the convention (#1163).
      await page.goto("/sleep");
      const hero12 = page.getByRole("main").getByTestId("sleep-hero");
      await expect(hero12).toContainText("11:00 PM");
      await expect(hero12).toContainText("4:00 AM");
      await expect(
        page.getByRole("main").getByTestId("sleep-consistency")
      ).toContainText("PM");
    } finally {
      // Restore the default so the shared admin login preference doesn't leak.
      await page.goto("/settings");
      await selectAndSave(page, "time-format-select", "24h");
      await expect(page.getByTestId("time-format-select")).toHaveValue("24h");
    }
  });

  test("the Sleep page body does not scroll sideways at phone width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/sleep");
    await expect(page.getByTestId("sleep-hero")).toBeVisible();
    const noBodyScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    );
    expect(noBodyScroll).toBe(true);
  });
});

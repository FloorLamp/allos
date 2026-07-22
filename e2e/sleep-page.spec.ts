import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_CHILD,
  E2E_LOGIN_SLEEP_EDIT,
  E2E_MEMBER_PASSWORD,
  SLEEP_EDIT_PROFILE,
} from "./fixture-logins";
import { settledClick } from "./helpers";

const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

function sleepEditProfileId(handle: Database.Database): number {
  return (
    handle
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(SLEEP_EDIT_PROFILE) as { id: number }
  ).id;
}

function clearSleepEditFixture(): void {
  const handle = new Database(DB_PATH);
  try {
    const profileId = sleepEditProfileId(handle);
    handle.prepare("DELETE FROM mood_logs WHERE profile_id = ?").run(profileId);
    handle
      .prepare("DELETE FROM metric_samples WHERE profile_id = ?")
      .run(profileId);
    handle
      .prepare(
        "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'metric_source_priority'"
      )
      .run(profileId);
  } finally {
    handle.close();
  }
}

function resetSleepEditFixture(): void {
  clearSleepEditFixture();
  const handle = new Database(DB_PATH);
  try {
    const profileId = sleepEditProfileId(handle);
    const manualDate = new Date(Date.now() - 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const importedDate = new Date(Date.now() - 4 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    handle
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, metric, date, start_time, end_time, value)
         VALUES (?, 'manual', 'sleep_min', ?, ?, ?, 420)`
      )
      .run(
        profileId,
        manualDate,
        `${manualDate}T00:00:00`,
        `${manualDate}T00:00:00`
      );
    handle
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, metric, date, start_time, end_time, value)
         VALUES (?, 'oura', 'sleep_min', ?, ?, ?, 390)`
      )
      .run(
        profileId,
        importedDate,
        `${importedDate}T00:00:00`,
        `${importedDate}T06:30:00`
      );
    handle
      .prepare(
        `INSERT INTO mood_logs
           (profile_id, date, valence, energy, anxiety, factors, notes)
         VALUES (?, ?, 2, 3, 4, '["work"]', 'keep this detail')`
      )
      .run(profileId, manualDate);
    // Keep the timed Oura stream authoritative for sleep timing. The manual row
    // remains in the history editor, while this one timed night renders
    // consistency without crossing the 14-night SRI gate.
    handle
      .prepare(
        `INSERT INTO profile_settings (profile_id, key, value)
         VALUES (?, 'metric_source_priority', '{"sleep_min":"oura"}')`
      )
      .run(profileId);
  } finally {
    handle.close();
  }
}

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
    // The fixture's latest wake-day is TODAY. Issue #1186 makes "Last night" a
    await expect(hero.getByTestId("sleep-hero-label")).toContainText("Today");
    await expect(hero.getByTestId("sleep-hero-label")).not.toContainText(
      "Last night"
    );
    const duration = hero.getByTestId("sleep-hero-duration");
    await expect(duration).toBeVisible();
    const durationText = (await duration.innerText()).trim();
    // The seeded last night is a 5h overnight (23:00 → 04:00) — NOT 5h45m, which
    // is what a nap-summed total would read. The nap is its own line.
    expect(durationText).toBe("5h");
    const nap = hero.getByTestId("sleep-hero-nap");
    await expect(nap).toBeVisible();
    await expect(nap).toHaveText("+ 45m nap (counted separately)");
    const source = hero.getByTestId("sleep-hero-source");
    await expect(source).toHaveText("Logged manually");
    await expect(source).toHaveClass(/text-\[11px\]/);
    const bedtimeSupplements = hero.getByTestId(
      "sleep-hero-bedtime-supplements"
    );
    await expect(bedtimeSupplements).toContainText(
      "Bedtime supplements · All taken (Magnesium Glycinate)"
    );
    await expect(
      bedtimeSupplements.getByTestId("bedtime-supplement-status-summary")
    ).toHaveCount(0);

    // The hero deep-links to the night's Timeline view ("see in day context").
    await expect(hero.getByTestId("sleep-hero-day-link")).toBeVisible();

    // Regularity (SRI) card — the same computation the healthspan pillar reads.
    const sri = main.getByTestId("sri-value");
    await expect(sri).toBeVisible();
    const sriValue = Number((await sri.innerText()).trim());
    expect(Number.isFinite(sriValue)).toBe(true);

    // Consistency strip + stage composition render on the seeded fixture.
    const consistency = main.getByTestId("sleep-consistency");
    await expect(consistency).toBeVisible();
    const [durationBox, stagesBox, regularityBox, consistencyBox] =
      await Promise.all([
        main.getByTestId("sleep-duration-trend").boundingBox(),
        main.getByTestId("sleep-stages").boundingBox(),
        main.getByTestId("sleep-regularity").boundingBox(),
        consistency.boundingBox(),
      ]);
    expect(durationBox).not.toBeNull();
    expect(stagesBox).not.toBeNull();
    expect(regularityBox).not.toBeNull();
    expect(consistencyBox).not.toBeNull();
    // The four core cards use independent desktop stacks. Each lower card starts
    // one normal gap after the card above it instead of waiting for the taller
    // card in the neighboring column (the old row-grid dead space).
    expect(Math.abs(durationBox!.x - regularityBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(stagesBox!.x - consistencyBox!.x)).toBeLessThanOrEqual(1);
    expect(
      regularityBox!.y - (durationBox!.y + durationBox!.height)
    ).toBeGreaterThanOrEqual(20);
    expect(
      regularityBox!.y - (durationBox!.y + durationBox!.height)
    ).toBeLessThanOrEqual(28);
    expect(
      consistencyBox!.y - (stagesBox!.y + stagesBox!.height)
    ).toBeGreaterThanOrEqual(20);
    expect(
      consistencyBox!.y - (stagesBox!.y + stagesBox!.height)
    ).toBeLessThanOrEqual(28);
    // The high-signal default is 14 nights; the full history stays one tap away.
    await expect(
      consistency.getByTestId("sleep-consistency-night")
    ).toHaveCount(14);
    const offSchedule = consistency.locator(
      '[data-testid="sleep-consistency-night"][data-off-schedule="true"]'
    );
    expect(await offSchedule.count()).toBeGreaterThan(0);
    await expect(consistency).toContainText("Off schedule");
    await consistency.getByTestId("sleep-consistency-toggle").click();
    expect(
      await consistency.getByTestId("sleep-consistency-night").count()
    ).toBeGreaterThan(14);
    await expect(
      consistency.getByTestId("sleep-consistency-toggle")
    ).toHaveText("Show fewer");
    await expect(main.getByTestId("sleep-duration-trend")).toBeVisible();
    await expect(main.getByTestId("sleep-duration-trend")).toContainText(
      /\d+h(?: \d+m)? average/
    );
    let precedingObservationCount = 0;
    for (const range of [14, 30, 90]) {
      const button = main.getByTestId(`sleep-trend-range-${range}`);
      const observationCount = Number(
        await button.getAttribute("data-observation-count")
      );
      if (observationCount > precedingObservationCount) {
        await expect(button).toBeEnabled();
      } else {
        await expect(button).toBeDisabled();
      }
      precedingObservationCount = observationCount;
    }
    // Duration has one canonical chart. The relationship section reuses those
    // values for a correlation readout instead of plotting the same line again.
    await expect(
      main.getByRole("heading", { name: "Sleep duration", exact: true })
    ).toHaveCount(1);
    const sleepMoodSection = main.getByTestId("sleep-mood-section");
    const sleepMood = sleepMoodSection.getByTestId("sleep-mood");
    await expect(sleepMood).toBeVisible();
    await expect(sleepMoodSection).toHaveAttribute(
      "data-points",
      /^(?:[5-9]|[1-9]\d+)$/
    );
    await expect(sleepMood.getByText("Sleep (hours)")).toHaveCount(0);
    await expect(sleepMood.getByTestId("sleep-mood-correlation")).toBeVisible();
    await expect(sleepMood.getByTestId("scatter-chart")).toBeVisible();
    const pairedCount = Number(
      await sleepMoodSection.getAttribute("data-points")
    );
    const historyCount = Number(
      await sleepMoodSection.getAttribute("data-history-count")
    );
    expect(historyCount).toBeGreaterThanOrEqual(pairedCount);

    // History is its own flat section: the heading/helper sit above ONE table
    // card. It includes unpaired dates and pages the 60-day window 10 at a time.
    const sleepMoodLog = sleepMoodSection.getByTestId("sleep-mood-log");
    const logHeading = sleepMoodLog.getByRole("heading", {
      name: "Sleep and Mood Log",
    });
    const logHelper = sleepMoodLog.getByText(
      /^All available sleep, stage, and mood entries, with bedtime supplement context/
    );
    await expect(logHeading).toBeVisible();
    await expect(logHelper).toBeVisible();
    expect(
      await logHeading.evaluate((node) => node.closest(".card") === null)
    ).toBe(true);
    expect(
      await logHelper.evaluate((node) => node.closest(".card") === null)
    ).toBe(true);
    await expect(sleepMoodLog).toContainText("Past 60 days");
    const history = sleepMoodLog.getByTestId("sleep-mood-history");
    await expect(history).toBeVisible();
    await expect(history.locator("thead tr")).toHaveCount(1);
    for (const stage of ["Deep", "REM", "Light", "Awake"]) {
      await expect(
        history.getByRole("columnheader", { name: stage, exact: true })
      ).toBeVisible();
    }
    await expect(
      history.getByRole("columnheader", {
        name: "Supplements",
        exact: true,
      })
    ).toBeVisible();
    await expect(history).toContainText("1/1 taken");
    await expect(history).toContainText("0/1 taken");
    await expect(
      history.getByRole("columnheader", { name: "Deep", exact: true })
    ).toHaveClass(/border-l/);
    expect(
      (await history.getByTestId("sleep-stage-deep").allTextContents()).some(
        (value) => value.trim() !== "—"
      )
    ).toBe(true);
    expect(historyCount).toBeGreaterThan(10);
    await expect(history.getByTestId("sleep-mood-history-row")).toHaveCount(10);
    const pagination = sleepMoodLog.getByTestId("sleep-mood-pagination");
    await expect(pagination).toContainText(`Showing 1–10 of ${historyCount}`);
    await expect(pagination).toContainText("Page 1 of");
    await pagination.getByRole("button", { name: "Next" }).click();
    await expect(pagination).toContainText("Page 2 of");
    await expect(history.getByTestId("sleep-mood-history-row")).toHaveCount(
      Math.min(10, historyCount - 10)
    );
    await expect(main.getByTestId("sleep-stages")).toBeVisible();

    // Manual sleep and mood entry now stays in the context of this log.
    await expect(main.getByTestId("sleep-add-entry-header")).toHaveText(
      "Add entry"
    );
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
    await expect(scores).toContainText("not combined into an Allos assessment");

    // Source-reported scores follow the app-derived schedule insights instead
    // of interrupting the primary duration → regularity → consistency story.
    expect(
      await main
        .locator(
          '[data-testid="sleep-regularity"], [data-testid="sleep-consistency"], [data-testid="oura-scores"]'
        )
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-testid"))
        )
    ).toEqual(["sleep-regularity", "sleep-consistency", "oura-scores"]);
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
    await expect(tile.getByTestId("widget-header-nav")).toHaveAttribute(
      "href",
      "/sleep"
    );
    await expect(tile).toContainText("Today");
    await expect(tile).not.toContainText("Last night");
  });

  test("the Add entry action opens the shared sleep and mood editor", async ({
    page,
  }) => {
    await page.goto("/sleep");
    await page.getByTestId("sleep-add-entry-header").click();
    const dialog = page.getByTestId("sleep-mood-edit-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("sleep-entry-date")).toBeVisible();
    await expect(
      dialog.getByText("Sleep duration", { exact: true })
    ).toBeVisible();
    // Today already has synced sleep in this fixture, so a competing manual
    // duration stays unavailable while mood can still be added or changed.
    await expect(
      dialog.getByTestId("sleep-history-edit-readonly")
    ).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Mood" })).toBeVisible();
    await expect(dialog.getByTestId("sleep-mood-edit-save")).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
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
      const emptyLog = page.getByRole("main").getByTestId("sleep-mood-log");
      await expect(
        emptyLog.getByRole("heading", { name: "Sleep and Mood Log" })
      ).toBeVisible();
      const emptyHistory = emptyLog.getByTestId("sleep-mood-history");
      await expect(emptyHistory).toBeVisible();
      await expect(
        emptyHistory.getByTestId("sleep-mood-history-empty")
      ).toBeVisible();
      await expect(
        emptyHistory.getByRole("columnheader", {
          name: "Supplements",
          exact: true,
        })
      ).toHaveCount(0);
      await expect(emptyLog).not.toContainText("bedtime supplement context");
      await expect(
        page.getByRole("main").getByTestId("scatter-chart")
      ).toHaveCount(0);
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
      const timeLabels24 = strip.getByTestId("sleep-consistency-time");
      expect(
        await timeLabels24.evaluateAll((nodes) =>
          nodes.every((node) => node.textContent?.includes(" → "))
        )
      ).toBe(true);

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
      const timeLabels = page
        .getByRole("main")
        .getByTestId("sleep-consistency-time");
      expect(
        await timeLabels.evaluateAll((nodes) =>
          nodes.every((node) => getComputedStyle(node).whiteSpace === "nowrap")
        )
      ).toBe(true);
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
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/sleep");
    await expect(page.getByTestId("sleep-hero")).toBeVisible();
    const layout = await page.evaluate(() => ({
      noBodyScroll:
        document.documentElement.scrollWidth <= window.innerWidth + 1,
      overflowingCards: [...document.querySelectorAll("main .card")].flatMap(
        (card, index) => {
          const bounds = card.getBoundingClientRect();
          return bounds.left >= -1 && bounds.right <= window.innerWidth + 1
            ? []
            : [
                `${index}:${card.getAttribute("data-testid") ?? card.className} (${Math.round(bounds.left)}..${Math.round(bounds.right)})`,
              ];
        }
      ),
    }));
    expect(layout).toEqual({
      noBodyScroll: true,
      overflowingCards: [],
    });
    await expect(page.getByTestId("sleep-add-entry-header")).toHaveCSS(
      "white-space",
      "nowrap"
    );
    const history = page.getByTestId("sleep-mood-history");
    for (const stage of ["Deep", "REM", "Light", "Awake"]) {
      await expect(
        history.getByRole("columnheader", { name: stage, exact: true })
      ).toBeHidden();
    }
    await expect(
      history.getByRole("columnheader", {
        name: "Supplements",
        exact: true,
      })
    ).toBeHidden();
    expect(
      await history
        .getByText("Bedtime · 1/1 taken", { exact: true })
        .evaluateAll((nodes) =>
          nodes.some((node) => node.getClientRects().length > 0)
        )
    ).toBe(true);
    expect(
      await history
        .getByTestId("sleep-history-date-short")
        .evaluateAll((nodes) =>
          nodes.every((node) => getComputedStyle(node).display !== "none")
        )
    ).toBe(true);
    expect(
      await history
        .getByTestId("sleep-history-date-long")
        .evaluateAll((nodes) =>
          nodes.every((node) => getComputedStyle(node).display === "none")
        )
    ).toBe(true);
    const historyScroll = page.getByTestId("sleep-history-scroll-fade");
    expect(
      await historyScroll.evaluate(
        (node) => node.scrollWidth > node.clientWidth
      )
    ).toBe(true);
    await expect
      .poll(() =>
        historyScroll.evaluate((node) => getComputedStyle(node).maskImage)
      )
      .not.toBe("none");
  });

  test("the Sleep page keeps a readable width on extra-wide screens", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/sleep");
    const box = await page.getByTestId("sleep-page").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(1152);
  });
});

test.describe("Sleep and Mood Log historical editing", () => {
  test.beforeEach(resetSleepEditFixture);
  test.afterAll(clearSleepEditFixture);

  test("edits historical mood + duration-only sleep while imported sleep stays read-only", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SLEEP_EDIT,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/sleep");
      const main = page.getByRole("main");
      await expect(main.getByTestId("sleep-regularity")).toHaveCount(0);
      const sparseDuration = main.getByTestId("sleep-duration-trend");
      const sparseConsistency = main.getByTestId("sleep-consistency");
      await expect(sparseConsistency).toBeVisible();
      const [sparseDurationBox, sparseConsistencyBox] = await Promise.all([
        sparseDuration.boundingBox(),
        sparseConsistency.boundingBox(),
      ]);
      expect(sparseDurationBox).not.toBeNull();
      expect(sparseConsistencyBox).not.toBeNull();
      await expect(main.getByTestId("sleep-stages")).toHaveCount(0);
      // With neither SRI nor stage data, the two visible cards fill the first
      // row instead of reserving either missing card's grid position.
      expect(
        Math.abs(sparseDurationBox!.x - sparseConsistencyBox!.x)
      ).toBeGreaterThan(100);
      expect(
        Math.abs(sparseDurationBox!.y - sparseConsistencyBox!.y)
      ).toBeLessThanOrEqual(1);

      const log = page.getByTestId("sleep-mood-log");
      const history = log.getByTestId("sleep-mood-history");
      await expect(
        history.getByRole("columnheader", {
          name: "Supplements",
          exact: true,
        })
      ).toHaveCount(0);
      const manualRow = history.locator(
        '[data-testid="sleep-mood-history-row"][data-sleep-editable="true"]'
      );
      const importedRow = history.locator(
        '[data-testid="sleep-mood-history-row"][data-sleep-editable="false"]'
      );
      await expect(manualRow).toHaveCount(1);
      await expect(importedRow).toHaveCount(1);
      await expect(manualRow).toContainText("7h");
      await expect(importedRow).toContainText("6h 30m");

      await importedRow.getByTestId("sleep-mood-history-edit").click();
      const importedDialog = page.getByTestId("sleep-mood-edit-dialog");
      await expect(
        importedDialog.getByTestId("sleep-history-edit-readonly")
      ).toBeVisible();
      await importedDialog.getByRole("button", { name: "Cancel" }).click();

      await manualRow.getByTestId("sleep-mood-history-edit").click();
      const dialog = page.getByTestId("sleep-mood-edit-dialog");
      const hours = dialog.getByTestId("sleep-history-edit-hours");
      const minutes = dialog.getByTestId("sleep-history-edit-minutes");
      await expect(hours).toHaveValue("7");
      await expect(minutes).toHaveValue("0");
      await expect(dialog.getByTestId("sleep-history-mood-2")).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await hours.fill("8");
      await minutes.fill("45");
      await dialog.getByTestId("sleep-history-mood-4").click();
      await settledClick(page, dialog.getByTestId("sleep-mood-edit-save"));
      await expect(dialog).toHaveCount(0);
      await expect(manualRow).toContainText("8h 45m");
      await expect(manualRow).toContainText("Good (4/5)");

      const handle = new Database(DB_PATH, { readonly: true });
      try {
        const profileId = sleepEditProfileId(handle);
        expect(
          handle
            .prepare(
              `SELECT valence, energy, anxiety, factors, notes
                 FROM mood_logs WHERE profile_id = ?`
            )
            .get(profileId)
        ).toEqual({
          valence: 4,
          energy: 3,
          anxiety: 4,
          factors: '["work"]',
          notes: "keep this detail",
        });
        expect(
          handle
            .prepare(
              `SELECT value FROM metric_samples
                WHERE profile_id = ? AND metric = 'sleep_min'
                  AND source = 'manual' AND start_time = end_time`
            )
            .get(profileId)
        ).toEqual({ value: 525 });
      } finally {
        handle.close();
      }
    } finally {
      await page.context().close();
    }
  });

  test("adds sleep and mood together for a date in the visible log", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SLEEP_EDIT,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      const entryDate = new Date(Date.now() - 2 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await page.goto("/sleep");
      await page.getByTestId("sleep-add-entry-header").click();
      const dialog = page.getByTestId("sleep-mood-edit-dialog");
      await dialog.getByTestId("sleep-entry-date").fill(entryDate);
      await dialog.getByTestId("sleep-history-edit-hours").fill("7");
      await dialog.getByTestId("sleep-history-edit-minutes").fill("35");
      await dialog.getByTestId("sleep-history-mood-5").click();
      await settledClick(page, dialog.getByTestId("sleep-mood-edit-save"));
      await expect(dialog).toHaveCount(0);

      const row = page.locator(
        `[data-testid="sleep-mood-history-row"][data-date="${entryDate}"]`
      );
      await expect(row).toContainText("7h 35m");
      await expect(row).toContainText("Great (5/5)");

      const handle = new Database(DB_PATH, { readonly: true });
      try {
        const profileId = sleepEditProfileId(handle);
        expect(
          handle
            .prepare(
              `SELECT value FROM metric_samples
                WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?
                  AND source = 'manual' AND start_time = end_time`
            )
            .get(profileId, entryDate)
        ).toEqual({ value: 455 });
        expect(
          handle
            .prepare(
              `SELECT valence FROM mood_logs
                WHERE profile_id = ? AND date = ?`
            )
            .get(profileId, entryDate)
        ).toEqual({ valence: 5 });
      } finally {
        handle.close();
      }
    } finally {
      await page.context().close();
    }
  });
});

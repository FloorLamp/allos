import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { hydratedClick } from "./helpers";
import { showLogRow } from "./log-sheet-helpers";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// THE DESKTOP SIDEBAR REFIT (#3154). The sidebar spent ~570px before its first
// nav row — 63% of a 1280x900 viewport — and Data, Settings and the whole footer
// sat below the fold. Four moves reclaimed it: the log button became an anchored
// panel carrying the phone sheet's own menu, the ~230px calendar became one row
// opening the same kind of panel, Frequent went drawer-only, and the commit hash
// left the footer for the page that already renders it.
//
// 1366x768 IS THE ACCEPTANCE VIEWPORT, not the project's 1280x900: it is the
// shortest desktop height the refit was ruled against, so every test here runs
// at it and the fold assertion is measured rather than reasoned about.
const DESKTOP = { width: 1366, height: 768 };

// The viewport-relative TOP of the first nav row, in CSS px, at 1366x768 on the
// seeded multi-profile admin — so the identity bar (#1801) is present and this is
// the TALLER of the two cases, not the flattering one.
//
// 280 is the acceptance criterion's own ceiling and 172 is what this tree
// measures, so the bound carries 108px of headroom. WHAT THAT HEADROOM IS FOR,
// stated because a bound nobody can name the units of is a guess: everything
// ABOVE the nav, which is the identity bar (~42px), the search trigger (40px),
// the "+ Log" button (26px) and the column's own padding and gaps. One more row
// of chrome up there is ~50px, so this fails before a second one lands. It is a
// CEILING on a PRESENCE-shaped quantity — a nav row that renders too low still
// fails it — so the generous bound cannot flatter a broken layout the way it
// could under an absence assertion.
const NAV_TOP_CEILING_PX = 280;

// Open the sidebar's "+ Log" panel and return it.
//
// The button is a pure CLIENT toggle, so a tap in the pre-hydration window is
// swallowed with no POST to settle on and no other awaitable open signal — the
// visibility-guarded retry is the only honest wait (#500/#830). NOT safe to
// repeat blindly, unlike the puck: this trigger TOGGLES, so the guard has to
// re-check visibility before every re-click or a late tap closes what the first
// one opened.
async function openLogPanel(page: Page): Promise<Locator> {
  const panel = page.getByTestId("sidebar-log-panel");
  await expect(async () => {
    if (!(await panel.isVisible())) {
      await page.locator("aside").getByTestId("sidebar-log").click();
    }
    await expect(panel).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap past the pre-hydration swallow — a client toggle with no POST, visibility-guarded so a late tap can't re-close it
  return panel;
}

// The first nav row's viewport top, which both the fold assertion and the
// "opening a panel shifts nothing" assertion are about.
async function navTopPx(page: Page): Promise<number> {
  const firstRow = page.locator("aside nav > :first-child");
  await expect(firstRow).toBeVisible();
  return firstRow.evaluate((el) => el.getBoundingClientRect().top);
}

test.describe("the desktop sidebar refit (#3154)", () => {
  test.use({ viewport: DESKTOP });

  test("the log panel opens the sheet's own menu, switches segment, opens a form, and stays open", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    const panel = await openLogPanel(page);

    // THE SHEET'S MODULES, NOT A COPY (#2184). Nutrition promotes food, so
    // `openingLogSegment` lands the panel on Consume with no segment tap — the
    // same derivation the phone sheet runs, proved here through its outcome.
    await expect(panel.getByTestId("quick-log-log-food")).toBeVisible();

    // The long tail is one tap away, and segments are mutually exclusive rather
    // than stacked. `showLogRow` reads which segment holds a row from the app's
    // own `LOG_SEGMENT_CENSUS`, so this cannot drift from the grouping.
    await expect(await showLogRow(panel, "add-document")).toBeVisible();
    await expect(panel.getByTestId("quick-log-log-food")).toHaveCount(0);

    // A row opens its EXISTING overlay form in place (#1468) and navigates
    // nowhere — and the panel is STILL THERE behind it, which is the one
    // behaviour the desktop panel does not share with the phone sheet.
    await (await showLogRow(panel, "log-dose")).click();
    await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/\/nutrition$/);
  });

  test("the Calendar row opens the month grid, shifts nothing, and a marked day opens that timeline day", async ({
    page,
  }) => {
    await page.goto("/");
    const row = page.locator("aside").getByTestId("sidebar-calendar");
    await expect(row).toBeVisible();
    // No badge, no count, no dot: permanent chrome never campaigns (#2651). The
    // row's whole text content is its label.
    await expect(row).toHaveText("Calendar");

    const panel = page.getByTestId("sidebar-calendar-panel");
    await expect(panel).toHaveCount(0);
    const navBefore = await navTopPx(page);
    await hydratedClick(page, row);
    await expect(panel).toBeVisible();
    // Portaled and `fixed`: opening it moves neither the nav nor the footer, which
    // is the whole reason the grid left the column.
    expect(await navTopPx(page)).toBeCloseTo(navBefore, 0);

    // A marked day is a door into the Timeline (#3079's usage review). Walk back
    // through the grid's own bounded month navigation until a month holds one —
    // the seeded profile's events are not guaranteed to sit in the current month,
    // and an assertion that only holds in some months is not an assertion.
    const marked = panel.locator('a[href^="/timeline?from="]');
    const previous = panel.getByLabel("Previous month");
    for (let back = 0; back < 24 && (await marked.count()) === 0; back++) {
      if (await previous.isDisabled()) break;
      await previous.click();
    }
    const anyMarked = marked.first(); // first-ok: the claim is "a marked day is a door", true of every cell in the set — the grid renders one link per marked day of the month and this spec plants none, so naming one would be naming a seed fixture this test does not own
    await expect(anyMarked).toBeVisible();
    const href = (await anyMarked.getAttribute("href"))!;
    const day = /from=(\d{4}-\d{2}-\d{2})/.exec(href)![1];
    await anyMarked.click();
    await expect(page).toHaveURL(new RegExp(`/timeline\\?from=${day}`));
    await expect(page.locator(`#timeline-day-${day}`)).toBeVisible();
  });

  test("both panels close on Escape and on an outside click", async ({
    page,
  }) => {
    await page.goto("/");
    const calendar = page.getByTestId("sidebar-calendar-panel");
    await hydratedClick(
      page,
      page.locator("aside").getByTestId("sidebar-calendar")
    );
    await expect(calendar).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(calendar).toHaveCount(0);

    // The log panel takes the same two dismissals from the same primitive — one
    // anchored panel serves both, so this is the shared behaviour being asserted
    // on the second consumer rather than a second implementation being tested.
    const log = await openLogPanel(page);
    await page.keyboard.press("Escape");
    await expect(log).toHaveCount(0);
    await openLogPanel(page);
    // The click-away CATCHER is what an outside click lands on — a full-viewport
    // `fixed inset-0` the primitive draws under the popover — so this is a mouse
    // click at a point outside the panel, not a click on the page element under
    // it. Clicking <main> would be intercepted by the catcher and Playwright
    // would (correctly) retry forever: the catcher doing its job reads exactly
    // like an unclickable target.
    await page.mouse.click(1000, 500);
    await expect(log).toHaveCount(0);
  });

  test("a profile without the workout product gets both rows, and its own menu content", async ({
    browser,
  }) => {
    // The `return null` paths are gone. Neither affordance is relevance-gated any
    // more — food, body and care logs apply at every life stage, and the calendar's
    // days come from every event store, including the immunizations and milestones
    // a child's profile is the RICHEST in.
    const child = await loginAs(
      browser,
      { username: E2E_LOGIN_CHILD, password: E2E_MEMBER_PASSWORD },
      { viewport: DESKTOP }
    );
    try {
      await child.goto("/");
      const aside = child.locator("aside");
      await expect(aside.getByTestId("sidebar-log")).toBeVisible();
      await expect(aside.getByTestId("sidebar-calendar")).toBeVisible();
      // …and it really is that profile: the workout product stands down.
      await expect(aside.locator('nav a[href="/training"]')).toHaveCount(0);

      // #2651's age-restriction ruling, mirrored: the AFFORDANCE renders and
      // `quickLogMenu`'s per-entry gates decide the content.
      const panel = await openLogPanel(child);
      await expect(panel.getByTestId("log-sheet-segment-train")).toHaveCount(0);
      await expect(panel.getByTestId("quick-log-log-activity")).toHaveCount(0);
      await expect(await showLogRow(panel, "log-food")).toBeVisible();
    } finally {
      await child.close();
    }
  });

  test("at 1366x768 the sidebar needs no scroll and the nav starts above the fold", async ({
    page,
  }) => {
    await page.goto("/");
    const aside = page.locator("aside");
    // WAIT FOR THE CONTENT BEING MEASURED, not for the container: an aside whose
    // nav has not rendered fits any height.
    await expect(page.locator("aside nav > :first-child")).toBeVisible();
    await expect(page.getByTestId("sidebar-log")).toBeVisible();
    await expect(aside.getByTestId("sidebar-calendar")).toBeVisible();

    const box = await aside.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(
      box.scrollHeight,
      "the sidebar's content fits its own height without scrolling"
    ).toBeLessThanOrEqual(box.clientHeight + 1);
    expect(
      await navTopPx(page),
      "the first nav row's viewport top"
    ).toBeLessThan(NAV_TOP_CEILING_PX);

    // …and the assertion that says it in the form a person would notice. The
    // aside is a flex column with an `mt-auto` footer, so its `scrollHeight`
    // equals its `clientHeight` for ANY content that fits — the check above only
    // fires on genuine overflow, which is what it is for, but it cannot tell you
    // the LAST row is reachable. This can: "What's new · Disclaimer" is the
    // element that sat below the fold before the refit.
    await expect(page.getByTestId("signed-in-as")).toBeInViewport();
    await expect(
      aside.getByRole("link", { name: "Disclaimer" })
    ).toBeInViewport();
    // Frequent is drawer-only now; on desktop the nav it duplicated is one glance
    // below, and its shortcuts are what the aside-wide role queries used to collide
    // with (e2e/progress-photos.spec.ts).
    await expect(aside.getByTestId("frequent-pages")).toHaveCount(0);
    // The commit hash left the footer for What's new, which already rendered it.
    await expect(aside.locator('a[href*="/commit/"]')).toHaveCount(0);
  });
});

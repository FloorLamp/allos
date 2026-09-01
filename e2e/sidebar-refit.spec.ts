import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { awaitHydrated, hydratedClick } from "./helpers";
import { showLogRow } from "./log-sheet-helpers";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// THE DESKTOP SIDEBAR REFIT (#3154). The sidebar spent ~570px before its first
// nav row — 63% of a 1280x900 viewport — and Data, Settings and the whole footer
// sat below the fold. Four moves reclaimed it: the log button became an anchored
// panel carrying the phone sheet's own menu, the ~230px calendar became one row
// opening the same kind of panel, Frequent went drawer-only, and the commit hash
// left the footer for the page that already renders it.
//
// THE CALENDAR HALF OF THIS FILE IS ON /history NOW (#4280, completing #4102).
// The row left the column — a day grid is a way of reading a history, and the
// chrome is a way of reaching a page — but what it left BEHIND is the reason the
// cases stay here: the refit's anchored-panel contract has exactly two dialog
// consumers, the sidebar's "+ Log" and the record's Calendar, and #3905's
// browser-side invariant (a promised popup the keyboard can reach) is a claim
// about the PRIMITIVE that only means something asserted on both. Every case
// below therefore runs on /history, where the desktop sidebar renders exactly as
// it does everywhere else and the calendar's trigger is on the page.
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
// the "+ Log" button (34px — the control box, #3938/#4003, not the 26px this line
// used to say) and the column's own padding and gaps. One more row
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

  test("the record's Calendar trigger opens the month grid, shifts nothing, and a marked day opens that day", async ({
    page,
  }) => {
    await page.goto("/history");
    // IN THE FILTER ROW THAT ALREADY EXISTS, which is the placement claim: the
    // record's chrome above its first row is bounded at ~140px (#3958) and had
    // 6px of room, so the grid could only arrive as a control inside a band the
    // page already draws — never as a band of its own.
    const row = page
      .getByTestId("history-filters")
      .getByTestId("history-calendar");
    await expect(row).toBeVisible();
    // No badge, no count, no dot: permanent chrome never campaigns (#2651). The
    // trigger's whole text content is its label.
    await expect(row).toHaveText("Calendar");

    const panel = page.getByTestId("history-calendar-panel");
    await expect(panel).toHaveCount(0);
    // WHAT MUST NOT MOVE IS THE PAGE, not the nav: measured on the first record
    // row, which is the thing the ~140px budget is measured to.
    const firstRow = page.getByTestId("history-row").first(); // first-ok: the claim is that opening a portaled panel moves the feed by nothing, true of whichever record leads
    await expect(firstRow).toBeVisible();
    const rowTop = async () =>
      firstRow.evaluate((el) => el.getBoundingClientRect().top);
    const feedBefore = await rowTop();
    await hydratedClick(page, row);
    await expect(panel).toBeVisible();
    // Portaled and `fixed`: opening it moves neither the filter row nor the feed,
    // which is the whole reason the grid opens rather than unfolding.
    expect(await rowTop()).toBeCloseTo(feedBefore, 0);

    // A marked day is a door into the Timeline (#3079's usage review). Walk back
    // through the grid's own bounded month navigation until a month holds one —
    // the seeded profile's events are not guaranteed to sit in the current month,
    // and an assertion that only holds in some months is not an assertion.
    const marked = panel.locator('a[href^="/history?day="]');
    const previous = panel.getByLabel("Previous month");
    for (let back = 0; back < 24 && (await marked.count()) === 0; back++) {
      if (await previous.isDisabled()) break;
      await previous.click();
    }
    const anyMarked = marked.first(); // first-ok: the claim is "a marked day is a door", true of every cell in the set — the grid renders one link per marked day of the month and this spec plants none, so naming one would be naming a seed fixture this test does not own
    await expect(anyMarked).toBeVisible();
    const href = (await anyMarked.getAttribute("href"))!;
    const day = /day=(\d{4}-\d{2}-\d{2})/.exec(href)![1];
    await anyMarked.click();
    await expect(page).toHaveURL(new RegExp(`/history\\?day=${day}`));
    await expect(page.locator(`#timeline-day-${day}`)).toBeVisible();
    // …AND THE POPOVER ENDS WITH IT (#3905). `open` is state in a layout App
    // Router does not remount, so the grid used to stay anchored to the sidebar
    // row, floating over the very day it had just opened, until Escape. The two
    // assertions above have already proved the destination rendered, so there is
    // no window left for this absence to pass by arriving early.
    await expect(panel).toHaveCount(0);
  });

  // KEYBOARD REACH INTO BOTH PANELS (#3905). The refit portaled them to <body>
  // under triggers declaring `aria-haspopup="dialog"` and moved no focus, so a
  // keyboard user reached the grid's controls only by tabbing past the rest of the
  // sidebar and the whole page. This is the browser half of
  // components/__tests__/anchored-popover-focus.test.tsx, which pins the same
  // contract in jsdom but cannot speak for a real browser's focus rules.
  //
  // THE SUBJECT OF THESE ASSERTIONS IS FIXED HERE, NOT CHOSEN BY THE PANEL (#4015).
  //
  // Both used to read `document.activeElement` through a bare `evaluate` after a
  // key press, and the second one meant "Shift+Tab off the panel's FIRST control
  // leaves". Which control that is, is decided by the app: `AnchoredPanel` focuses
  // `focusablesIn(panel)[0]` in an effect, and the Log menu's context offers arrive
  // from an ASYNC gather on every open (`useLogSheetContext`) that mounts rows
  // ABOVE the segment track. So focus routinely ends up mid-panel, one Shift+Tab
  // lands on an earlier row still INSIDE it, and the assertion silently measured
  // the gather's timing. Measured: 1 red in 6 parallel repeats, then 1 on the first
  // CI run, then 4 in 10 once a naive wait stopped hiding it.
  //
  // So the escape is stated as the PROPERTY instead of as one keystroke: a popover
  // lets focus walk out, a modal wraps for ever. Shift+Tab is pressed until focus
  // leaves, bounded by the panel's own focusable count — every extra control the
  // gather adds is one more press, and a trap exhausts the bound however many
  // there are. That means the same thing on every run.
  //
  // FOCUSABLE mirrors `focusablesIn` in components/useFocusTrap.ts — the app's
  // single answer to "what is reachable in here", visibility filter included.
  // Duplicated rather than imported because that module is a React hook file; if
  // the two ever disagree, these assertions are what reds.
  const FOCUSABLE =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** Where focus is relative to the panel, as a word rather than a boolean. */
  async function focusPlace(
    panel: Locator
  ): Promise<"inside" | "outside" | "lost"> {
    return panel.evaluate((el) => {
      const active = document.activeElement;
      if (!active || active === document.body) return "lost";
      return el.contains(active) ? "inside" : "outside";
    });
  }

  /** Reachable controls in the panel right now — the walk's bound, re-read each press. */
  async function focusableCount(panel: Locator, sel: string): Promise<number> {
    return panel.evaluate(
      (el, s) =>
        Array.from(el.querySelectorAll<HTMLElement>(s)).filter(
          (n) => n.offsetParent !== null
        ).length,
      sel
    );
  }

  // WHERE THE TRIGGER LIVES is now part of the table: the log panel's opens from
  // the desktop sidebar and the calendar's from /history's filter row (#4280).
  // Both pages render the sidebar, so one route serves the whole table.
  const KEYBOARD_PANELS = [
    {
      what: "Calendar",
      inSidebar: false,
      trigger: "history-calendar",
      panel: "history-calendar-panel",
      // The panel's first control BY NAME, because the browser's answer to "what
      // is focusable in here" is the part jsdom cannot give. Both cases now pin
      // the first focusable structurally (see FOCUSABLE above); this adds WHICH
      // control that is, where the panel's content is fixed. The log panel's
      // first row follows the segment `openingLogSegment` picks, so it is left
      // unnamed and the structural assertion carries it.
      firstControl: "Previous month",
    },
    {
      what: "Log",
      inSidebar: true,
      trigger: "sidebar-log",
      panel: "sidebar-log-panel",
      firstControl: null,
    },
  ] as const;

  for (const {
    what,
    inSidebar,
    trigger,
    panel,
    firstControl,
  } of KEYBOARD_PANELS) {
    test(`the ${what} panel opens from the keyboard, is the dialog its trigger promises, and hands focus back`, async ({
      page,
    }) => {
      await page.goto("/history");
      const button = (inSidebar ? page.locator("aside") : page).getByTestId(
        trigger
      );
      await awaitHydrated(button);
      await button.focus();
      await expect(button).toBeFocused();
      await page.keyboard.press("Enter");

      const opened = page.getByTestId(panel);
      await expect(opened).toBeVisible();
      // Exactly one dialog, named — `aria-haspopup="dialog"` and `aria-controls`
      // on the trigger now point at something that answers to the description.
      await expect(
        page.getByRole("dialog", { name: what, exact: true })
      ).toHaveCount(1);
      // A popover, not a drawer: no `aria-modal`, and nothing is scroll-locked.
      expect(await opened.getAttribute("aria-modal")).toBeNull();
      // Focus goes INTO the panel (#3905's invariant), polled rather than read
      // once: it arrives from an effect keyed on the positioner having measured,
      // and `toBeVisible` resolves off the same paint — 15-28ms apart on this box,
      // measured, which is a race a single `evaluate` loses about one run in six.
      // WHICH control it lands on is deliberately not asserted here: the Log
      // panel's is whatever the async offer gather has mounted by then.
      await expect.poll(() => focusPlace(opened)).toBe("inside");
      if (firstControl) {
        await expect(opened.getByLabel(firstControl)).toBeFocused();
      }

      await page.keyboard.press("Escape");
      await expect(opened).toHaveCount(0);
      await expect(button).toBeFocused();

      // AND IT IS NOT A TRAP. Re-opened, Shift+Tab off the panel's first control
      // leaves for the page behind it; a modal would have wrapped round to the
      // panel's last control instead.
      await page.keyboard.press("Enter");
      await expect(opened).toBeVisible();
      // Start from focus actually being in the panel, so the walk below is
      // measuring the escape and not the effect that has not run yet.
      await expect.poll(() => focusPlace(opened)).toBe("inside");

      // The bound, and what it bounds: one press per reachable control in the
      // panel, plus one to leave it. Read AFTER focus has landed so the offer
      // gather is counted, and +2 for a control that mounts during the walk. A
      // trap cannot satisfy it at any size — it never leaves — so a generous
      // bound cannot flatter one.
      const presses = (await focusableCount(opened, FOCUSABLE)) + 2;
      let place = await focusPlace(opened);
      for (let i = 0; i < presses && place === "inside"; i += 1) {
        await page.keyboard.press("Shift+Tab");
        place = await focusPlace(opened);
      }
      // A PRESENCE: focus is somewhere, and that somewhere is out of the panel.
      // "not contained" alone is also satisfied by focus falling to nothing,
      // which is a different bug wearing the same green.
      expect(
        place,
        `Shift+Tab ${presses} times from inside the ${what} panel never left it — ` +
          "a popover lets focus walk out; a modal wraps round for ever."
      ).toBe("outside");
    });
  }

  test("both panels close on Escape and on an outside click", async ({
    page,
  }) => {
    await page.goto("/history");
    const calendar = page.getByTestId("history-calendar-panel");
    await hydratedClick(page, page.getByTestId("history-calendar"));
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
      await child.goto("/history");
      const aside = child.locator("aside");
      await expect(aside.getByTestId("sidebar-log")).toBeVisible();
      await expect(child.getByTestId("history-calendar")).toBeVisible();
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
    // THE COLUMN IS 302px SHORTER SINCE #4280 — measured in the drawer, which
    // renders the same <SidebarContent> — so this ceiling has more headroom than
    // the refit left it, not less. Recorded because a bound that got easier to
    // clear is a bound that stopped saying what it used to say: what it still
    // catches is a NEW block of chrome above the nav, which is what it was for.
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
    // Frequent is retired outright (#4102); this desktop absence keeps its old
    // shortcuts from colliding with aside-wide role queries.
    await expect(aside.getByTestId("frequent-pages")).toHaveCount(0);
    // The commit hash left the footer for What's new, which already rendered it.
    await expect(aside.locator('a[href*="/commit/"]')).toHaveCount(0);
  });

  // THE CTA COLOUR, BACK, AND MEASURED (#3982). #3759 converged this control on the
  // typed Button, which rendered one secondary paint, so the sidebar's ONE log
  // affordance (#3154) became an ordinary bordered box — the owner's report.
  //
  // ASSERTED AS A COMPARISON, not against a colour literal. "+ Log has background
  // X" passes on a tree where every control in the column turned X, and it has to
  // be rewritten the day the brand token moves. The claim a person makes looking at
  // the sidebar is that ONE control is filled and the rows around it are not, so
  // that is the assertion: the trigger paints an opaque fill, the Calendar row
  // beside it paints none.
  test("the sidebar's + Log is its one filled action", async ({ page }) => {
    await page.goto("/");
    const aside = page.locator("aside");
    const log = aside.getByTestId("sidebar-log");
    await expect(log).toBeVisible();
    // THE NEIGHBOUR IS A NAV ROW NOW (#4280). It was the Calendar row, which has
    // left the column; the claim is unchanged and so is its shape — one control
    // is filled and the rows around it are not — so it is asserted against a row
    // that is still there. Settings, because it is never the active row on
    // /history and an active row paints its own soft fill.
    const neighbour = aside.getByRole("link", { name: "Settings" });
    await expect(neighbour).toBeVisible();

    const fills = await aside.evaluate((el) => {
      const read = (sel: string) =>
        getComputedStyle(el.querySelector<HTMLElement>(sel)!).backgroundColor;
      return {
        log: read('[data-testid="sidebar-log"]'),
        neighbour: read('nav a[href="/settings"]'),
      };
    });
    // rgba(…, 0) / "transparent" is what an unpainted control reports.
    expect(fills.neighbour, "an ordinary nav row is unfilled").toMatch(
      /^(transparent|rgba\(.*,\s*0\))$/
    );
    expect(fills.log, "+ Log paints a fill").not.toBe(fills.neighbour);
    expect(fills.log).not.toMatch(/^(transparent|rgba\(.*,\s*0\))$/);

    // THE ADMISSION RULE, on the surface the owner named: primary marks the action
    // a surface exists for, so the sidebar may carry exactly one.
    await expect(aside.locator(".button-control-primary")).toHaveCount(1);
  });
});

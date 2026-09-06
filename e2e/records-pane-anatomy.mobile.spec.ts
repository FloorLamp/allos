import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { hydratedClick, settledBoxes } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_HHHIST, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { CONTROL_BOX_PX, TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";

// The Records hub's PHONE ANATOMY (issue #3408).
//
// The #3310 tab-hub shell gave Records its phone tab strip, but every pane under
// it still composed desktop-first: three look-alike pill strips with three
// different meanings, a pane that repeated its own name directly under the chip
// that had just named it, absences spending more room than presences, four
// button species standing above a rare-cadence list, and a sort-header table on
// a 390px screen. On Immunizations that stack put the first vaccine roughly a
// full screen down.
//
// WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. Everything here is
// ANATOMY — what is drawn, in what order, at what size. The records themselves,
// the schedule assessment, the multi-view scoping and every write path are
// untouched by #3408 and stay pinned where they already are
// (e2e/immunizations.spec.ts, e2e/visits-lifecycle.spec.ts,
// e2e/multi-view.spec.ts). The desktop half of each width-gated decision is
// e2e/records-page.spec.ts's, kept beside that file's other desktop assertions
// for the reason the palette pair records: a phone spec passes HARDER the more chrome disappears,
// so something has to hold the desktop end of the fork.
//
// THIS FILE IS NEW, so it re-partitions the duration-balanced CI shards: every
// spec's NEIGHBOURS move, not just this one's. See docs/internals/e2e-hygiene.md.
//
// Fixture discipline (#868): read-only over the shared seed. Every assertion is
// about presence, order and geometry; nothing here writes, and nothing counts
// seeded rows.

// The `mobile` project's viewport (playwright.config.ts). The issue's screenshots
// were taken at 430; 390 is below `md` too and is the harder of the two.
const VIEWPORT_HEIGHT = 844;

// WHERE THE VACCINE LIST STARTS, AND WHAT THE NUMBER IS BOUNDING.
//
// MEASURED at 390×844 on 2026-08-21, against an origin/main control worktree at
// a78a6b93 and this branch, same harness, one reading each:
//
//   origin/main   the list's `<table>` began at y=530
//   this branch   it begins at y=393
//
// The 137px is the pane's own name, its orientation prose, three standing
// rare-cadence controls and a three-tile count block, all removed or folded.
// The ceiling below is that measurement plus ~60px of headroom, and the headroom
// is for the two things that legitimately move it: a longer status sentence
// wrapping to a third line, and the no-birthdate Notice on a profile that has
// none. It is NOT a viewport-fraction bound — "fits on the first screen" was
// already true before this issue and is the wrong question. The question is
// whether the chrome came off, so the number is a comparison, not a guess.
const LIST_TOP_CEILING = 455;
// The app's own touch floor (app/globals.css, `tap-target`; #644).

async function documentOrder(
  page: Page,
  firstTestId: string,
  secondTestId: string
): Promise<boolean> {
  return page.evaluate(
    ([a, b]) => {
      const first = document.querySelector(`[data-testid="${a}"]`)!;
      const second = document.querySelector(`[data-testid="${b}"]`)!;
      return !!(
        first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    },
    [firstTestId, secondTestId]
  );
}

// The RENDERED fill of one chip. Sequential reads by design: the two values are
// compared for INEQUALITY, so nothing here needs them sampled atomically, and a
// `Promise.all` pair is the shape e2e-hygiene bans for exactly the reason it
// would be wrong if this were a relative geometry claim.
async function background(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).backgroundColor);
}

test.describe("Records panes — phone anatomy (#3408)", () => {
  test("a pane does not repeat its own name below md, and Results inherits it", async ({
    page,
  }) => {
    await page.goto("/records/history/immunizations");
    const intro = page.getByTestId("records-pane-intro");
    await expect(intro).toBeAttached();

    // THE PROSE IS NOT PAINTED. `hidden md:block`, so this one is a plain
    // visibility question.
    await expect(
      intro.getByText("Your vaccination record measured against")
    ).toBeHidden();

    // THE HEADING IS `sr-only` — IN THE DOCUMENT, COSTING NO PIXELS. "Renders
    // neither" is about pixels: a pane whose content sits under no heading at all
    // leaves an assistive-tech reader navigating by heading with nothing between
    // the hub's `sr-only` h1 and a card's h3.
    //
    // ASSERTED BY MEASUREMENT, NOT BY `toBeHidden()`. An `sr-only` element is a
    // 1px clipped box, not `display: none`, so Playwright reports it VISIBLE and
    // a `toBeHidden` here fails against a correct implementation — measured, on
    // the first run of this file. The claim that matters is that it takes no
    // vertical space, and that is what this reads.
    const heading = intro.getByRole("heading", { name: "Immunizations" });
    await expect(heading).toBeAttached();
    const headingBox = await heading.boundingBox();
    expect(headingBox!.height).toBeLessThanOrEqual(1);

    // And the WRAPPER reserves nothing either: an element that paints nothing
    // must not keep its margin (#2399's rule, one level up).
    const introBox = await intro.boundingBox();
    expect(introBox!.height).toBe(0);

    // RESULTS INHERITS IT WITH NO RESULTS-SPECIFIC CODE, because the decision
    // landed in components/PaneIntro.tsx rather than under /records (#3236).
    await page.goto("/results/imaging");
    const resultsIntro = page.getByTestId("results-pane-intro");
    await expect(resultsIntro).toBeAttached();
    await expect(resultsIntro.locator("p")).toBeHidden();
    expect((await resultsIntro.boundingBox())!.height).toBe(0);
  });

  test("navigation chips and filter chips are visibly different things", async ({
    page,
  }) => {
    await page.goto("/records/history/immunizations");

    // Declared rather than inferred from a list of Tailwind classes, which is a
    // brittle way to ask "do these look different" — the DECISION is the claim.
    const navStrip = page.getByTestId("records-sub-tabs");
    const filterStrip = page.getByTestId("immunization-status-filter");
    await expect(navStrip).toHaveAttribute("data-chip-role", "nav");
    await expect(filterStrip).toHaveAttribute("data-chip-role", "filter");

    // And they really do render differently: the nav pill is the family's
    // rounded-full outline, the filter is an inset rounded-md control. Read off
    // the COMPUTED style, so this fails if the two ever converge again however
    // they are spelled.
    const radii = await page.evaluate(() => {
      const read = (sel: string) => {
        const el = document.querySelector(`${sel} a, ${sel} button`)!;
        return getComputedStyle(el).borderTopLeftRadius;
      };
      return {
        nav: read('[data-testid="records-sub-tabs"]'),
        filter: read('[data-testid="immunization-status-filter"]'),
      };
    });
    expect(radii.nav).not.toBe(radii.filter);

    // THE STRIPS SAY THEY SCROLL. Seven status options on a 390px screen overflow
    // with no affordance at all until the reader guesses — `ScrollFade` publishes
    // the masked edge as a marker so this is measurable, not a gradient in a
    // screenshot.
    await expect(filterStrip).toHaveAttribute("data-fade-right", "true");

    // The filter sits immediately above the list it filters, under that list's
    // own label — not as a third navigation layer under a separate heading line.
    expect(
      await documentOrder(
        page,
        "records-sub-tabs",
        "immunization-status-filter"
      )
    ).toBe(true);
  });

  // ── THE CHIP PRIMITIVE, MEASURED RATHER THAN DECLARED (#3475) ─────────────
  //
  // The test above asks whether the two roles are DIFFERENT. This one asks
  // whether they are the SAME where they are meant to be — one size — and it has
  // to be a rendered measurement rather than a class-string check for the reason
  // this project keeps relearning: a computed-style assertion measures a
  // DECLARATION and the reader sees a RENDERED result. #3466 shipped a stepped
  // 16px seam whose rendered gap stayed 24px, with its guard reading 16 off that
  // exact element.
  //
  // What it would have caught: the defect #3475 was filed on is four heights for
  // one idea — the nav chip at `py-1` + border (30px), one Analyze strip at
  // `py-1.5` + border (34) and a second at `py-1` + border (30), and FilterPills
  // at `py-1.5` borderless (32). A call site that re-overrides padding is
  // invisible to a token residual and visible here.
  test("the two chip roles render at ONE size, and differ only where they mean to", async ({
    page,
  }) => {
    await page.goto("/records/history/immunizations");
    // Exact locators rather than a positional one: both strips live on a shared
    // surface, and both of these labels are fixed by app/(app)/records/nav.ts
    // and by ImmunizationStatusFilter's OPTIONS.
    // (This comment used to name the positional helper in prose and the
    // e2e-hygiene census counted the SENTENCE as a call site — it reads raw
    // source. Worth knowing before writing the next one.)
    const nav = page
      .getByTestId("records-sub-tabs")
      .getByRole("link", { name: "Immunizations" });
    const filter = page
      .getByTestId("immunization-status-filter")
      .getByRole("link", { name: "Needs attention" });
    // WAIT FOR THE CHIPS THEMSELVES, not for their strips: a container is
    // measurable while it is still empty, and an empty box flatters any
    // assertion about the boxes inside it.
    await expect(nav).toBeVisible();
    await expect(filter).toBeVisible();

    // 34px is the primitive's one size: `px-3 py-1.5` over `text-sm` (32px of
    // content box) PLUS the 1px border the base reserves for both roles.
    //
    // THAT NUMBER IS WHY THIS TEST IS RENDERED. Its first cut asserted 32 — the
    // height FilterPills had measured and written down — and the nav chip came
    // back 34, because the nav role draws a border and the filter role did not,
    // so one padding scale was still producing two heights. The primitive now
    // reserves the border on its BASE and a role only changes its colour. No
    // class-string check could have found that; this one found it on first run.
    // READ FROM THE TOKEN, not written down: #3938 made this the app's one control
    // height, so a literal here would pin a number the primitive owns.
    const CHIP_HEIGHT = CONTROL_BOX_PX;
    const [navBox, filterBox] = await settledBoxes([nav, filter]);
    expect(Math.round(navBox.height)).toBe(CHIP_HEIGHT);
    expect(Math.round(filterBox.height)).toBe(CHIP_HEIGHT);

    // …and they are still the two different shapes #3408 separated them into.
    const radii = await page.evaluate(() => {
      const read = (sel: string) =>
        getComputedStyle(document.querySelector(`${sel} a`)!)
          .borderTopLeftRadius;
      return {
        nav: read('[data-testid="records-sub-tabs"]'),
        filter: read('[data-testid="immunization-status-filter"]'),
      };
    });
    expect(radii.nav).not.toBe(radii.filter);
  });

  // THE LIT STATE IS PAINTED FROM THE ARIA (#3475). Both roles key their selected
  // rule on `[aria-current]` / `[aria-pressed="true"]`, which makes "a chip cannot
  // look selected without announcing that it is" a structural fact rather than a
  // convention. Rendered, because the claim is about what the cascade produced:
  // the attribute selector can be present in the sheet and still lose.
  test("a chip's selected paint follows the attribute that announces it", async ({
    page,
  }) => {
    await page.goto("/records/history/immunizations");

    const filterStrip = page.getByTestId("immunization-status-filter");
    // "All" is the default filter on this URL, so it is the lit one; "Declined"
    // is a fixed sibling that is not. Both labels come from
    // app/(app)/immunizations/ImmunizationStatusFilter.tsx's OPTIONS.
    const filterLit = filterStrip.getByRole("link", { name: "All" });
    const filterUnlit = filterStrip.getByRole("link", { name: "Declined" });
    await expect(filterLit).toHaveAttribute("aria-current", "true");
    await expect(filterUnlit).not.toHaveAttribute("aria-current", /./);
    expect(await background(filterLit)).not.toBe(await background(filterUnlit));

    // And the nav strip's current pane says the same thing the same way.
    const navStrip = page.getByTestId("records-sub-tabs");
    const navLit = navStrip.getByRole("link", { name: "Immunizations" });
    const navUnlit = navStrip.getByRole("link", { name: "Visits" });
    await expect(navLit).toHaveAttribute("aria-current", "page");
    await expect(navUnlit).not.toHaveAttribute("aria-current", /./);
    expect(await background(navLit)).not.toBe(await background(navUnlit));
  });

  test("the Specialty pane strip renders single-line chips", async ({
    page,
  }) => {
    await page.goto("/records/specialty/mental-health");
    const strip = page.getByTestId("records-sub-tabs");
    await expect(strip).toBeVisible();

    // A pill used to be allowed to SHRINK — `flex-nowrap` stops the container
    // wrapping and says nothing about a squeezed item — so six panes on a phone
    // broke their labels over two lines into ~50px pills. A pill that refuses to
    // shrink scrolls out of the row instead, which is what the overflow is for.
    //
    // EACH CHIP AGAINST ITS OWN ONE-LINE HEIGHT, NEVER AGAINST ITS SIBLINGS.
    // This assertion used to read `max(heights) < min(heights) * 1.6`, and that
    // is a tautology on this strip: the row is `flex` with no `items-*`, so
    // `align-items: stretch` gives every chip the height of the TALLEST and max
    // ALWAYS equals min — including in the two-line state this test exists to
    // catch. It reduced to `h < 1.6h`, true of any positive height, and it read
    // ratio 1.0 PASS against the broken `origin/main` render (50px chips) and
    // PASS again with `whitespace-nowrap` deleted from this branch. A guard that
    // cannot go red.
    //
    // So each chip is compared with the height ITS OWN box would take at one
    // line — padding + borders + one `line-height`, all read from the computed
    // style so a padding or type-scale change carries the threshold with it.
    // Measured today: 30px at one line, 50px at two, threshold 40px. The half-
    // line of slack keeps the assertion off the exact two-line boundary rather
    // than deciding the case on a sub-pixel.
    const chips = await strip.locator("a").evaluateAll((els) =>
      els.map((el) => {
        const s = getComputedStyle(el);
        const px = (v: string) => parseFloat(v) || 0;
        const lineHeight = px(s.lineHeight);
        return {
          height: el.getBoundingClientRect().height,
          lineHeight,
          oneLine:
            px(s.paddingTop) +
            px(s.paddingBottom) +
            px(s.borderTopWidth) +
            px(s.borderBottomWidth) +
            lineHeight,
        };
      })
    );
    expect(chips.length).toBeGreaterThan(1);
    for (const chip of chips) {
      // A `line-height: normal` regression would parse to 0 and quietly turn the
      // threshold into "padding only", which no chip could clear. Fail loudly
      // instead of inverting the guard.
      expect(chip.lineHeight).toBeGreaterThan(0);
      expect(chip.height).toBeLessThan(chip.oneLine + chip.lineHeight / 2);
    }
  });

  test("Immunizations leads with its records, not with its chrome", async ({
    page,
  }) => {
    await page.goto("/records/history/immunizations");

    // ONE PRIMARY, ONE ⋯ (item C / item G). The add stays; import, print and
    // share fold. Nothing else standing above the list.
    await expect(
      page.getByTestId("add-immunization-panel-toggle")
    ).toBeVisible();
    await expect(page.getByTestId("immunization-print-link")).toBeHidden();
    await expect(page.getByTestId("immunization-import-link")).toBeHidden();

    // …and they are reachable in ≤2 taps: the ⋯, then the item.
    await hydratedClick(
      page,
      page.getByRole("button", { name: "Record actions" })
    );
    const print = page.getByTestId("immunization-print-link");
    await expect(print).toBeVisible();
    await expect(page.getByTestId("immunization-import-link")).toBeVisible();
    await expect(page.getByTestId("immunization-share-open")).toBeVisible();
    // Below `md` the ⋯ is a bottom action sheet, not a desktop context menu
    // hanging off a kebab — the fork lives in AnchoredPanel and no consumer
    // chose it (#3374). Its rows clear the tap floor because the sheet's do.
    const printBox = await print.boundingBox();
    expect(printBox!.height).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    await page.keyboard.press("Escape");

    // THE LIST STARTS 137px HIGHER THAN IT DID. The issue's headline complaint,
    // stated as the number it was measured as — see LIST_TOP_CEILING.
    //
    // ADDRESSED BY THE TABLE, NOT BY "the first /immunizations/ link". That was
    // the first spelling, and it silently measured the PRINT LINK, whose href is
    // `/immunizations/print` — so the control read 315 for a control on the
    // toolbar and would have reported this change as a 92px REGRESSION. A check
    // that matches something other than what it names is worse than no check.
    const table = page.getByTestId("immunization-vaccines-table");
    await expect(table).toBeVisible();
    const box = await table.boundingBox();
    expect(box!.y).toBeLessThan(LIST_TOP_CEILING);
    expect(box!.y).toBeLessThan(VIEWPORT_HEIGHT);
  });

  test("the vaccine list is cards below sm, sortable without header cells", async ({
    page,
  }) => {
    await page.goto("/records/history/immunizations");
    const section = page.getByTestId("records-immunizations");

    // CARDS, NOT A SORT-HEADER TABLE. The DOM keeps ONE `<table>` — that is the
    // whole design of components/ResponsiveTable.tsx, which re-lays the same
    // cells as a stack in CSS rather than authoring a second content tree — so
    // the claim is not "no table element" (the issue's AC says that, and it
    // contradicts the machinery the issue's own body asks for). The claim is that
    // the table PRESENTS as cards: its header row is not painted.
    // Addressed by its own marker, not by `table.table-cards`: the pane holds a
    // SECOND responsive table (the "All recorded doses" history), so the class
    // selector is a strict-mode violation — which is the guard doing its job.
    const table = section.getByTestId("immunization-vaccines-table");
    await expect(table).toBeAttached();
    await expect(table.locator("thead")).toBeHidden();

    // And the columns the desktop grid hides responsively come BACK as labeled
    // meta lines — which is what makes the card a card rather than a lossy table.
    await expect(
      table.locator('td[data-card="meta"]').first() // eslint-disable-line no-restricted-properties -- first-ok: any surviving meta cell proves the card slots are placed
    ).toBeVisible();

    // SORTING MOVED OFF THE HEADER CELLS, because they are gone. One control
    // encoding both axes over the SAME `?sort=`/`?dir=` params the headers write.
    const sort = section.getByLabel("Sort vaccines");
    await expect(sort).toBeVisible();
    await sort.selectOption("vaccine:asc");
    await expect(page).toHaveURL(/sort=vaccine/);
    await expect(page).toHaveURL(/dir=asc/);
  });

  test("the mental-health crisis line stands at phone width", async ({
    page,
  }) => {
    await page.goto("/records/specialty/mental-health");

    // THE INVARIANT THIS ISSUE MAY NOT TOUCH: the crisis affordance renders
    // standing, above the history, at every width — never folded, never below the
    // fold. Nothing in #3408 may demote it, and folding this pane's row actions
    // is exactly the kind of change that could have.
    const link = page.getByTestId("instrument-crisis-support-link");
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box!.y).toBeLessThan(VIEWPORT_HEIGHT);

    // It is ABOVE the history, not merely present somewhere on the page.
    const history = page.getByTestId("instrument-history");
    const historyBox = await history.boundingBox();
    expect(box!.y).toBeLessThan(historyBox!.y);
  });

  test("an instrument reading's actions fold behind the row's sheet", async ({
    page,
  }) => {
    // SUBSTANCE USE, NOT MENTAL HEALTH, because that is where a reading is
    // SEEDED. scripts/seed.ts gives profile 1 one synthetic AUDIT-C score; the
    // mental-health pane is deliberately score-free in the shared seed (its own
    // spec administers questionnaires and owns those writes, #716). Both surfaces
    // render the SAME InstrumentHistoryList — that is the whole reason the
    // component exists — so the row shape asserted here is the row shape there.
    await page.goto("/records/specialty/substance-use");

    const row = page.getByTestId(/^substance-reading-\d+$/).first(); // eslint-disable-line no-restricted-properties -- first-ok: any reading row — the claim is about the row SHAPE, identical on every one
    await expect(row).toBeVisible();

    // NO STANDING DESTRUCTIVE BUTTON. A permanently rendered red "Remove" beside
    // every record was the outlier in this app; every comparable row folds the
    // same two verbs behind the ⋯.
    await expect(row.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Correct" })).toHaveCount(0);

    const trigger = row.getByRole("button", { name: "Reading actions" });
    await expect(trigger).toBeVisible();
    await hydratedClick(page, trigger);
    await expect(page.getByRole("menuitem", { name: "Correct" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Remove" })).toBeVisible();
    await page.keyboard.press("Escape");
    // Focus returns to the trigger — the sheet's invariant (#3374), inherited
    // rather than re-implemented here.
    await expect(trigger).toBeFocused();
  });

  // ── Item B: the Visits pane when there is nothing coming ──────────────────
  //
  // THE PANE'S DEFAULT PROFILE CANNOT SHOW THIS. `scripts/seed.ts` always gives
  // profile 1 appointments, so `upcomingEmpty` is false for every test in this
  // file and `{upcomingEmpty && pastSection}` is dead code under the whole
  // suite — the branch shipped with `data-lead` having zero readers anywhere in
  // the repo, no spec and no CSS. Item B's acceptance criterion ("History →
  // Visits with no appointments shows the PAST list above a one-line empty
  // Upcoming") was unheld, not merely untested.
  //
  // THE FIXTURE IS BORROWED, NOT BUILT. `e2e_hhhist`'s active profile is the
  // household-history PARENT (e2e/seed/illness.ts creates it first so it carries
  // the lower id, which is what the login acts as), and that profile has exactly
  // the shape this criterion needs: one past encounter, an "Annual physical" 40
  // days back, and no appointments at all. Adding a profile to the shared seed to
  // re-create a shape the seed already contains would cost every worker's
  // template build for nothing. READ-ONLY, like every other test here and like
  // the care-trail specs that share this fixture — nothing is written, so the
  // two suites cannot contend.
  test("with no appointments, Visits leads with Past over a compact empty Upcoming", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_HHHIST,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/records/history/visits");

      // The DECLARED order, so a failure says whether the pane chose this shape
      // and mis-rendered it or never chose it.
      await expect(page.getByTestId("visits-body")).toHaveAttribute(
        "data-lead",
        "past"
      );

      // …and the rendered order agrees with the declaration. Both, because the
      // attribute alone would be satisfied by a component that computes the flag
      // correctly and then places the sections the old way.
      expect(await documentOrder(page, "visits-past", "visits-upcoming")).toBe(
        true
      );

      // THE PAST LIST IS REAL, not an empty stand-in that happens to sort first.
      // Without this the test would pass on a profile with no visits at all,
      // which is not the case the criterion is about.
      await expect(
        page.getByTestId("visits-past").getByText("Annual physical").first() // eslint-disable-line no-restricted-properties -- first-ok: this fixture's single seeded encounter
      ).toBeVisible();

      // COMPACT, NOT A BILLBOARD — and "one-line" in the criterion means the
      // compact GRAMMAR, not literally one line of text. Measured at 390px the
      // copy ("No scheduled appointments. Add one to see it here and on
      // Upcoming.") wraps to two lines whatever the padding is, so a literal
      // one-line assertion would fail against a correct render. Said plainly
      // rather than tuned until green.
      //
      // The mechanism is `EmptyState`'s two-value padding vocabulary (`compact`
      // → `p-4`, default → `p-10`), so the computed padding IS the assertion: 16
      // here, 40 for the billboard this replaced, and nothing in between is
      // reachable. Measured: 74px tall now against ~142px for the `p-10` render
      // that used to lead the pane on a 430px screen.
      //
      // The height check is the separate claim that the COPY has not grown: two
      // wrapped lines, never three. It cannot substitute for the padding check —
      // `chrome` is read from the element, so it moves with a padding regression.
      const empty = page
        .getByTestId("visits-upcoming")
        .locator("[data-empty-state]");
      await expect(empty).toBeVisible();
      const box = await empty.evaluate((el) => {
        const st = getComputedStyle(el);
        const px = (v: string) => parseFloat(v) || 0;
        return {
          padTop: st.paddingTop,
          height: el.getBoundingClientRect().height,
          lineHeight: px(st.lineHeight),
          chrome:
            px(st.paddingTop) +
            px(st.paddingBottom) +
            px(st.borderTopWidth) +
            px(st.borderBottomWidth),
        };
      });
      expect(box.padTop).toBe("16px");
      expect(box.lineHeight).toBeGreaterThan(0);
      expect(box.height).toBeLessThan(box.chrome + box.lineHeight * 2.5);
    } finally {
      await page.context().close();
    }
  });
});

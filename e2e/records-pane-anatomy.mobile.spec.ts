import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { hydratedClick } from "./helpers";

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
const TAP_FLOOR = 44;

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
        first.compareDocumentPosition(second) &
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    },
    [firstTestId, secondTestId]
  );
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
      await documentOrder(page, "records-sub-tabs", "immunization-status-filter")
    ).toBe(true);
  });

  test("the Specialty pane strip renders single-line chips", async ({
    page,
  }) => {
    await page.goto("/records/specialty/mental-health");
    const strip = page.getByTestId("records-sub-tabs");
    await expect(strip).toBeVisible();

    // A pill used to be allowed to SHRINK — `flex-nowrap` stops the container
    // wrapping and says nothing about a squeezed item — so six panes on a phone
    // broke their labels over two lines into ~80px pills. A pill that refuses to
    // shrink scrolls out of the row instead, which is what the overflow is for.
    // Measured as "no chip is taller than a one-line chip", which is what
    // "single-line" means and what a class assertion could not tell you.
    const heights = await strip.locator("a").evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height)
    );
    expect(heights.length).toBeGreaterThan(1);
    expect(Math.max(...heights)).toBeLessThan(Math.min(...heights) * 1.6);
  });

  test("Immunizations leads with its records, not with its chrome", async ({
    page,
  }) => {
    await page.goto("/records/history/immunizations");

    // ONE PRIMARY, ONE ⋯ (item C / item G). The add stays; import, print and
    // share fold. Nothing else standing above the list.
    await expect(page.getByTestId("add-immunization-panel-toggle")).toBeVisible();
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
    expect(printBox!.height).toBeGreaterThanOrEqual(TAP_FLOOR);
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
      table.locator('td[data-card="meta"]').first() // first-ok: any surviving meta cell proves the card slots are placed
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

    const row = page.getByTestId(/^substance-reading-\d+$/).first(); // first-ok: any reading row — the claim is about the row SHAPE, identical on every one
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
});

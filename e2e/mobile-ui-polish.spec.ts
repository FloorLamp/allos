import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import { expandTrendsContext } from "./trends-chrome";
import type { Locator } from "@playwright/test";
import {
  expectControlBoxHeight,
  expectNoClippedContent,
  expectPhoneTapTargets,
  hydratedClick,
  openMobileDrawer,
  settledBoxes,
} from "./helpers";
import { CONTROL_BOX_PX, TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";
import { WHATS_NEW_PAGE_ENTRIES, loadReleaseNotes } from "../lib/release-notes";

// Mobile / touch-target polish (#640, #641, #644). Driven at a phone viewport so
// the clipping and undersized-target defects are observable — the desktop layout
// hides them. Reads/clicks only; the family-row check targets a seeded MEMBER
// login so it never deletes anything.
const PHONE = { width: 390, height: 844 };

test.describe("mobile tab strips scroll instead of clipping (#640)", () => {
  test.use({ viewport: PHONE });

  test("the last Trends tab (Insights) is reachable at 390px", async ({
    page,
  }) => {
    await page.goto("/trends");
    // Since #1485 F the strip lives inside the phone context bar and is collapsed
    // by default; expanded, it is the same scroller this has always asserted.
    await expandTrendsContext(page);

    // The strip must be its OWN horizontal scroll container — otherwise <main>'s
    // overflow-x-clip eats any trailing tab a narrower phone (or a longer strip)
    // pushes past the edge. This used to be asserted as "it genuinely overflows at
    // 390px", but #1489 cut the strip to five chips that FIT — the stronger
    // outcome, pinned by trends-compare-fold.mobile.spec.ts — so what survives here
    // is the scroller property itself plus the reachability of the last tab.
    const strip = page.getByRole("tablist");
    const overflowX = await strip.evaluate(
      (el) => getComputedStyle(el).overflowX
    );
    expect(["auto", "scroll"]).toContain(overflowX);
    // Nothing OUTSIDE that scroller sits past the right edge. Element-level
    // (#1543): the shell's clip makes a page-level width comparison read "no
    // overflow" on every page, so it could never have caught a regression here.
    await expectNoClippedContent(page);

    // The Insights tab — last in the strip — is clickable: Playwright scrolls the
    // strip to it, which was impossible when the strip was clipped, not scrollable.
    const insights = page.getByRole("tab", { name: "Insights" });
    // The tab is a real <a href> (#830), so the click navigates natively even in
    // the pre-hydration window — no toPass() retry needed.
    await insights.click();
    await expect(insights).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Date to analyze")).toBeVisible();
  });
});

test.describe("family login-row actions stay in the viewport (#641)", () => {
  test.use({ viewport: PHONE });

  test("a member login's Delete button is within the viewport and clickable", async ({
    page,
  }) => {
    await page.goto("/settings/family");

    // A seeded member login row (never the admin's, whose Delete is disabled).
    const row = page
      .getByTestId("login-row")
      .filter({ hasText: "e2e_child" })
      .first(); // first-ok: filtered to the e2e_child login row (this spec's fixture) — one match
    await expect(row).toBeVisible();

    const del = row.getByRole("button", { name: "Delete" });
    await expect(del).toBeVisible();
    await expect(del).toBeEnabled();

    // The button's right edge must not run off the 390px viewport (the clip bug:
    // the action group used to sit ~90–170px past the edge, unreachable).
    const box = await del.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width + 1);
    expect(box!.x).toBeGreaterThanOrEqual(0);
  });
});

test.describe("touch targets clear the 40px minimum (#644)", () => {
  // `hasTouch`, because the thing being measured is a TOUCH target. #3938 made the
  // floor effective — the control renders the 34px box and a coarse pointer gets
  // the rest back as reach — so a fine-pointer run measures the box and calls it a
  // regression. (It was already a hole: `.tap-target`'s overlay never applied here
  // either, so a control relying on it read as a bare 32.)
  test.use({ viewport: PHONE, hasTouch: true });

  test("the row kebab and dose circles have a >=40px hit box", async ({
    page,
  }) => {
    await page.goto("/nutrition?tab=supplements");

    // The overflow kebab is the sole per-row action affordance; every supplement
    // row renders one.
    const kebab = page.getByTestId("overflow-menu-trigger").first(); // first-ok: every supplement row renders one kebab (see comment) — order-agnostic
    await expectPhoneTapTargets(page, "supplement row kebab", [kebab]);

    // THE TWO DOSE VERBS MOVED, AND THE MIS-TAP COST DID NOT (#3987). The circle
    // pair used to sit on this row; resolving a day's dose is the Day ledger's now,
    // so the Take/Skip pair is measured THERE — same claim, same page family, on the
    // surface that has them. A mis-tap between taken and skipped is a real
    // correctness cost, so the two hit regions must clear the floor AND be disjoint.
    await page.goto("/nutrition");
    const dueRow = page.locator('[data-testid^="ledger-due-group-"]').first(); // first-ok: the pair is read from ONE row (see comment) — order-agnostic
    if ((await dueRow.count()) > 0) {
      await dueRow.click();
      // Scope BOTH circles to the SAME control: a page-wide first-match on each
      // testid can pair circles from two different rows, whose boxes bear no spatial
      // relation (the CI failure mode this scoping replaces).
      const control = page
        .locator('[data-testid="dose-status"][data-variant="circle"]')
        .first(); // first-ok: one control; both its circles are read from it
      await expectPhoneTapTargets(
        page,
        "ledger dose verbs",
        [control.getByTestId("dose-take"), control.getByTestId("dose-skip")],
        { disjoint: true }
      );
    }
    await page.goto("/nutrition?tab=supplements");

    // Only the identity line yields to the action buttons. Supporting text starts
    // below that top row and spans beneath the buttons instead of carrying their
    // empty right gutter down the whole card.
    const patternRow = page
      .getByTestId("supplement-row")
      .filter({ hasText: "Evening Vitamin C (e2e)" });
    const details = patternRow.getByTestId("supplement-row-details");
    const doseBrand = patternRow.getByTestId("supplement-dose-brand");
    const actions = patternRow.getByRole("button", {
      name: "Supplement actions",
    });
    await expect(doseBrand).toContainText("500 mg");
    await expect(details.getByTestId("adherence-summary")).toBeVisible();
    const [detailsBox, actionsBox] = await settledBoxes([details, actions]);
    expect(detailsBox.y).toBeGreaterThanOrEqual(
      actionsBox.y + actionsBox.height
    );
    expect(detailsBox!.x + detailsBox!.width).toBeGreaterThanOrEqual(
      actionsBox!.x + actionsBox!.width
    );
  });
});

// #3514's floor, spelled the way e2e/button-height-floor.mobile.spec.ts spells it.
// Rendered measurements import the small shared design token.

// THE FLOOR THIS MEASURES MOVED UNDER IT. #3377 built these boxes at 40 and this
// test was written to that number; #3514 ruled the floor to 44px EFFECTIVE and the
// assertion below kept passing, because 40 is not less than 40. A bound that survives
// the rule it exists to enforce is not a bound (#3561).
//
// AND IT MOVED AGAIN (#3938/#3954): the day cell and the month arrow render the
// 34px control box now, at every width, and a COARSE pointer gets the rest of the
// 44 back as reach around it. HEIGHT is therefore the box plus whatever reach this
// pointer actually got — read back from the render, so this file (desktop project,
// fine pointer, no reach) demands the box and a touch run demands 44.
//
// AND THEN THE HOST MOVED (#4280, completing #4102). The grid opened in the phone
// nav drawer's full-bleed band; it opens from /history's filter row now, as the
// bottom sheet `components/overlay/AnchoredPanel.tsx` gives every anchored panel
// below `md`. THAT CHANGES WHAT PAYS FOR THE COLUMNS, and the honest version of
// this test is the one that says so rather than the one that keeps the old number:
//
//   * WIDTH USED TO BE A HARD 44 AT EVERY PHONE WIDTH. The drawer was widened to
//     `--week-grid-min` (7 x 44 = 308px) so its band could draw a week even at a
//     320px viewport (#3452/#3536). A bottom sheet pads its content 16px a side
//     and CLIPS what overflows, so the week is now the sheet's content width over
//     seven: 51px at 390 (clears the floor) and 41px at 320 (does not). The token
//     retired with the drawer's claim on it — a min-width inside a clipping sheet
//     buys nothing but a cut-off column.
//   * SO THE INVARIANT ASSERTED HERE IS THE ONE THAT HOLDS AT BOTH WIDTHS — the
//     grid is exactly its host's width and the host is exactly the sheet's content
//     box — AND THE FLOOR IS ASSERTED WHERE IT IS PAYABLE. Both halves are real
//     assertions: neither width is along for the ride.
//
// THE CONTAINMENT HALF IS NOT BOOKKEEPING; it is the defect this move actually
// produced. Built with the drawer band's `-mx-4` breakout, the grid overhung the
// sheet's `overflow-x: hidden` scroller by 16px a side: the first and last columns
// were clipped at rest, and focusing the Next-month arrow scrolled the panel 16px
// left, stranding the Previous-month arrow half off it with no way back — a hidden
// overflow cannot be scrolled by hand. Measured at 320 and 390 both.
const SHEET_GUTTER_PX = 32; // 16px a side, components/BottomSheet.tsx's `px-4`

test.describe("the record's month calendar clears the floor on a phone (#3377/#3514/#4280)", () => {
  test.use({ viewport: PHONE });

  test("the drawer is 20rem wide once the calendar has left it (#4102)", async ({
    page,
  }) => {
    // THE TERM THAT LEFT. The drawer was
    // `max(20rem, --week-grid-min + 1px + safe-area-inset-left)` because the
    // calendar band inside it drew seven 44px columns; #4102's anti-drop census
    // ruled that "20rem preferred stands alone" once the band moved. Asserted at
    // BOTH widths because they answer different questions: at 390 the preferred
    // width is what renders, and at 320 `max-w-full` is what clamps it.
    for (const width of [320, PHONE.width]) {
      await page.setViewportSize({ width, height: PHONE.height });
      await page.goto("/");
      const drawer = await openMobileDrawer(page);
      const [box] = await settledBoxes([drawer]);
      expect(box!.width, `the drawer at a ${width}px viewport`).toBeCloseTo(
        Math.min(width, 320),
        0
      );
      // …and the band really is gone from it, which is what makes the width claim
      // above a claim about the drawer rather than about a calendar that shrank.
      await expect(drawer.getByLabel("Previous month")).toHaveCount(0);
    }
  });

  test("the grid fills the sheet's content box exactly, tiles seven columns, and clears the floor at 390px", async ({
    page,
  }) => {
    test.slow(); // opening the sheet costs a hydration wait on a cold route
    for (const width of [320, PHONE.width]) {
      await page.setViewportSize({ width, height: PHONE.height });
      await page.goto("/history");
      // The SHEET, which is what an anchored panel opens as below `md` — the same
      // fork every ⋯ menu and the date picker take (#3374/#3376). The trigger is
      // in the record's own filter row.
      await hydratedClick(page, page.getByTestId("history-calendar"));
      const sheet = page.getByTestId("history-calendar-sheet");
      await expect(sheet).toBeVisible();
      const prevMonth = sheet.getByLabel("Previous month");
      const nextMonth = sheet.getByLabel("Next month");
      await expect(prevMonth).toBeVisible();
      await settledBoxes([sheet, prevMonth, nextMonth]);

      const geometry = await sheet.evaluate((panel) => {
        const prev = panel.querySelector('[aria-label="Previous month"]')!;
        const host = prev.closest("div")!.parentElement!;
        const scroller = panel.querySelector("[data-sheet-content]")!;
        const grids = host.querySelectorAll(".grid");
        const days = Array.from(grids[grids.length - 1]!.children);
        // The reach as the browser resolved it, per axis: a tiled day cell reaches
        // on the BLOCK axis only, so crediting `top`'s inset to the width would
        // report inline target that does not exist (#3954).
        const box = (el: Element) => {
          const r = el.getBoundingClientRect();
          const after = getComputedStyle(el, "::after");
          const side = (raw: string) => {
            const inset = Math.abs(Number.parseFloat(raw));
            return after.content === "none" || !Number.isFinite(inset)
              ? 0
              : inset;
          };
          return {
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
            reachBlock: side(after.top),
            reachInline: side(after.left),
          };
        };
        const hostRect = host.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        return {
          host: { left: hostRect.left, right: hostRect.right },
          scroller: {
            left: scrollerRect.left,
            right: scrollerRect.right,
            scrollWidth: scroller.scrollWidth,
            clientWidth: scroller.clientWidth,
          },
          days: days.map(box),
          dayCount: days.length,
          glyph: box(days[0]!.firstElementChild!),
          coarse: window.matchMedia("(pointer: coarse)").matches,
        };
      });

      // (1) CONTAINMENT, as a relationship between two real elements rather than
      // against a constant: the grid's host starts and ends exactly where the
      // sheet's scrolling content box does. A host wider than its scroller is
      // content the sheet clips and no one can scroll to.
      expect(
        geometry.host.left,
        `the grid's left edge against the sheet's content box at ${width}px`
      ).toBeCloseTo(geometry.scroller.left, 0);
      expect(
        geometry.host.right,
        `the grid's right edge against the sheet's content box at ${width}px`
      ).toBeCloseTo(geometry.scroller.right, 0);
      // …and the scroller has nothing to scroll sideways, which is the same claim
      // read off the property that made the defect reachable.
      expect(
        geometry.scroller.scrollWidth,
        `the sheet's content scrolls horizontally at ${width}px`
      ).toBe(geometry.scroller.clientWidth);

      // (2) THE COLUMN IS THE SHEET'S CONTENT WIDTH OVER SEVEN, stated as the
      // arithmetic rather than as two frozen numbers, so a change to either the
      // sheet's gutter or the grid's own box fails here and names itself.
      const column = (width - SHEET_GUTTER_PX) / 7;
      expect(geometry.dayCount).toBeGreaterThanOrEqual(28);
      expect(geometry.dayCount % 7).toBe(0);

      // (3) AND THE FLOOR, AT THE WIDTH THAT CAN PAY IT. 390 - 32 = 358, over
      // seven is 51.1px, clear of the 44px inline floor; 320 - 32 = 288 is 41.1px
      // and is not. That second number is the price of the move (#4280) and it is
      // written down here rather than asserted away: a 320px CSS viewport gets a
      // week narrower than the tap floor inside a padded sheet, and the drawer's
      // `--week-grid-min` widening is the thing that used to prevent it.
      if (width === PHONE.width) {
        expect(
          column,
          `a ${width}px viewport buys ${column.toFixed(1)}px columns`
        ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      } else {
        expect(
          column,
          `the ruled ${column.toFixed(1)}px exception stays bounded at ${width}px`
        ).toBeGreaterThan(38);
        expect(
          column,
          `a ${width}px viewport is the case that cannot pay the inline floor — ` +
            "if this stops being true the comment above it is stale"
        ).toBeLessThan(TAP_FLOOR_PX);
      }

      const heightFloor = geometry.coarse ? TAP_FLOOR_PX : CONTROL_BOX_PX;
      for (const [index, day] of geometry.days.entries()) {
        expect(day.w, `day ${index} rendered width`).toBeCloseTo(column, 0);
        // The BOX as an equality, THEN the floor. `>= 44` alone was green on the
        // `h-11 md:h-7` step this issue retired, which is how this very file's
        // 40px bound survived #3514 (see the header).
        expect(day.h, `day ${index} rendered height`).toBe(CONTROL_BOX_PX);
        expect(
          day.h + 2 * day.reachBlock,
          `day ${index}: ${day.h}px rendered + 2x${day.reachBlock}px block reach`
        ).toBeGreaterThanOrEqual(heightFloor);
        // Disjointness on the EXTENDED boxes, which is where two hit regions can
        // fight over a pixel that the rendered boxes never touched.
        if (index % 7 !== 0) {
          const previous = geometry.days[index - 1]!;
          expect(previous.y).toBeCloseTo(day.y, 0);
          expect(
            previous.x + previous.w + previous.reachInline
          ).toBeLessThanOrEqual(day.x - day.reachInline + 0.5);
        }
        if (index >= 7) {
          const above = geometry.days[index - 7]!;
          expect(above.x).toBeCloseTo(day.x, 0);
          expect(above.y + above.h + above.reachBlock).toBeLessThanOrEqual(
            day.y - day.reachBlock + 0.5
          );
        }
      }
      // …and the glyph inside did NOT grow with the cell. This is the
      // padding/hit-slop idiom, not a bigger calendar: 28px circles in the box.
      expect(geometry.glyph.w).toBeLessThanOrEqual(30);

      // The arrows are `.tap-target`, so they reach on BOTH axes and are asserted
      // through the shared helper, which reads the same pointer this page reports.
      // It also contains them in the viewport, which is the half that caught the
      // clipped breakout: the Previous-month arrow read -16px.
      await expectControlBoxHeight(
        prevMonth,
        "the record calendar's back arrow",
        { lines: 0 }
      );
      await expectPhoneTapTargets(page, "the record calendar's month arrows", [
        prevMonth,
        nextMonth,
      ]);

      // The destinations are untouched — growing a hit area must not re-point a day.
      // EVERY day link, not a sampled one: a hit box that grew over its neighbour
      // would still leave the first link's href correct.
      const hrefs = await sheet
        .locator('a[href^="/history?day="]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href") ?? ""));
      expect(hrefs.length).toBeGreaterThan(0);
      const shape = /^\/history\?day=\d{4}-\d{2}-\d{2}$/;
      expect(hrefs.filter((href) => !shape.test(href))).toEqual([]);
      // NO PAGE-WIDE CLIPPING SWEEP HERE, deliberately, and this is not coverage
      // dropped. The sweep was how the drawer's version proved its full-bleed
      // breakout landed flush; assertion (1) above proves the same thing far more
      // precisely — the grid's own box against the box that clips it — and reads
      // the scroll extent that made the defect reachable. What the page sweep
      // would add is everything ELSE on /history — when this was written, a
      // `history-row-title` reaching 565px at 320px, WITH THIS SHEET CLOSED and on
      // rows this file does not touch. That belonged to whoever owns the record's
      // phone density, not to a calendar test that would fail for it. #4394 has
      // since made that title truncate; the reason for keeping the sweep out is
      // the same whatever /history does next.
    }
  });
});

test.describe("nutrition food-log controls stay in the viewport on mobile", () => {
  // `hasTouch` for the same reason as the touch-target block above: the add
  // affordance's floor is effective (#3938), so the reach has to exist to measure.
  test.use({ viewport: PHONE, hasTouch: true });

  test("Food and supplement controls scroll with their tab context", async ({
    page,
  }) => {
    // ONE INTAKE CONTEXT BAR NOW (#3987): the day lens is the Day ledger's, so the
    // Supplements tab has no day chrome of its own to keep in the viewport.
    await page.goto("/nutrition");
    const controls = page.getByTestId("food-log-context");
    await expect(controls).toBeVisible();
    await expect
      .poll(() =>
        controls.evaluate((element) => getComputedStyle(element).position)
      )
      .toBe("static");

    await page.goto("/nutrition?tab=supplements");
    await expect(page.getByTestId("intake-schedule-context")).toHaveCount(0);
    await expect(page.getByTestId("supplement-day-menu-trigger")).toHaveCount(
      0
    );
    await expect(page.getByTestId("supplement-slot-selector")).toHaveCount(0);
    const addIntakeItem = page.getByTestId("supplement-add-toggle");
    await expect(addIntakeItem.locator("svg")).toBeVisible();
    await expect(addIntakeItem.getByText("Add supplement")).toBeHidden();
    await expectPhoneTapTargets(page, "add supplement", [addIntakeItem]);
    await expectNoClippedContent(page);
  });

  test("both intake context bars share the md frost and become static at lg", async ({
    page,
  }) => {
    for (const width of [800, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      // Only Food carries an intake context bar since #3987 retired the Supplements
      // tab's day chrome; the frost rule is asserted on the bar that survives.
      for (const surface of [
        { href: "/nutrition", testId: "food-log-context" },
      ]) {
        await page.goto(surface.href);
        const context = page.getByTestId(surface.testId);
        await expect(context).toBeVisible();
        const style = await context.evaluate((element) => {
          const parent = element.parentElement as HTMLElement;
          const computed = getComputedStyle(element);
          return {
            position: computed.position,
            backgroundColor: computed.backgroundColor,
            backdropFilter: computed.backdropFilter,
            padding: computed.padding,
            bleed: [
              parent.getBoundingClientRect().left -
                element.getBoundingClientRect().left,
              element.getBoundingClientRect().right -
                parent.getBoundingClientRect().right,
            ],
          };
        });
        expect(style.position).toBe(width < 1024 ? "sticky" : "static");
        if (width < 1024) {
          expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
          expect(style.backdropFilter).not.toBe("none");
          expect(style.bleed.every((value) => value > 0)).toBe(true);
        } else {
          expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
          expect(style.backdropFilter).toBe("none");
          expect(style.bleed).toEqual([0, 0]);
          expect(style.padding).toBe("0px");
        }
      }
    }
  });

  // The /nutrition two-column grid (lg:grid-cols-[1fr_320px]) collapses to a
  // single column below lg. A CSS grid item defaults to min-width:auto
  // (min-content), so without min-w-0 on the cells the column grew to the widest
  // food row's intrinsic width (~609px) and overflowed — <main>'s overflow-x-clip
  // then swallowed the +/- log controls off the right edge, making the page's
  // primary action untappable. min-w-0 lets the column shrink to the viewport.
  test("the +/- serving controls are within the 390px viewport", async ({
    page,
  }) => {
    await page.goto("/nutrition");

    // The one-tap logger renders for an adult profile (the seeded admin).
    await expect(page.getByTestId("food-log-bar")).toBeVisible();

    // The first row's add (+) button is the affordance that was clipped off-screen;
    // its right edge must stay within the viewport.
    const addBtn = page.locator('[data-testid^="log-"]').first(); // first-ok: the first log row's add button — the clip test is layout-general (see comment), order-agnostic
    await expect(addBtn).toBeVisible();
    const box = await addBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width + 1);
    expect(box!.x).toBeGreaterThanOrEqual(0);

    // And no OTHER element on the page is pushed off the right edge either
    // (#1543 — element-level, since the shell clips the page-level signal away).
    await expectNoClippedContent(page);
  });
});

// "MORE FOOD GROUPS" IS A CITIZEN OF THE LIST IT EXTENDS (#3362).
//
// It does the same job as the rows above it — reach a food-group row — so it may
// not read as a lighter species of control. It was 42px beside 58px rows, under
// the 44px floor the app's own `tap-target` utility exists to hold, and it sat a
// section gap (20px) below the last quick row while those rows sat 6px apart:
// the rhythm said "new section", the words said "rest of this list".
//
// Both halves are asserted by MEASUREMENT against the rows themselves rather than
// against a literal, so a change to the row idiom moves the expectation with it.
test.describe("the food overflow disclosure matches the list it extends (#3362)", () => {
  test.use({ viewport: PHONE });

  // The app's own touch floor (app/globals.css, `tap-target`), which is what the
  // 42px control was under.

  // Every number this spec compares, read in ONE evaluate so they describe a
  // single layout rather than four independent round-trips (#1538's settledBoxes
  // lesson, applied to a measurement that has no Locator per value).
  async function listMetrics(scope: Locator) {
    return scope.evaluate((root) => {
      const details = root.querySelector(
        '[data-testid="food-more-groups"]'
      ) as HTMLElement;
      const summary = root.querySelector(
        '[data-testid="food-more-groups-summary"]'
      ) as HTMLElement;
      // THE LIST the disclosure now belongs to, taken from the disclosure itself
      // rather than named by a class — that is the relationship under test.
      const list = details.parentElement as HTMLElement;
      // Its immediate neighbour above — the quick rows, as one element.
      const above = details.previousElementSibling as HTMLElement;
      // Quick rows only — anything inside the (closed) disclosure is the overflow
      // this control REACHES, not the list it belongs to. `food-quick-rows` is
      // where that line is drawn, so this reads it rather than re-deriving it.
      const rows = Array.from(
        list.querySelectorAll(
          '[data-testid="food-quick-rows"] li[data-testid^="food-group-"]'
        )
      ) as HTMLElement[];
      const rowBoxes = rows.map((row) => row.getBoundingClientRect());
      const last = rowBoxes.at(-1);
      const detailsBox = details.getBoundingClientRect();
      const summaryBox = summary.getBoundingClientRect();
      const snapshot = document.querySelector(
        '[data-testid="nutrition-mobile-snapshot"]'
      ) as HTMLElement | null;
      return {
        rowCount: rowBoxes.length,
        summaryHeight: summaryBox.height,
        summaryLeft: summaryBox.left,
        summaryRight: summaryBox.right,
        rowHeight: last ? last.height : 0,
        rowLeft: last ? last.left : 0,
        rowRight: last ? last.right : 0,
        // The list's OWN gap, read between the last two of its rows.
        rowGap:
          rowBoxes.length >= 2
            ? rowBoxes[rowBoxes.length - 1].top -
              rowBoxes[rowBoxes.length - 2].bottom
            : NaN,
        // The gap the disclosure sits at, from whatever citizen is above it.
        disclosureGap: detailsBox.top - above.getBoundingClientRect().bottom,
        hasSnapshot: snapshot !== null,
        // The structural guarantee: the nutrient summary can no longer come
        // BETWEEN the rows and the control, because the control is inside the list.
        snapshotBelow: snapshot
          ? snapshot.getBoundingClientRect().top >= detailsBox.top
          : null,
      };
    });
  }

  function expectCitizenOfTheList(m: Awaited<ReturnType<typeof listMetrics>>) {
    expect(m.rowCount).toBeGreaterThanOrEqual(2);
    expect(m.summaryHeight).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    // The row idiom, not a literal height: same card width, and a height within a
    // couple of px of the rows it extends (`min-h-14` against 58px content rows).
    expect(m.summaryLeft).toBeCloseTo(m.rowLeft, 0);
    expect(m.summaryRight).toBeCloseTo(m.rowRight, 0);
    expect(Math.abs(m.summaryHeight - m.rowHeight)).toBeLessThanOrEqual(4);
    // The list's own rhythm, whatever `space-y-1.5` resolves to.
    expect(m.rowGap).toBeGreaterThan(0);
    expect(m.disclosureGap).toBeCloseTo(m.rowGap, 0);
  }

  test("on the Nutrition page, where the nutrient summary is present", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    const bar = page.getByTestId("food-log-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("food-more-groups-summary")).toBeVisible();

    const metrics = await listMetrics(bar);
    expectCitizenOfTheList(metrics);
    expect(
      metrics.hasSnapshot,
      "the seeded profile logs protein and fiber, so this mount renders the nutrient summary — the 'with' half of the acceptance criterion"
    ).toBe(true);
    expect(metrics.snapshotBelow).toBe(true);

    // The behavior and the testids are unchanged — that is an acceptance criterion
    // in its own right, so it is held here rather than left to the specs that
    // merely USE the disclosure to reach a row.
    const details = page.getByTestId("food-more-groups");
    const summary = details.getByTestId("food-more-groups-summary");
    const hidden = details.locator('li[data-testid^="food-group-"]').first(); // first-ok: any overflow row proves the disclosure opened — order-agnostic
    await expect(hidden).toBeHidden();
    await hydratedClick(page, summary);
    await expect(hidden).toBeVisible();
    await summary.click();
    await expect(hidden).toBeHidden();
  });

  test("in the quick-entry food sheet, where it is absent", async ({
    page,
  }) => {
    // The common case the issue was filed from: no nutrient summary at all, so the
    // section gap left the control floating under nothing.
    await page.goto("/?quick=log-food");
    const body = page.getByTestId("quick-entry-body");
    await expect(body).toHaveAttribute("data-form", "food");
    await expect(body.getByTestId("food-more-groups-summary")).toBeVisible();

    const metrics = await listMetrics(body.getByTestId("food-log-bar"));
    expectCitizenOfTheList(metrics);
    expect(metrics.hasSnapshot).toBe(false);
  });
});

test.describe("long unbreakable names wrap instead of clipping (#646)", () => {
  test.use({ viewport: PHONE });

  // A slash-joined combination-drug name behaves as one long token (no space to
  // break at) — the realistic case that overflowed the medicine row.
  const NAME =
    "Hydrochlorothiazide/Lisinopril/Amlodipine/Metoprolol/Atorvastatin/Losartan";

  test("a long-token item name stays within the 390px row", async ({
    page,
  }) => {
    await page.goto("/nutrition?tab=supplements");

    await page.getByTestId("supplement-add-toggle").click();
    const addDialog = page.getByRole("dialog", { name: "Add supplement" });
    await addDialog.getByLabel("Name").fill(NAME);
    const doseEditor1 = await openFact(page, "dose", addDialog);
    await doseEditor1.getByLabel("Amount").first().fill("1 tab"); // first-ok: the first dose's Amount field in the scoped add modal
    await doseEditor1.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the first dose's Time-of-day field in the scoped add modal
    await closeEditor(page, addDialog);
    // Submit by keyboard as well as exercising the modal's focusable controls. The
    // dev-only Next overlay portal can cover the bottom edge of a 390px viewport;
    // production has no overlay, and Enter is the real accessible submit path.
    await addDialog.getByRole("button", { name: "Add", exact: true }).focus();
    await page.keyboard.press("Enter");

    const name = page
      .getByTestId("intake-item-name")
      .filter({ hasText: "Hydrochlorothiazide" })
      .first(); // first-ok: filtered to the Hydrochlorothiazide med this spec added — one match
    await expect(name).toBeVisible();

    // The name box right edge stays within the viewport — it wraps (break-words)
    // rather than running off the clipped-right edge.
    const box = await name.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width + 1);

    // Clean up so the fixture is left as found.
    const row = page.locator("div.card").filter({ hasText: NAME });
    await row.getByRole("button", { name: "Supplement actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.locator("div.card").filter({ hasText: NAME })
    ).toHaveCount(0);
  });
});

// THE PAGER IS THUMB-SIZED BELOW `md` (#3378).
//
// `PaginationControls` was the desktop footer idiom at every width: ~36px
// `btn-ghost text-sm` steps bunched into the row's right half. It renders on four
// phone surfaces (/whats-new, the sleep↔mood history, the Trends body history, the
// dose ledger) plus, since #3378, the two admin log viewers and the Data → Manage
// dataset card, which had each hand-rolled a copy of it instead.
//
// MEASURED ON TWO MOUNTS, ONE PER NAVIGATION MODE — the URL-borne link steps and
// the in-memory button steps are different elements, and only a measurement can
// tell whether the 44px is real (the `tap-target` utility's own extension is a
// coarse-pointer `::after`, which no layout read can see). That every OTHER pager
// in the app is the same component — so the same measurement covers them — is
// asserted where it is cheap, in lib/__tests__/pager-idiom.test.ts, rather than by
// booting five more routes here.
test.describe("the pager offers thumb-sized steps at 390px (#3378)", () => {
  // `hasTouch`, because the claim is about a THUMB. #3938 made the 44 effective:
  // the step renders the control box and a coarse pointer gets the rest back as
  // reach, so a fine-pointer phone viewport would measure a real 34px control and
  // read it as a regression. The step's own `min-w-16` is still rendered width.
  test.use({ viewport: PHONE, hasTouch: true });

  // The app's own touch floor (app/globals.css, `tap-target`; #644).

  // Every number compared here, read in ONE evaluate so they describe a single
  // layout rather than three independent round-trips (#1538's settledBoxes
  // lesson, applied to a measurement that has no Locator per value).
  async function pagerMetrics(pager: Locator) {
    return pager.evaluate((row) => {
      // The slot's single element child IS the control, whichever of the three
      // shapes it currently has (button / link / disabled span) — see
      // components/PaginationControls.tsx.
      const steps = Array.from(
        row.querySelectorAll("[data-pager-step] > *")
      ) as HTMLElement[];
      const rowBox = row.getBoundingClientRect();
      const rowStyle = getComputedStyle(row);
      return {
        labels: steps.map((el) => (el.textContent ?? "").trim()),
        boxes: steps.map((el) => {
          const r = el.getBoundingClientRect();
          const after = getComputedStyle(el, "::after");
          const reach =
            after.content === "none"
              ? 0
              : Math.abs(Number.parseFloat(after.top)) || 0;
          return {
            width: r.width,
            height: r.height,
            reach,
            left: r.left,
            right: r.right,
          };
        }),
        // The row's CONTENT edges — its own `px-3` is chrome, not distance
        // between the controls, and reading it here means the expectation moves
        // with the padding instead of pinning today's 12px.
        rowLeft: rowBox.left + parseFloat(rowStyle.paddingLeft),
        rowRight: rowBox.right - parseFloat(rowStyle.paddingRight),
        // The page sentence collapses into the extent below `md` — one piece of
        // text between two thumb targets, not two. Read as innerText, not
        // textContent: the sentence is still IN the DOM (one set of controls,
        // re-ordered, never a `md:hidden`/`hidden md:flex` pair), so only a
        // rendered read can tell whether it is on screen.
        pageSentence: /Page \d+ of \d+/.test((row as HTMLElement).innerText),
      };
    });
  }

  function expectThumbShape(m: Awaited<ReturnType<typeof pagerMetrics>>) {
    expect(m.labels).toEqual(["Prev", "Next"]);
    for (const box of m.boxes) {
      // The box is the box, and the thumb reaches the floor around it (#3938).
      expect(box.height).toBe(CONTROL_BOX_PX);
      expect(box.height + 2 * box.reach).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      expect(box.width).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    }
    // At the row's EDGES, with the extent between them — the thumb shape, not the
    // desktop huddle. Measured against the row itself, so its padding moves the
    // expectation with it.
    const [prev, next] = m.boxes;
    expect(prev.left - m.rowLeft).toBeLessThanOrEqual(2);
    expect(m.rowRight - next.right).toBeLessThanOrEqual(2);
    expect(m.pageSentence).toBe(false);
  }

  // #3867: the trailing link run that clipped is never on page 1 — page 1's
  // longest entry carries 3 issue links and it takes 4+ to overflow 390px — so
  // the containment check below passed for as long as it only ever saw page 1.
  // DERIVED, not pinned: the notes file is append-only, so the entry holding the
  // longest run drifts one page further back every WHATS_NEW_PAGE_ENTRIES notes.
  const ENTRIES = loadReleaseNotes().days.flatMap((day) => day.entries);
  const LONGEST = ENTRIES.reduce((a, b) =>
    b.issues.length > a.issues.length ? b : a
  );
  const LONGEST_PAGE =
    Math.floor(ENTRIES.indexOf(LONGEST) / WHATS_NEW_PAGE_ENTRIES) + 1;

  test("link steps: /whats-new", async ({ page }) => {
    await page.goto("/whats-new");
    const pager = page.getByTestId("whats-new-pagination");
    await expect(pager).toBeVisible();
    // Wait for the CONTENT being measured, not the container: the steps only
    // exist once the page knows there is more than one page.
    await expect(pager.getByRole("link", { name: "Next" })).toBeVisible();
    expectThumbShape(await pagerMetrics(pager));
    await expectNoClippedContent(page);

    // And again where the long link runs live. Wait for the run itself, not the
    // entry: a half-painted entry fits any width, so the measurement would be
    // taken against a placeholder (#3384).
    await page.goto(`/whats-new?page=${LONGEST_PAGE}`);
    const entry = page.getByTestId("whats-new-entry").filter({
      has: page.getByRole("link", { name: `#${LONGEST.pr}`, exact: true }),
    });
    await expect(entry.getByRole("link", { name: /^issue #/ })).toHaveCount(
      LONGEST.issues.length
    );
    await expectNoClippedContent(page);
  });

  test("button steps: the Data → Manage dataset card", async ({ page }) => {
    await page.goto("/data?section=manage");
    const pager = page.getByTestId("dataset-medical_records-pagination");
    await expect(pager).toBeVisible();
    await expect(pager.getByRole("button", { name: "Next" })).toBeVisible();
    expectThumbShape(await pagerMetrics(pager));
  });

  // Page semantics are the thing a shape change must NOT touch: the step still
  // turns the URL, and the URL still turns the read.
  test("the URL round-trip is unchanged", async ({ page }) => {
    await page.goto("/whats-new");
    const pager = page.getByTestId("whats-new-pagination");
    await expect(pager).toBeVisible();
    // hydratedClick, not followLink: a pager's Next is a RELATIVE step, so a
    // retried click would walk to page 3 instead of re-asserting page 2.
    await hydratedClick(page, pager.getByRole("link", { name: "Next" }));
    await page.waitForURL(/\/whats-new\?page=2$/);
    await expect(page.getByTestId("whats-new-pagination")).toContainText(
      "Showing"
    );
    await hydratedClick(
      page,
      page
        .getByTestId("whats-new-pagination")
        .getByRole("link", { name: "Prev" })
    );
    // Page 1's href is the bare route, not `?page=1` — the pager hands the URL
    // back exactly as it found it.
    await page.waitForURL(/\/whats-new$/);
  });
});

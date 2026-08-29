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

    // Dose take/skip circles render on any due, active dose. When present, both
    // clear 40px and don't overlap (a mis-tap between taken and skipped on a
    // medication is a real correctness cost). Scope BOTH circles to the SAME
    // dose-status control — a page-wide first-match on each testid can pair circles
    // from two different rows, whose boxes bear no spatial relation (the CI
    // failure mode this replaces).
    // The 40px sizing applies to the CIRCLE variant; the pill variant (compact
    // by design) also renders on this page, so target circles explicitly.
    const control = page
      .locator('[data-testid="dose-status"][data-variant="circle"]')
      .first(); // first-ok: one dose-status control; BOTH its circles are read from this SAME control (see comment) — order-agnostic
    if ((await control.count()) > 0) {
      const take = control.getByTestId("dose-take");
      const skip = control.getByTestId("dose-skip");
      // Effective, and DISJOINT: the circles render the control box now, and the
      // control's own padding plus its `gap-3` are what keep the two hit regions
      // from meeting over the same point (#3938).
      await expectPhoneTapTargets(page, "dose circles", [take, skip], {
        disjoint: true,
      });
      const tBox = await take.boundingBox();
      const sBox = await skip.boundingBox();
      expect(tBox).not.toBeNull();
      expect(sBox).not.toBeNull();
      // Within one control (a no-wrap flex row) the skip circle sits fully to
      // the right of the take circle, with the widened gap between them.
      expect(sBox!.x).toBeGreaterThanOrEqual(tBox!.x + tBox!.width);
    }

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
// 44 back as reach around it. The two claims here are therefore different on the
// two axes and the difference is the design. HEIGHT is the box plus whatever reach
// this pointer actually got — read back from the render, so this file (desktop
// project, fine pointer, no reach) demands the box and a touch run demands 44.
// WIDTH stays a hard 44: a day cell is as wide as its grid column, the column is
// what `--week-grid-min` buys, and nothing about the box changed that.
//
// What seven day columns cost is `--week-grid-min` (app/globals.css, #3452) — the
// drawer's width class and the calendar band both read it, and neither derives it
// any more. #3536 widened the drawer enough to pay that bill even at a 320px
// viewport; no exception or overlapping hit slop remains.
//
// THIS IS THE RENDERED PROOF for the token swap. The browser says whether the
// columns still land where they did, which is why #3452's ownership fix was
// measured here rather than asserted to be geometry-neutral.
test.describe("the phone drawer's month calendar clears the floor too (#3377/#3514)", () => {
  test.use({ viewport: PHONE });

  test("every day cell is a 44px-wide column, one control box tall, and disjoint at 320px and 390px", async ({
    page,
  }) => {
    test.slow(); // opening the drawer costs a hydration wait on a cold route
    for (const width of [320, PHONE.width]) {
      await page.setViewportSize({ width, height: PHONE.height });
      await page.goto("/");
      // The drawer, not the desktop sidebar: `components/MobileNav.tsx` renders the
      // SAME <SidebarContent> — and therefore the same <EventCalendar> — inside
      // the phone nav drawer, which is what makes this grid a phone surface at all.
      const drawer = await openMobileDrawer(page);
      const prevMonth = drawer.getByLabel("Previous month");
      const nextMonth = drawer.getByLabel("Next month");
      await expect(prevMonth).toBeVisible();
      const [drawerBox] = await settledBoxes([drawer, prevMonth, nextMonth]);

      // THE TOKEN RESOLVES TO THE WIDTH IT REPLACED (#3452), measured rather than
      // asserted to be so. `--week-grid-min` costs a week; the drawer adds its own
      // 1px right border and the left safe-area inset (0 in a headless browser),
      // and 20rem stays the preferred width — so a phone this narrow gets exactly
      // 320px, which is what the retired `19.3125rem` literal resolved to too.
      //
      // DERIVED FROM THE FLOOR, not frozen at 320: if #3514's number ever moves,
      // this expectation moves with it and the drawer had better follow. That is
      // the whole reason the literal went.
      const DRAWER_BORDER_PX = 1;
      const drawerPreferredPx = 320;
      expect(drawerBox.width).toBeCloseTo(
        Math.min(
          width,
          Math.max(drawerPreferredPx, 7 * TAP_FLOOR_PX + DRAWER_BORDER_PX)
        ),
        0
      );
      // …and the calendar band CLAIMS that week rather than trusting the drawer to
      // have reserved it. This is the computed value of the shared token, read off
      // the element that consumes it — the second half of "one owner".
      await expect
        .poll(() =>
          drawer
            .locator('[aria-label="Previous month"]')
            .evaluate(
              (el) =>
                getComputedStyle(el.closest("div")!.parentElement!).minWidth
            )
        )
        .toBe(`${7 * TAP_FLOOR_PX}px`);

      // Both arrows AND every day of the rendered month — a floor that only the
      // first cell clears is not a floor. The 28px circle and the 16px chevron are
      // unchanged; what is measured here is the box a finger lands in.
      const cells = await drawer.evaluate((aside) => {
        const prev = aside.querySelector('[aria-label="Previous month"]')!;
        const calendar = prev.closest("div")!.parentElement!;
        const grids = calendar.querySelectorAll(".grid");
        const days = Array.from(grids[grids.length - 1].children);
        // The reach as the browser resolved it, per axis: a tiled day cell reaches
        // on the BLOCK axis only, so crediting `top`'s inset to the width would
        // report 12px of inline target that does not exist (#3954).
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
        return {
          days: days.map(box),
          dayCount: days.length,
          glyph: box(days[0].firstElementChild!),
          coarse: window.matchMedia("(pointer: coarse)").matches,
        };
      });
      expect(cells.dayCount).toBeGreaterThanOrEqual(28);
      const heightFloor = cells.coarse ? TAP_FLOOR_PX : CONTROL_BOX_PX;
      for (const [index, day] of cells.days.entries()) {
        expect(day.w + 2 * day.reachInline).toBeGreaterThanOrEqual(
          TAP_FLOOR_PX
        );
        // The BOX as an equality, THEN the floor. `>= 44` alone was green on the
        // `h-11 md:h-7` step this issue retired, which is how this very file's
        // 40px bound survived #3514 (see the header).
        expect(day.h, `day ${index} rendered height`).toBe(CONTROL_BOX_PX);
        expect(
          day.h + 2 * day.reachBlock,
          `day ${index}: ${day.h}px rendered + 2x${day.reachBlock}px block reach`
        ).toBeGreaterThanOrEqual(heightFloor);
        // Disjointness on the EXTENDED boxes, which is where two hit regions can
        // now fight over a pixel that the rendered boxes never touched.
        if (index % 7 !== 0) {
          const previous = cells.days[index - 1];
          expect(previous.y).toBeCloseTo(day.y, 0);
          expect(
            previous.x + previous.w + previous.reachInline
          ).toBeLessThanOrEqual(day.x - day.reachInline + 0.5);
        }
        if (index >= 7) {
          const above = cells.days[index - 7];
          expect(above.x).toBeCloseTo(day.x, 0);
          expect(above.y + above.h + above.reachBlock).toBeLessThanOrEqual(
            day.y - day.reachBlock + 0.5
          );
        }
      }
      // …and the glyph inside did NOT grow with it. This is the padding/hit-slop
      // idiom, not a bigger calendar: 28px circles inside the control box.
      expect(cells.glyph.w).toBeLessThanOrEqual(30);

      // The arrows are `.tap-target`, so they reach on BOTH axes and are asserted
      // through the shared helper, which reads the same pointer this page reports.
      await expectControlBoxHeight(
        prevMonth,
        "the drawer calendar's back arrow",
        {
          lines: 0,
        }
      );
      await expectPhoneTapTargets(page, "the drawer calendar's month arrows", [
        prevMonth,
        nextMonth,
      ]);

      // The destinations are untouched — growing a hit area must not re-point a day.
      // EVERY day link, not a sampled one: a hit box that grew over its neighbour
      // would still leave the first link's href correct.
      const hrefs = await drawer
        .locator('a[href^="/timeline?from="]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href") ?? ""));
      expect(hrefs.length).toBeGreaterThan(0);
      const shape =
        /^\/timeline\?from=(\d{4}-\d{2}-\d{2})&to=\1#timeline-day-\1$/;
      expect(hrefs.filter((href) => !shape.test(href))).toEqual([]);
      // Nothing in the drawer sits past the viewport: the calendar gives up the
      // drawer's own side padding to buy those 44px columns, so this is the check
      // that the breakout lands flush rather than overhanging.
      await expectNoClippedContent(page);
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
    for (const surface of [
      { href: "/nutrition", testId: "food-log-context" },
      {
        href: "/nutrition?tab=supplements",
        testId: "intake-schedule-context",
      },
    ]) {
      await page.goto(surface.href);
      const controls = page.getByTestId(surface.testId);
      await expect(controls).toBeVisible();
      await expect
        .poll(() =>
          controls.evaluate((element) => getComputedStyle(element).position)
        )
        .toBe("static");
    }

    const supplementDate = page.getByTestId("supplement-day-menu-trigger");
    await expect(
      page
        .getByTestId("supplement-context-heading")
        .getByTestId("supplement-day-menu-trigger")
    ).toBeVisible();
    await expect(supplementDate).toHaveAttribute("data-button-control", "");
    await expect(supplementDate).toHaveAccessibleName("Choose day to review");
    await expect(page.getByTestId("supplement-day-toggle")).toBeHidden();
    await supplementDate.click();
    const supplementDateMenu = page.getByTestId("supplement-day-menu");
    await expect(supplementDateMenu).toBeVisible();
    await supplementDateMenu
      .getByRole("menuitemradio", { name: "Yesterday" })
      .click();
    await expect(
      page.getByTestId("supplement-context-heading")
    ).toHaveAccessibleName("Yesterday Supplements");
    await supplementDate.click();
    await page
      .getByTestId("supplement-day-menu")
      .getByRole("menuitemradio", { name: "Today" })
      .click();
    await expect(page.getByTestId("supplements-status-mobile")).toHaveText(
      /^(?:\d+\/\d+ taken|0 scheduled)$/
    );
    const addIntakeItem = page.getByTestId("supplement-add-toggle");
    await expect(addIntakeItem.locator("svg")).toBeVisible();
    await expect(addIntakeItem.getByText("Add supplement")).toBeHidden();
    await expectPhoneTapTargets(page, "add supplement", [addIntakeItem]);

    const slots = page.getByTestId("supplement-slot-selector");
    const [all, morning, midday, evening] = await settledBoxes([
      slots.getByTestId("supplement-slot-all"),
      slots.getByTestId("supplement-slot-morning"),
      slots.getByTestId("supplement-slot-midday"),
      slots.getByTestId("supplement-slot-evening"),
    ]);
    expect(all.x).toBeLessThan(morning.x);
    expect(morning.x).toBeLessThan(midday.x);
    expect(midday.x).toBeLessThan(evening.x);
    expect(all.y).toBeCloseTo(morning.y, 0);
    expect(morning.y).toBeCloseTo(midday.y, 0);
    expect(midday.y).toBeCloseTo(evening.y, 0);
    expect(evening.height).toBeGreaterThanOrEqual(48);
    await expectNoClippedContent(page);
  });

  test("both intake context bars share the md frost and become static at lg", async ({
    page,
  }) => {
    for (const width of [800, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      for (const surface of [
        { href: "/nutrition", testId: "food-log-context" },
        {
          href: "/nutrition?tab=supplements",
          testId: "intake-schedule-context",
        },
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

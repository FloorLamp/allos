import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import { expandTrendsContext } from "./trends-chrome";
import type { Locator } from "@playwright/test";
import {
  expectNoClippedContent,
  hydratedClick,
  openMobileDrawer,
  settledBoxes,
} from "./helpers";

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
  test.use({ viewport: PHONE });

  test("the row kebab and dose circles have a >=40px hit box", async ({
    page,
  }) => {
    await page.goto("/nutrition?tab=supplements");

    // The overflow kebab is the sole per-row action affordance; every supplement
    // row renders one.
    const kebab = page.getByTestId("overflow-menu-trigger").first(); // first-ok: every supplement row renders one kebab (see comment) — order-agnostic
    await expect(kebab).toBeVisible();
    const kBox = await kebab.boundingBox();
    expect(kBox).not.toBeNull();
    expect(kBox!.width).toBeGreaterThanOrEqual(40);
    expect(kBox!.height).toBeGreaterThanOrEqual(40);

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
      const tBox = await control.getByTestId("dose-take").boundingBox();
      const sBox = await control.getByTestId("dose-skip").boundingBox();
      expect(tBox).not.toBeNull();
      expect(sBox).not.toBeNull();
      expect(tBox!.width).toBeGreaterThanOrEqual(40);
      expect(tBox!.height).toBeGreaterThanOrEqual(40);
      expect(sBox!.width).toBeGreaterThanOrEqual(40);
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

test.describe("the phone drawer's month calendar clears the floor too (#3377)", () => {
  test.use({ viewport: PHONE });

  test("every day cell and both month arrows have a >=40px hit area in the drawer", async ({
    page,
  }) => {
    test.slow(); // opening the drawer costs a hydration wait on a cold route
    await page.goto("/");
    // The drawer, not the desktop sidebar: `components/MobileNav.tsx` renders the
    // SAME <SidebarContent> — and therefore the same <TrainingLogCalendar> — inside
    // the phone nav drawer, which is what makes this grid a phone surface at all.
    // The desktop copy is `display: none` here and would measure 0.
    const drawer = await openMobileDrawer(page);
    const prevMonth = drawer.getByLabel("Previous month");
    const nextMonth = drawer.getByLabel("Next month");
    await expect(prevMonth).toBeVisible();
    // Settle the drawer's slide-in before reading any box: mid-animation the aside
    // is still translated and every child reads a few pixels off.
    await settledBoxes([drawer, prevMonth, nextMonth]);

    // Both arrows AND every day of the rendered month — a floor that only the
    // first cell clears is not a floor. The 28px circle and the 16px chevron are
    // unchanged; what is measured here is the box a finger lands in.
    const cells = await drawer.evaluate((aside) => {
      const prev = aside.querySelector('[aria-label="Previous month"]')!;
      const calendar = prev.closest("div")!.parentElement!;
      const grids = calendar.querySelectorAll(".grid");
      const days = Array.from(grids[grids.length - 1].children);
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      };
      return {
        days: days.map(box),
        dayCount: days.length,
        glyph: box(days[0].firstElementChild!),
      };
    });
    expect(cells.dayCount).toBeGreaterThanOrEqual(28);
    for (const day of cells.days) {
      expect(day.w).toBeGreaterThanOrEqual(40);
      expect(day.h).toBeGreaterThanOrEqual(40);
    }
    // …and the glyph inside did NOT grow with it. This is the padding/hit-slop
    // idiom, not a bigger calendar: 28px circles, 40px targets.
    expect(cells.glyph.w).toBeLessThanOrEqual(30);

    const [prevBox, nextBox] = await settledBoxes([prevMonth, nextMonth]);
    for (const arrow of [prevBox, nextBox]) {
      expect(arrow.width).toBeGreaterThanOrEqual(40);
      expect(arrow.height).toBeGreaterThanOrEqual(40);
    }

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
    // drawer's own side padding to buy those 40px columns, so this is the check
    // that the breakout lands flush rather than overhanging.
    await expectNoClippedContent(page);
  });
});

test.describe("nutrition food-log controls stay in the viewport on mobile", () => {
  test.use({ viewport: PHONE });

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
    await expect(supplementDate).toHaveCSS("border-top-width", "0px");
    await expect(page.getByTestId("supplement-day-toggle")).toBeHidden();
    await supplementDate.click();
    const supplementDateMenu = page.getByTestId("supplement-day-menu");
    await expect(supplementDateMenu).toBeVisible();
    await expect(supplementDateMenu.getByRole("menuitemradio")).toHaveCount(7);
    await expect(
      supplementDateMenu.getByRole("menuitemradio", { name: "Today" })
    ).toHaveAttribute("aria-checked", "true");
    await supplementDateMenu
      .getByRole("menuitemradio", { name: "Today" })
      .click();
    await expect(page.getByTestId("supplements-status-mobile")).toHaveText(
      /^(?:\d+\/\d+ taken|0 scheduled)$/
    );
    const addIntakeItem = page.getByTestId("supplement-add-toggle");
    await expect(addIntakeItem.locator("svg")).toBeVisible();
    await expect(addIntakeItem.getByText("Add supplement")).toBeHidden();
    const addSupplementBox = await addIntakeItem.boundingBox();
    expect(addSupplementBox).not.toBeNull();
    expect(addSupplementBox!.width).toBeGreaterThanOrEqual(40);
    expect(addSupplementBox!.height).toBeGreaterThanOrEqual(40);

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
  const TAP_FLOOR = 44;

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
    expect(m.summaryHeight).toBeGreaterThanOrEqual(TAP_FLOOR);
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
  test.use({ viewport: PHONE });

  // The app's own touch floor (app/globals.css, `tap-target`; #644).
  const TAP_FLOOR = 44;

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
          return {
            width: r.width,
            height: r.height,
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
      expect(box.height).toBeGreaterThanOrEqual(TAP_FLOOR);
      expect(box.width).toBeGreaterThanOrEqual(TAP_FLOOR);
    }
    // At the row's EDGES, with the extent between them — the thumb shape, not the
    // desktop huddle. Measured against the row itself, so its padding moves the
    // expectation with it.
    const [prev, next] = m.boxes;
    expect(prev.left - m.rowLeft).toBeLessThanOrEqual(2);
    expect(m.rowRight - next.right).toBeLessThanOrEqual(2);
    expect(m.pageSentence).toBe(false);
  }

  test("link steps: /whats-new", async ({ page }) => {
    await page.goto("/whats-new");
    const pager = page.getByTestId("whats-new-pagination");
    await expect(pager).toBeVisible();
    // Wait for the CONTENT being measured, not the container: the steps only
    // exist once the page knows there is more than one page.
    await expect(pager.getByRole("link", { name: "Next" })).toBeVisible();
    expectThumbShape(await pagerMetrics(pager));
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

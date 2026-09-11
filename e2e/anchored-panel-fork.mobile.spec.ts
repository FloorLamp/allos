import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import {
  appContent,
  awaitHydrated,
  expectControlBoxHeight,
  expectPhoneTapTargets,
  hydratedClick,
  openFoodAdd,
  settledBoxes,
  settledClick,
  settledFill,
  settledSelectSave,
  touchSwipeFrom,
} from "./helpers";
import { openRecordFact } from "./record-facts-helpers";
import { parseTypedClock } from "@/lib/format-date";
import { TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";
import { ANCHOR_GAP, ANCHOR_MARGIN } from "@/lib/anchored-position";

// THE ANCHORED PANEL FORKS AT `md` (issues #3374, #3376).
//
// Below `md` a ⋯ menu and a date picker open as BOTTOM SHEETS on the responsive
// host; from `md` up they stay the trigger-anchored popover they have always
// been. The decision is made once, in components/overlay/AnchoredPanel.tsx, so
// these tests drive TWO consumers of the menu (a medication row and a food-log
// serving) and one of the calendar — enough to show the fork arrives without any
// of them asking for it.
//
// What is asserted is the HOST and the TAP FLOOR, plus the one thing a host swap
// could quietly break: that a menu item still runs its action, and that focus
// comes back to the trigger. The menu's items, their handlers and their testids
// are unchanged by design, which is why the rest of the suite's ⋯ coverage still
// applies at both widths.
//
// This file runs in the `mobile` project, so `page` is 390×844 with touch. The
// last describe overrides the viewport to 1280 — touch and all, which is the
// honest tablet case — to pin the other side of the fork.

// The phone tap floor (#644). Sheet rows meet it by construction.
// What a popover row rises to when a COARSE pointer is doing the tapping. Lower
// than the phone floor on purpose: the popover is a compact desktop surface and
// this is the minimum a finger is owed there, not the phone's comfortable row.
const COARSE_POINTER_FLOOR = 40;

test.describe("below md the ⋯ menu is a bottom action sheet", () => {
  test("a medication row's menu opens as a sheet, keeps its actions, and hands focus back", async ({
    page,
  }) => {
    await page.goto("/medications");
    // eslint-disable-next-line no-restricted-properties -- first-ok: any medication row proves the shared fork — order-agnostic
    const trigger = page
      .getByRole("button", { name: "Medication actions" })
      .first();
    await expect(trigger).toBeVisible();
    await hydratedClick(page, trigger);

    // The HOST is the sheet, and the panel says so itself rather than leaving a
    // reader to infer it from a width.
    const sheet = page.getByTestId("overflow-menu-sheet");
    await expect(sheet).toBeVisible();
    const menu = page.getByRole("menu");
    await expect(menu).toHaveAttribute("data-anchored-panel", "sheet");
    // The sheet is NAMED by the trigger it came from — the row is behind a scrim
    // now, so the heading is the only thing saying whose actions these are.
    //
    // That sentence is #3501's whole argument, and until #3501 this line asserted
    // the one heading that could not satisfy it: "Medication actions" names a KIND,
    // and every medication row on the page produced the same one, so the heading
    // said nothing about whose actions were on screen. The name now carries the row.
    //
    // Compared against the TRIGGER's own accessible name rather than a literal,
    // because "named by the trigger it came from" is the actual claim — and the
    // trigger above is reached by POSITION, so a literal would have to hard-code
    // whichever medication the fixture happens to sort first.
    const triggerName = await trigger.getAttribute("aria-label");
    expect(triggerName, "the ⋯ trigger must carry an accessible name").toMatch(
      /^Medication actions for .+/
    );
    await expect(sheet.getByRole("heading")).toHaveText(triggerName!);

    // The items are the same items, addressed the same way.
    const items = menu.getByRole("menuitem");
    await expect(items.filter({ hasText: "Edit" })).toBeVisible();
    // Wait for the LAST item before measuring anything: a sheet whose rows have
    // not all mounted measures whatever happened to be there.
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(2);
    await expect(items.nth(count - 1)).toBeVisible();
    const boxes = await settledBoxes(
      Array.from({ length: count }, (_, i) => items.nth(i))
    );
    for (const [i, box] of boxes.entries()) {
      expect(
        box.height,
        `menu row ${i} should meet the ${TAP_FLOOR_PX}px tap floor in the sheet`
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    }

    // Dismissal is discard, which is a menu's whole contract — and the trigger
    // gets focus back, in this presentation by the sheet's focus trap.
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("a food-log serving's menu runs its action from the sheet", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/nutrition");
    await openFoodAdd(page);
    const group = page.getByTestId("food-group-nuts_seeds");
    if (!(await group.isVisible())) {
      await page.getByTestId("food-more-groups-summary").click();
      await expect(group).toBeVisible();
    }

    // This test logs its OWN serving and removes it again through the product's
    // own row action, so it leaves the shared profile as it found it — the same
    // fixture discipline as e2e/food-log-correction.spec.ts.
    const rows = page.getByTestId("day-ledger").locator("li[data-group]");
    const before = await rows.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-testid") ?? "")
    );
    await settledClick(page, page.getByTestId("log-nuts_seeds"));
    await expect(rows).toHaveCount(before.length + 1);
    const added = (
      await rows.evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-testid") ?? "")
      )
    ).filter((id) => !before.includes(id));
    expect(added).toHaveLength(1);
    const eventId = added[0].replace("ledger-serving-", "");

    const row = page.getByTestId(`ledger-serving-${eventId}`);
    await hydratedClick(
      page,
      row.getByRole("button", { name: /^Actions for the/ })
    );
    await expect(page.getByTestId("overflow-menu-sheet")).toBeVisible();

    // THE INVARIANT THIS TEST EXISTS FOR: the item's testid and its handler are
    // untouched by the host swap, so the same tap that removed a serving from a
    // popover removes it from a sheet.
    const remove = page.getByTestId(`ledger-serving-remove-${eventId}`);
    const [removeBox] = await settledBoxes([remove]);
    expect(removeBox.height).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    await settledClick(page, remove);
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId("overflow-menu-sheet")).toHaveCount(0);
  });
});

test.describe("below md the date picker is a bottom sheet", () => {
  test("a form's calendar opens as a sheet whose days clear the floor, and posts the same value", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/records/care/overview#health-goals");
    await hydratedClick(page, page.getByTestId("add-health-goal-panel-toggle"));
    // The panel's content is a dialog PORTALED to <body>, so it is addressed by
    // its role and name — the `add-health-goal-panel` testid stays on the
    // toggle's wrapper, which does not contain it.
    const form = page.getByRole("dialog", { name: "Add health goal" });
    // The target date is a FACT since #5302, and an ESSENTIAL one, so a new goal
    // already wears its dashed chip and the chip is the way to the field. What this
    // test is about — the date picker's sheet fork — is unchanged beneath it, and the
    // editor stays open for the whole case so the sheet has a field to open over.
    await openRecordFact(
      form.getByTestId("care-goal-form"),
      "care-goal",
      "target"
    );
    await expect(form.getByLabel("Target date")).toBeVisible();

    // The field is typed into, not tapped open: below `md` the calendar is a
    // modal sheet that takes focus, so opening it on focus would mean the field
    // could never be typed into at all. Manual entry still works, and the
    // calendar button beside it is the phone's way in (#3376's invariant).
    await form.getByLabel("Target date").fill("2026-03-09");
    await expect(page.getByTestId("date-field-sheet")).toHaveCount(0);
    const posted = form.locator('input[name="target_date"]');
    await expect(posted).toHaveValue("2026-03-09");

    // A pure client toggle — it opens a panel and posts nothing.
    await hydratedClick(page, form.getByLabel("Open calendar"));
    const sheet = page.getByTestId("date-field-sheet");
    await expect(sheet).toBeVisible();
    const calendar = page.getByTestId("date-field-calendar");
    await expect(calendar).toHaveAttribute("data-anchored-panel", "sheet");

    // Day cells at the tap floor. The typed value put the calendar on March
    // 2026, so the 9th is the day it is showing as selected — measure a handful
    // of real cells rather than the whole grid.
    //
    // THE FLOOR IS EFFECTIVE, AND THE TWO AXES REACH IT DIFFERENTLY (#3938/#3954).
    // A day cell renders the 34px control box and is as wide as its grid column.
    // Its width already clears 44 from the column; its height clears it through
    // the block reach a coarse pointer gets — this file runs in the `mobile`
    // project, so the reach is really there and `expectPhoneTapTargets` demands
    // the 44 rather than the box. Two adjacent days are handed in together so the
    // disjointness is asserted on the EXTENDED boxes, which is the pair that can
    // now fight over a pixel.
    // Named by the whole date, not the bare numeral: #3744 gave every cell in the
    // shared month grid an accessible date name, so a reader arriving mid-grid
    // hears which "17" this is.
    const day = calendar.getByRole("button", { name: "March 17, 2026" });
    const dayBelow = calendar.getByRole("button", { name: "March 24, 2026" });
    await expect(day).toBeVisible();
    // The BOX, as an equality. `expectPhoneTapTargets` only bounds the effective
    // target from below, so it is green on the `h-11 md:h-9` step this issue
    // retired — 44 is not less than 44 — and a guard that survives the change it
    // was written for is not a guard.
    await expectControlBoxHeight(day, "the date sheet's day cell", {
      lines: 0,
    });
    await expectPhoneTapTargets(
      page,
      "the date sheet's day cells",
      [day, dayBelow],
      { disjoint: true }
    );

    // Picking round-trips into the field's POSTED value, which is the contract
    // the fork must not touch.
    await day.click();
    await expect(sheet).toHaveCount(0);
    await expect(posted).toHaveValue("2026-03-17");
  });
});

// ── THE TIME FIELD'S WHEEL (#4218) ──────────────────────────────────────────
//
// `TimeField` is the third consumer of the fork, and the first whose panel is a
// SCROLL SURFACE rather than a grid of buttons. That is the claim worth making in
// a browser: the columns are real scroll containers with `scroll-snap-type: y
// mandatory` and centre-aligned cells, so the momentum and the detents are the
// platform's own physics and not a gesture recognizer this app would have to own.
// jsdom cannot say anything about that — components/__tests__/time-field.test.tsx
// takes the value contract. These cases exercise native scrolling and snapping;
// the separate recorded gesture diagnostic establishes momentum after release.
//
// Records supplies both real hosts: the measurements sitting's split Time and
// the historical-dose form's composed date/time door. Complementary formats at
// the two widths cover the host integrations without repeating a full matrix.

/** The column geometry, read the way the platform reads it. */
async function wheelGeometry(column: Locator) {
  return column.evaluate((el) => {
    const cell = el.querySelector(
      '[role="option"][aria-selected="true"]'
    ) as HTMLElement;
    const columnBox = el.getBoundingClientRect();
    const cellBox = cell.getBoundingClientRect();
    return {
      snapType: getComputedStyle(el).scrollSnapType,
      cellAlign: getComputedStyle(cell).scrollSnapAlign,
      cellHeight: cell.getBoundingClientRect().height,
      overflowY: getComputedStyle(el).overflowY,
      // A snap container that cannot scroll snaps to nothing.
      scrollable: el.scrollHeight - el.clientHeight,
      centerOffset:
        cellBox.y + cellBox.height / 2 - columnBox.y - columnBox.height / 2,
    };
  });
}

// Four complementary rows across the existing phone/popover journeys. The full
// native-momentum matrix is a separate diagnostic; these bounded gestures prove
// that real browser input crosses a boundary and stays inside its scroll owner.
async function exerciseWheelFormats(page: Page, wide: boolean) {
  await page.goto("/settings/display");
  const preference = appContent(page).getByTestId("time-format-select");
  const originalFormat = await preference.inputValue();
  try {
    for (const format of ["24h", "12h"] as const) {
      await page.goto("/settings/display");
      if ((await preference.inputValue()) !== format) {
        await settledSelectSave(page, preference, format, appContent(page));
      }
      const composed = wide === (format === "24h");
      await page.goto(
        composed ? "/history?kind=dose" : "/history?quick=log-measurements"
      );
      if (composed) {
        await hydratedClick(
          page,
          appContent(page).getByTestId("history-add-open-dose")
        );
      }
      // BOTH DOORS NOW OPEN THE SAME HOST (#5617 step 1): the record's add door was
      // an inline panel under its button and is the converged sheet/dialog now, so
      // the dose form is addressed off its dialog exactly as the measurements form
      // already was.
      const form = composed
        ? page
            .getByRole("dialog", { name: "Log dose" })
            .getByTestId("historical-dose-form")
        : page
            .getByRole("dialog", { name: "Log measurements" })
            .getByTestId("measurements-quick-add");
      await expect(form).toBeVisible();
      const date = form.locator('input[type="hidden"][name="date"]');
      const originalDay = await date.inputValue();
      const field = form.getByTestId("m-time");
      const readClock = async () =>
        composed
          ? form.locator('input[type="hidden"][name="time"]').inputValue()
          : parseTypedClock(await field.inputValue());
      if (!composed) {
        await settledFill(page, field, wide ? "09:15" : "7:30pm");
        await field.blur();
        await expect.poll(readClock).toBe(wide ? "09:15" : "19:30");
        await expect(page.getByTestId("time-field-sheet")).toHaveCount(0); // testid-scope-ok: portalled picker sheet
      }
      const opener = composed
        ? form.getByTestId("historical-dose-when")
        : form.getByRole("button", { name: "Open time picker" });
      await hydratedClick(page, opener);
      const wheel = page.getByTestId(
        composed ? "historical-dose-when-panel" : "time-field-wheel"
      ); // testid-scope-ok: both picker hosts are portalled above the form
      await expect(wheel).toHaveAttribute(
        "data-anchored-panel",
        wide ? "popover" : "sheet"
      );
      const hours = wheel.getByRole("listbox", { name: "Hour", exact: true });
      const minutes = wheel.getByRole("listbox", {
        name: "Minute",
        exact: true,
      });
      const chosen = (column: Locator) =>
        column.getByRole("option", { selected: true });
      await hours.scrollIntoViewIfNeeded();
      const geometry = await wheelGeometry(hours);
      expect(geometry.snapType).toMatch(/\by\b/);
      expect(geometry.snapType).toMatch(/mandatory/);
      expect(geometry.cellAlign).toBe("center");
      expect(geometry.overflowY).toBe("auto");
      expect(geometry.scrollable).toBeGreaterThan(geometry.cellHeight);
      await expect
        .poll(async () => Math.abs((await wheelGeometry(hours)).centerOffset))
        .toBeLessThan(1);
      if (!composed && !wide) {
        const twenty = hours.getByRole("option", { name: "20", exact: true });
        const twentyOne = hours.getByRole("option", {
          name: "21",
          exact: true,
        });
        await expectPhoneTapTargets(page, "the time wheel's rows", [
          twenty,
          twentyOne,
        ]);
        await twenty.tap();
        await expect.poll(readClock).toBe("20:30");
      }
      if (!composed && wide) {
        const [wheelBox, fieldBox] = await settledBoxes([wheel, field]);
        expect(wheelBox.y).toBeGreaterThanOrEqual(fieldBox.y);
        await hours.focus();
        await page.keyboard.press("ArrowDown");
        await expect.poll(readClock).toBe("10:15");
      }

      for (const column of [hours, minutes]) {
        const hourColumn = column === hours;
        const first = hourColumn && format === "12h" ? 1 : 0;
        const count = hourColumn ? (format === "12h" ? 12 : 24) : 60;
        for (const direction of [1, -1, 1, -1]) {
          await column.scrollIntoViewIfNeeded();
          await column.focus();
          await page.keyboard.press(direction === 1 ? "End" : "Home");
          await expect
            .poll(async () =>
              Math.abs((await wheelGeometry(column)).centerOffset)
            )
            .toBeLessThan(1);
          const before = (await readClock())!;
          const meridiem =
            format === "12h"
              ? await chosen(
                  wheel.getByRole("listbox", { name: "AM or PM" })
                ).innerText()
              : null;
          const outerScroll = () =>
            column.evaluate((el) => {
              const positions = [window.scrollY];
              for (
                let parent = el.parentElement;
                parent;
                parent = parent.parentElement
              ) {
                positions.push(parent.scrollTop);
              }
              return positions;
            });
          const beforeScroll = await outerScroll();
          const delta = direction * geometry.cellHeight * 1.5;
          if (wide) {
            await column.hover();
            await page.mouse.wheel(0, delta);
          } else {
            await touchSwipeFrom(
              page,
              column,
              { dy: -delta },
              { steps: 6, stepDelayMs: 30 }
            );
          }
          // Crossing must reach the other half of the logical sequence. No
          // particular inertial travel distance or physical copy is prescribed.
          await expect
            .poll(
              async () =>
                Number(await chosen(column).innerText()) - first < count / 2
            )
            .toBe(direction === 1);
          await expect
            .poll(async () =>
              Math.abs((await wheelGeometry(column)).centerOffset)
            )
            .toBeLessThan(1);
          const hour = await chosen(hours).innerText();
          const minute = await chosen(minutes).innerText();
          const h24 =
            format === "12h"
              ? (Number(hour) % 12) + (meridiem === "PM" ? 12 : 0)
              : Number(hour);
          await expect
            .poll(readClock)
            .toBe(`${String(h24).padStart(2, "0")}:${minute}`);
          const after = (await readClock())!;
          expect(hourColumn ? after.slice(3) : after.slice(0, 2)).toBe(
            hourColumn ? before.slice(3) : before.slice(0, 2)
          );
          if (meridiem) {
            await expect(
              chosen(wheel.getByRole("listbox", { name: "AM or PM" }))
            ).toHaveText(meridiem);
          }
          await expect(date).toHaveValue(originalDay);
          expect(await outerScroll()).toEqual(beforeScroll);
        }
        const names = await column.getByRole("option").allTextContents();
        expect(names).toHaveLength(count);
        expect(new Set(names).size).toBe(count);
        await expect(chosen(column)).toHaveCount(1);
        await column.focus();
        await expect(column).toBeFocused();
        await expect(chosen(column)).toBeInViewport();
        await expect(column).toHaveAttribute(
          "aria-activedescendant",
          (await chosen(column).getAttribute("id"))!
        );
      }
      const finalClock = await readClock();
      await page.keyboard.press("Escape");
      await expect(wheel).toHaveCount(0);
      await expect.poll(readClock).toBe(finalClock);
    }
  } finally {
    await page.goto("/settings/display");
    if ((await preference.inputValue()) !== originalFormat) {
      await settledSelectSave(
        page,
        preference,
        originalFormat,
        appContent(page)
      );
    }
  }
}

test.describe("below md the time picker is a bottom sheet wheel", () => {
  test("the wheel is a real snap scroller whose rows a finger can hit, and typing still works beside it", async ({
    page,
  }) => {
    test.slow();
    await exerciseWheelFormats(page, false);
  });

  // FOCUS DOES NOT OPEN THE SHEET (#5360). From `md` up focus opens the wheel,
  // the way it opens the calendar; here the wheel is a modal sheet that takes
  // focus, so a field that opened it on focus could never be typed into, and
  // the glyph stays the door. jsdom proves the branch exists; only a real
  // viewport proves the media query chose it under a real tap.
  test("tapping the field focuses it without opening the sheet; the glyph is the door", async ({
    page,
  }) => {
    await page.goto("/?quick=log-measurements");
    const form = page.getByTestId("measurements-quick-add"); // testid-scope-ok: the quick-log sheet is a BottomSheet portalled to <body>
    const field = form.getByTestId("m-time");
    // Tapped AFTER hydration, or `onFocus` is not attached yet and "no sheet
    // opened" is true of a page that could not have opened one.
    await awaitHydrated(field);
    await field.tap();
    await expect(field).toBeFocused();
    const sheet = page.getByTestId("time-field-sheet"); // testid-scope-ok: portalled to <body>, above every streamed boundary
    await expect(sheet).toHaveCount(0);
    // STILL TYPEABLE through the focus the tap gave it: the shorthand lands,
    // the sheet stays down, and the entry settles into the profile's clock.
    await page.keyboard.type("630");
    await expect(field).toHaveValue("630");
    await expect(sheet).toHaveCount(0);
    await field.blur();
    await expect(field).toHaveValue("06:30");
    await hydratedClick(
      page,
      form.getByRole("button", { name: "Open time picker" })
    );
    await expect(sheet).toBeVisible();
  });
});

test.describe("from md up the anchored popover is what opens", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the same menu is a trigger-anchored popover, with rows a finger can hit", async ({
    page,
  }) => {
    await page.goto("/medications");
    // eslint-disable-next-line no-restricted-properties -- first-ok: any medication row proves the shared fork — order-agnostic
    const trigger = page
      .getByRole("button", { name: "Medication actions" })
      .first();
    await expect(trigger).toBeVisible();
    await hydratedClick(page, trigger);

    await expect(page.getByTestId("overflow-menu-sheet")).toHaveCount(0);
    const menu = page.getByRole("menu");
    await expect(menu).toHaveAttribute("data-anchored-panel", "popover");

    // The popover is placed against the trigger — its top edge sits below the
    // trigger's, which is what "anchored" means here and what a sheet could
    // never satisfy.
    const [menuBox, triggerBox] = await settledBoxes([menu, trigger]);
    expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y);

    // This context has touch, so the rows are on the coarse-pointer branch: a
    // desktop-width tablet gets the popover and a thumb.
    const items = menu.getByRole("menuitem");
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(2);
    await expect(items.nth(count - 1)).toBeVisible();
    const boxes = await settledBoxes(
      Array.from({ length: count }, (_, i) => items.nth(i))
    );
    for (const [i, box] of boxes.entries()) {
      expect(
        box.height,
        `popover row ${i} should meet the ${COARSE_POINTER_FLOOR}px coarse-pointer floor`
      ).toBeGreaterThanOrEqual(COARSE_POINTER_FLOOR);
    }

    // FOCUS GOES IN AND COMES BACK (#3905). It used to stay on the trigger for
    // the whole episode, so the rows above were reachable only by tabbing past
    // the rest of the page; the sheet presentation has moved focus in since
    // #1416 and the popover now matches it. Escape closes and hands the trigger
    // back — the #3374 invariant, unchanged, by the other of its two routes.
    await expect(items.first()).toBeFocused(); // eslint-disable-line no-restricted-properties -- first-ok: the panel this test opened, and the claim is about its FIRST row specifically
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("the time wheel is an anchored popover beside the field, selectable without a pointer", async ({
    page,
  }) => {
    test.slow();
    await exerciseWheelFormats(page, true);
  });

  // FOCUS OPENS THE WHEEL FROM `md` UP (#5360) — the calendar's rule, brought to
  // the other half of the row. What a browser adds to the component tier: the
  // media query chose the popover host, opening it did not move the caret, and
  // Escape closes it without taking focus with it.
  test("focusing the field opens the wheel, typing while it is open parses, and Escape closes it without taking focus", async ({
    page,
  }) => {
    await page.goto("/trends?view=tiles");
    await hydratedClick(
      page,
      appContent(page).getByTestId("log-measurements-toggle")
    );
    // The panel is a `ModalShell`, which is a `BottomSheet` portalled to <body>
    // in both presentations — so the dialog, not the app content, is the scope.
    const form = page
      .getByRole("dialog", { name: "Log measurements" })
      .getByTestId("measurements-quick-add");
    const field = form.getByTestId("m-time");
    await awaitHydrated(field);
    const wheel = page.getByTestId("time-field-wheel"); // testid-scope-ok: portalled to <body>, above every streamed boundary
    const sheet = page.getByTestId("time-field-sheet"); // testid-scope-ok: portalled to <body>, above every streamed boundary
    await expect(wheel).toHaveCount(0);
    await field.click();
    await expect(wheel).toHaveAttribute("data-anchored-panel", "popover");
    await expect(sheet).toHaveCount(0);
    await expect(field).toBeFocused();
    // TYPING WHILE IT IS OPEN PARSES. The wheel parks on the parent's COMMITTED
    // value, so its selected rows are what say the keystrokes were emitted and
    // not merely shown.
    await page.keyboard.type("1124p");
    await expect(field).toHaveValue("1124p");
    const chosen = (name: string) =>
      wheel
        .getByRole("listbox", { name })
        .getByRole("option", { selected: true });
    await expect(chosen("Hour")).toHaveText("23");
    await expect(chosen("Minute")).toHaveText("24");
    await page.keyboard.press("Escape");
    await expect(wheel).toHaveCount(0);
    await expect(field).toBeFocused();
    // The text it was typed as stays until the field is LEFT; then it settles.
    await expect(field).toHaveValue("1124p");
    await field.blur();
    await expect(field).toHaveValue("23:24");
  });
});

// ── THE POPOVER STOPS AT THE VIEWPORT EDGE (#4776) ───────────────────────────
//
// The positioner always knew how much room sat between the anchor and the edge;
// until #4776 `AnchoredPanel` never applied it, so a panel taller than the room
// simply drew past the bottom of the screen — taking whatever lives at its
// bottom (a Done button, the last week of a month) with it.
//
// This is a GEOMETRY claim and it is asserted as a RELATIONSHIP: the panel's own
// bottom edge against the viewport's, not against a constant. And the cap is only
// half the contract — a panel that clipped its content instead of overflowing it
// would satisfy every containment assertion here and still hide the same button —
// so the second half, that the hidden part is reachable by scrolling the panel,
// is asserted through the SAME element the containment is read from.
test.describe("from md up the popover is capped to the room on screen", () => {
  // Desktop WIDTH, so the fork opens the popover — the sheet has never had this
  // defect. Short on purpose: a window this size is a half-screen split or a
  // laptop with a docked devtools pane, and it is the shape where a month grid
  // cannot fit on either side of the control that opened it. The test asserts
  // that rather than assuming it (see NATURALLY TALLER below), so a viewport that
  // stopped being short enough fails loudly instead of passing vacuously.
  test.use({ viewport: { width: 1280, height: 320 } });

  test("a calendar taller than either side of its trigger is capped, contained and still scrollable to its last row", async ({
    page,
  }) => {
    await page.goto("/history");
    const trigger = page.getByTestId("history-calendar");
    await expect(trigger).toBeVisible();
    await hydratedClick(page, trigger);

    // THE GUARD'S OWN OBJECT, and the element the cap is applied to: the popover
    // host itself. Every reading below — natural height, box, scroll — goes
    // through this one locator.
    const panel = page.getByTestId("history-calendar-panel");
    await expect(panel).toHaveAttribute("data-anchored-panel", "popover");
    // Wait for the CONTENT before measuring the container: an empty grid fits any
    // height, and "it fits" is the answer this test must not be handed for free.
    await expect(
      panel.getByRole("button", { name: "Previous month" })
    ).toBeVisible();

    const viewportHeight = page.viewportSize()!.height;
    const geometry = await panel.evaluate((el) => ({
      // What the panel WANTS: its content's height, which `max-height` does not
      // change. Bigger than the box is exactly the state being forbidden.
      natural: el.scrollHeight,
      box: el.clientHeight,
      bottom: el.getBoundingClientRect().bottom,
      top: el.getBoundingClientRect().top,
      overflowY: getComputedStyle(el).overflowY,
    }));
    const [triggerBox] = await settledBoxes([trigger]);

    // NATURALLY TALLER THAN THE ROOM ON EITHER SIDE OF THE TRIGGER — measured
    // from the trigger actually on screen, not from a viewport constant, because
    // "the panel could not have fitted anywhere" is the premise every assertion
    // below rests on. Without it a calendar that happened to fit would satisfy
    // all of them on the broken tree too.
    const roomBelow =
      viewportHeight -
      (triggerBox.y + triggerBox.height) -
      ANCHOR_GAP -
      ANCHOR_MARGIN;
    const roomAbove = triggerBox.y - ANCHOR_GAP - ANCHOR_MARGIN;
    expect(
      geometry.natural,
      "the calendar must fit on neither side, or nothing below is being tested"
    ).toBeGreaterThan(Math.max(roomAbove, roomBelow));

    // CONTAINED — the whole claim, as the relationship it is about: the panel's
    // own bottom edge against the viewport's, not against a constant.
    expect(geometry.top).toBeGreaterThanOrEqual(ANCHOR_MARGIN);
    expect(
      geometry.bottom,
      "the panel's bottom edge must stay inside the viewport"
    ).toBeLessThanOrEqual(viewportHeight - ANCHOR_MARGIN);

    // AND IT GOT THERE BY CAPPING, NOT BY SHRINKING ITS CONTENT.
    expect(geometry.box).toBeLessThan(geometry.natural);

    // AND THE HIDDEN PART IS REACHABLE, which is what makes the cap a fix rather
    // than a different way to lose the same content. The month grid's LAST day is
    // below the fold of a capped panel; scrolling the panel brings it into view.
    // By the cell's own markup rather than by a role: a LINKED grid renders a
    // `Link` for a marked day and a plain `div` for every other, so no single
    // role reaches the last cell whichever day the fixture lit.
    const days = panel.locator("[data-calendar-day]");
    // COUNT BEFORE THE ABSENCE. `not.toBeInViewport()` is satisfied just as well
    // by an element that is not in the DOM at all, so without this the assertion
    // below is green on a grid that never rendered — which is how the first draft
    // of this test passed while addressing nothing.
    const dayCount = await days.count();
    expect(
      dayCount,
      "a month grid renders at least 28 day cells"
    ).toBeGreaterThanOrEqual(28);
    const last = days.nth(dayCount - 1);
    await expect(last).not.toBeInViewport();
    expect(geometry.overflowY).toBe("auto");
    await panel.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(last).toBeInViewport();
  });
});

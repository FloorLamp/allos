import { test, expect } from "./fixtures";
import { hydratedClick, settledBoxes, settledClick } from "./helpers";

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
const TAP_FLOOR = 44;
// What a popover row rises to when a COARSE pointer is doing the tapping. Lower
// than the phone floor on purpose: the popover is a compact desktop surface and
// this is the minimum a finger is owed there, not the phone's comfortable row.
const COARSE_POINTER_FLOOR = 40;

test.describe("below md the ⋯ menu is a bottom action sheet", () => {
  test("a medication row's menu opens as a sheet, keeps its actions, and hands focus back", async ({
    page,
  }) => {
    await page.goto("/medications");
    const trigger = page
      .getByRole("button", { name: "Medication actions" })
      .first(); // first-ok: any medication row proves the shared fork — order-agnostic
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
    await expect(sheet.getByRole("heading")).toHaveText("Medication actions");

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
        `menu row ${i} should meet the ${TAP_FLOOR}px tap floor in the sheet`
      ).toBeGreaterThanOrEqual(TAP_FLOOR);
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
    const group = page.getByTestId("food-group-nuts_seeds");
    if (!(await group.isVisible())) {
      await page.getByTestId("food-more-groups-summary").click();
      await expect(group).toBeVisible();
    }

    // This test logs its OWN serving and removes it again through the product's
    // own row action, so it leaves the shared profile as it found it — the same
    // fixture discipline as e2e/food-log-correction.spec.ts.
    const rows = page.getByTestId("food-logged-list").locator("li[data-group]");
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
    const eventId = added[0].replace("food-logged-", "");

    const row = page.getByTestId(`food-logged-${eventId}`);
    await hydratedClick(
      page,
      row.getByRole("button", { name: /^Actions for the/ })
    );
    await expect(page.getByTestId("overflow-menu-sheet")).toBeVisible();

    // THE INVARIANT THIS TEST EXISTS FOR: the item's testid and its handler are
    // untouched by the host swap, so the same tap that removed a serving from a
    // popover removes it from a sheet.
    const remove = page.getByTestId(`food-logged-remove-${eventId}`);
    const [removeBox] = await settledBoxes([remove]);
    expect(removeBox.height).toBeGreaterThanOrEqual(TAP_FLOOR);
    await settledClick(page, remove);
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId("overflow-menu-sheet")).toHaveCount(0);
  });
});

test.describe("below md the date picker is a bottom sheet", () => {
  test("a form's calendar opens as a sheet with 44px days and posts the same value", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/records/care/overview#health-goals");
    await hydratedClick(page, page.getByTestId("add-health-goal-panel-toggle"));
    // The panel's content is a dialog PORTALED to <body>, so it is addressed by
    // its role and name — the `add-health-goal-panel` testid stays on the
    // toggle's wrapper, which does not contain it.
    const form = page.getByRole("dialog", { name: "Add health goal" });
    await expect(form.getByLabel("Target date")).toBeVisible();

    // The field is typed into, not tapped open: below `md` the calendar is a
    // modal sheet that takes focus, so opening it on focus would mean the field
    // could never be typed into at all. Manual entry still works, and the
    // calendar button beside it is the phone's way in (#3376's invariant).
    await form.getByLabel("Target date").fill("2026-03-09");
    await expect(page.getByTestId("date-field-sheet")).toHaveCount(0);
    const posted = form.locator('input[name="target_date"]');
    await expect(posted).toHaveValue("2026-03-09");

    await settledClick(page, form.getByLabel("Open calendar"));
    const sheet = page.getByTestId("date-field-sheet");
    await expect(sheet).toBeVisible();
    const calendar = page.getByTestId("date-field-calendar");
    await expect(calendar).toHaveAttribute("data-anchored-panel", "sheet");

    // Day cells at the tap floor. The typed value put the calendar on March
    // 2026, so the 9th is the day it is showing as selected — measure a handful
    // of real cells rather than the whole grid.
    const day = calendar.getByRole("button", { name: "17", exact: true });
    await expect(day).toBeVisible();
    const [dayBox] = await settledBoxes([day]);
    expect(dayBox.height).toBeGreaterThanOrEqual(TAP_FLOOR);
    expect(dayBox.width).toBeGreaterThanOrEqual(TAP_FLOOR);

    // Picking round-trips into the field's POSTED value, which is the contract
    // the fork must not touch.
    await settledClick(page, day);
    await expect(sheet).toHaveCount(0);
    await expect(posted).toHaveValue("2026-03-17");
  });
});

test.describe("from md up the anchored popover is what opens", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the same menu is a trigger-anchored popover, with rows a finger can hit", async ({
    page,
  }) => {
    await page.goto("/medications");
    const trigger = page
      .getByRole("button", { name: "Medication actions" })
      .first(); // first-ok: any medication row proves the shared fork — order-agnostic
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

    // Escape closes the popover and the trigger — which never lost focus — keeps
    // it.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

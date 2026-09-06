import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { E2E_LOGIN_SICK_SELF } from "./logins/illness";
import { E2E_LOGIN_MULTI } from "./logins/household";
import { E2E_LOGIN_SHELL, SHELL_DOSE_ITEM } from "./logins/metrics";
import { E2E_MEMBER_PASSWORD } from "./logins/shared";
import { hydratedClick, openMobileDrawer } from "./helpers";
import { loginAs } from "./nav";
import {
  CONTROL_BOX_PX,
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
} from "../lib/tap-floor-tokens";

const PHONE = { width: 390, height: 844 };

// THE FLOOR IS EFFECTIVE, THE BOX IS RENDERED (owner ruling #3938). This census
// used to demand 44 RENDERED and to refuse `.tap-target` as a mechanism, on the
// reasoning that an overlay overlaps its neighbours. The ruling settles it the
// other way: every control renders the box, a coarse pointer gets the rest of the
// 44 back as reach, and the disjointness the old rule was protecting is bought by
// a gap floor of twice that reach instead. So the reach is READ OFF THE RENDER —
// a class list cannot say whether `@media (pointer: coarse)` arrived — and the
// pairwise check below moves to the extended boxes.
//
// AND IT IS READ PER AXIS, WHICH IS NOT A REFINEMENT (#3954/#4035). A TILED control —
// a segmented track's options, the two halves of one removable chip — reaches on the
// BLOCK axis only, because it has no inline gap to spend and an inline reach could
// only be taken from the neighbour. Reading `top` and applying it to both axes
// therefore invents 6px of inline extension that the browser never drew, and the
// pairwise check below then reports two halves of one pill as owning the same point.
// A guard that reds on a correct tiled control gets deleted within a week, taking the
// real assertion with it.
async function reachOf(
  locator: Locator
): Promise<{ block: number; inline: number }> {
  return locator.evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    const side = (raw: string) => {
      const inset = Math.abs(Number.parseFloat(raw));
      return after.content === "none" || !Number.isFinite(inset) ? 0 : inset;
    };
    return { block: side(after.top), inline: side(after.left) };
  });
}

async function expectEffectiveFloor(name: string, locator: Locator) {
  await expect(locator, name).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, name).not.toBeNull();
  const reach = await reachOf(locator);
  expect(
    box!.height + 2 * reach.block + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} effective height (${box!.height} rendered + 2x${reach.block} reach)`
  ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
}

async function expectOverlayFloor(
  name: string,
  locator: Locator,
  exactRenderedPx: number
) {
  await expect(locator, name).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, name).not.toBeNull();
  expect(
    Math.abs(box!.height - exactRenderedPx),
    `${name} rendered height delta from ${exactRenderedPx}px`
  ).toBeLessThanOrEqual(TAP_FLOOR_FLOAT_EPSILON_PX);
  await expectEffectiveFloor(name, locator);
}

async function expectRenderedTargetsDisjoint(name: string, row: Locator) {
  await expect(row, `${name} row`).toBeVisible();
  const targets = row.locator("button");
  const count = await targets.count();
  expect(count, `${name} must exercise adjacent targets`).toBeGreaterThan(1);
  const boxes = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const target = targets.nth(index);
      const box = await target.boundingBox();
      const reach = await reachOf(target);
      return box === null
        ? null
        : {
            x: box.x - reach.inline,
            y: box.y - reach.block,
            width: box.width + 2 * reach.inline,
            height: box.height + 2 * reach.block,
          };
    })
  );
  for (let left = 0; left < boxes.length; left += 1) {
    expect(boxes[left], name).not.toBeNull();
    expect(
      boxes[left]!.height + TAP_FLOOR_FLOAT_EPSILON_PX,
      `${name} target ${left} effective height`
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const overlapX =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(
        overlapX > TAP_FLOOR_FLOAT_EPSILON_PX &&
          overlapY > TAP_FLOOR_FLOAT_EPSILON_PX,
        `${name} targets ${left} and ${right} must not own the same point`
      ).toBe(false);
    }
  }
}

test.describe("tap-target rendered census (#3562)", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("multi-profile identity control", async ({ browser }) => {
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_MULTI, password: E2E_MEMBER_PASSWORD },
      { viewport: PHONE, hasTouch: true }
    );
    try {
      await page.goto("/");
      // In the DRAWER since #4102 — the phone top bar that used to carry it has
      // retired — so the control has to be opened before it can be measured. It is
      // the same sidebar-surface mount, hence the plain testid, scoped to the
      // drawer because the hidden desktop sidebar carries one too.
      const drawer = await openMobileDrawer(page);
      await expectEffectiveFloor(
        "drawer profile identity",
        drawer.getByTestId("profile-identity-bar")
      );
    } finally {
      await page.context().close();
    }
  });

  test("shell dock and quick-log controls", async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_SHELL, password: E2E_MEMBER_PASSWORD },
      { viewport: PHONE, hasTouch: true }
    );
    try {
      await page.goto("/");
      await expectEffectiveFloor(
        "mobile dock slot",
        page.getByTestId("dock-slot-home")
      );
      await hydratedClick(page, page.getByTestId("dock-log-puck"));
      const sheet = page.getByTestId("quick-log-sheet");
      await expect(sheet).toBeVisible();
      const trainSegment = sheet.getByTestId("log-sheet-segment-train");
      await hydratedClick(page, trainSegment);
      await expect(trainSegment).toHaveAttribute("aria-pressed", "true");
      await expectEffectiveFloor(
        "quick-log row",
        sheet.getByTestId("quick-log-log-activity")
      );
      const context = sheet.getByTestId("log-sheet-context");
      const dueDose = context.getByTestId("log-sheet-chip-doses");
      await expect(dueDose).toHaveText(`Due: ${SHELL_DOSE_ITEM}`);
      await expectEffectiveFloor("owned due-dose context chip", dueDose);
    } finally {
      await page.context().close();
    }
  });

  test("visit controls", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/records/history/visits");
    await hydratedClick(
      page,
      page.getByRole("button", { name: "Add visit", exact: true })
    );
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    await expectOverlayFloor(
      "past-visit tense switch",
      dialog.getByTestId("visit-tense-past"),
      32
    );
    await expectEffectiveFloor(
      "visit fact chip",
      dialog.getByTestId("visit-fact-when")
    );
    await expectEffectiveFloor(
      "visit more trigger",
      dialog.getByTestId("visit-fact-more")
    );
    await hydratedClick(page, dialog.getByTestId("visit-fact-more"));
    await expectEffectiveFloor(
      "visit more choice",
      dialog.getByTestId("visit-more-provider")
    );
    await expectRenderedTargetsDisjoint(
      "visit more choices",
      dialog.getByTestId("visit-fact-more-menu")
    );
    await hydratedClick(page, dialog.getByTestId("visit-tense-past"));
    await expectOverlayFloor(
      "upcoming-visit tense switch",
      dialog.getByTestId("visit-tense-upcoming"),
      32
    );
  });

  test("protocol, goal and injury detail menus", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/longevity#protocols");
    await hydratedClick(
      page,
      page.getByRole("main").getByTestId("new-protocol-toggle")
    );
    const protocol = page.getByTestId("protocol-form");
    await expectEffectiveFloor(
      "protocol more trigger",
      protocol.getByTestId("protocol-fact-more")
    );
    await hydratedClick(page, protocol.getByTestId("protocol-fact-more"));
    await expectEffectiveFloor(
      "protocol more choice",
      protocol.getByTestId("protocol-more-notes")
    );
    await expectRenderedTargetsDisjoint(
      "protocol more choices",
      protocol.getByTestId("protocol-more-notes").locator("..")
    );

    await page.goto("/training?tab=goals");
    await hydratedClick(
      page,
      page.getByRole("button", { name: "Add goal", exact: true })
    );
    const goal = page.getByTestId("goal-form");
    await hydratedClick(page, goal.getByTestId("goal-kind-freeform"));
    await goal.getByLabel("Title").fill("Geometry goal");
    await hydratedClick(page, goal.getByTestId("goal-editor-done"));
    await expectEffectiveFloor(
      "goal more trigger",
      goal.getByTestId("goal-fact-more")
    );
    await hydratedClick(page, goal.getByTestId("goal-fact-more"));
    await expectEffectiveFloor(
      "goal more choice",
      goal.getByTestId("goal-more-category")
    );
    await expectRenderedTargetsDisjoint(
      "goal more choices",
      goal.getByTestId("goal-more-category").locator("..")
    );

    await page.goto("/training");
    await hydratedClick(
      page,
      page.getByRole("button", { name: "Log injury", exact: true })
    );
    const injury = page.getByTestId("injury-form");
    await expectEffectiveFloor(
      "injury more trigger",
      injury.getByTestId("injury-fact-more")
    );
    await hydratedClick(page, injury.getByTestId("injury-fact-more"));
    await expectEffectiveFloor(
      "injury more choice",
      injury.getByTestId("injury-more-laterality")
    );
    await expectRenderedTargetsDisjoint(
      "injury more choices",
      injury.getByTestId("injury-more-laterality").locator("..")
    );
  });

  test("intake and cadence controls", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/nutrition?tab=supplements");
    await hydratedClick(page, page.getByTestId("supplement-add-toggle"));
    const form = page.getByTestId("intake-item-form");
    await expect(form).toBeVisible();
    await form.getByLabel("Name").fill("Geometry thing");
    await form.getByLabel("Name").press("Escape");
    await expectEffectiveFloor(
      "intake fact chip",
      form.getByTestId("intake-fact-dose")
    );
    await expectEffectiveFloor(
      "intake add-rule chip",
      form.getByTestId("intake-add-rule")
    );
    await expectEffectiveFloor(
      "intake more trigger",
      form.getByTestId("intake-fact-more")
    );
    await expectRenderedTargetsDisjoint(
      "intake fact row",
      form.getByTestId("intake-fact-row")
    );

    await hydratedClick(page, form.getByTestId("intake-fact-more"));
    await expect(form.getByTestId("intake-editor")).toHaveAttribute(
      "data-panel",
      "more"
    );
    await expectEffectiveFloor(
      "intake more choice",
      form.getByTestId("intake-more-purpose")
    );
    await expectRenderedTargetsDisjoint(
      "intake more choices",
      form.getByTestId("intake-more-purpose").locator("..")
    );
    await hydratedClick(page, form.getByTestId("intake-more-purpose"));
    await form.getByLabel("Name").fill("Lutein");
    await form.getByLabel("Name").press("Escape");
    await expectEffectiveFloor(
      "purpose goal",
      form.getByTestId("purpose-goal-energy")
    );
    await expectEffectiveFloor(
      "purpose suggestion",
      form.getByTestId("purpose-suggest-eyes")
    );
    await expectRenderedTargetsDisjoint(
      "purpose goals",
      form.getByTestId("purpose-goal-energy").locator("..")
    );
    await hydratedClick(page, form.getByTestId("intake-editor-done"));
    await hydratedClick(page, form.getByTestId("intake-add-rule"));
    await expectEffectiveFloor(
      "rule offer",
      form.getByTestId("intake-rule-add-only-when")
    );
    await expectRenderedTargetsDisjoint(
      "rule offers",
      form.getByTestId("intake-rule-add-only-when").locator("..")
    );
    await hydratedClick(page, form.getByTestId("intake-rule-add-only-when"));
    await hydratedClick(page, form.getByTestId("intake-editor-done"));
    await expectRenderedTargetsDisjoint(
      "fact chip split",
      form.getByTestId("intake-fact-rule")
    );

    await hydratedClick(page, form.getByTestId("intake-fact-timing"));
    await form.getByLabel("How often").selectOption("weekly");
    await expectEffectiveFloor(
      "cadence weekday",
      form.getByTestId("cadence-weekday-1")
    );
    await expectRenderedTargetsDisjoint(
      "cadence weekdays",
      form.getByTestId("cadence-weekdays")
    );
  });
});

// ── THE RULED TYPED-FIELD BOX (#3708, superseded by #3938) ──────────────────
//
// The field BOX is the target. A labeled row beside it may not stand in for it,
// so these assertions read the `<input>`/`<select>`'s own rendered rectangle and
// nothing around it.
//
// WHAT CHANGED, AND WHY THE MATCHERS TIGHTENED. #3708 ruled a 44px RENDERED field
// below `sm` only, so this block asserted ">= 44 at 390" and "< 44 above sm".
// #3938 rules ONE box at every width, and 34 satisfies "< 44" — so the old
// desktop half would have gone on passing while saying nothing, which is exactly
// the boundary-crossing fixture that stops testing what it claims. Every reading
// below is now an EQUALITY against the box, at 390, at 639, at 640 and at 1280,
// and the reach that carries a field's neighbours to 44 is deliberately absent
// here: a replaced element renders no pseudo-element, so a typed field's target
// IS its box. 639/640 stay named because they were the old contract's boundary
// and a leftover media query there would be invisible at 390 and 1280.
const SM_EXACT = { width: 640, height: 900 };
const DESKTOP = { width: 1280, height: 900 };

async function boxOf(name: string, locator: Locator) {
  await expect(locator, name).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, name).not.toBeNull();
  return box!;
}

/**
 * IS THE 44px BOX ACTUALLY THE TARGET? A height is an absolute number; a target is
 * a RELATIONSHIP. A field grown to 44px under a sticky header, or behind a
 * neighbour's overlay, measures 44 and hands the tap to something else. So the two
 * rows the enlargement ADDED — the field's own top and bottom edges — are
 * hit-tested, because those are the two a covering element takes first.
 */
async function ownsItsOwnEdges(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  expect(
    box,
    "the field must be laid out before it is hit-tested"
  ).not.toBeNull();
  const handle = await locator.elementHandle();
  try {
    return await page.evaluate(
      ([el, x, top, bottom]) => {
        const at = (y: number) => document.elementFromPoint(x as number, y);
        return at(top as number) === el && at(bottom as number) === el;
      },
      [
        handle,
        box!.x + box!.width / 2,
        box!.y + 2,
        box!.y + box!.height - 2,
      ] as const
    );
  } finally {
    await handle?.dispose();
  }
}

/** Every named field's rendered height, at one viewport, in one pass. */
async function fieldHeights(
  page: Page,
  fields: readonly { name: string; locator: Locator }[]
) {
  const out: Record<string, number> = {};
  for (const field of fields)
    out[field.name] = (await boxOf(field.name, field.locator)).height;
  return out;
}

test.describe("typed fields render the ruled 44px box on a phone (#3708)", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  // THE ACTIVITY EDITOR IS THE DENSEST NAMED SURFACE and carries three of the
  // reconciliation's own findings: DateTimeFields' three fields were pinned at
  // `h-[38px]`, and ActivityFormHeader's editable title at `h-8`. The date field
  // asks for no height at all, which is the case that shows the floor is about the
  // FAMILY and not about the pinned sites: `.input`'s own `py-2` + `text-sm` is
  // 38px, so it was under the floor by construction.
  test("the activity editor's fields clear the floor at 390 and are denser above sm", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // THE EDITOR IS OPENED AT 1280 AND THEN NARROWED, because Training's Add
    // activity is `hidden md:inline-flex` and has no phone twin on this route. That
    // makes the experiment BETTER, not weaker: one mounted editor, one DOM, and the
    // only thing that changes between the two readings is the viewport width — which
    // is precisely the variable the contract claims to key on.
    await page.setViewportSize(DESKTOP);
    await page.goto("/training?tab=log");
    await hydratedClick(page, page.getByTestId("training-log-add-activity"));

    // Wait for the CONTENT being measured, not its container: an editor measured
    // before its fields mount reports whatever was there, and empty flatters.
    const fields = [
      { name: "activity title", locator: page.getByLabel("Activity name") },
      { name: "activity date", locator: page.locator("#activity-date") },
      { name: "start time", locator: page.locator("#activity-start-time") },
      { name: "end time", locator: page.getByTestId("end-time-input") },
    ] as const;
    await expect(page.getByTestId("date-time-fields")).toBeVisible();

    // ONE BOX, AT EVERY WIDTH — the same editor, the same DOM, four viewports.
    for (const viewport of [DESKTOP, SM_EXACT, PHONE]) {
      await page.setViewportSize(viewport);
      const measured = await fieldHeights(page, fields);
      for (const [name, height] of Object.entries(measured))
        expect(
          height,
          `${name} renders ${height}px at ${viewport.width}px, not the ${CONTROL_BOX_PX}px ` +
            "control box. The box is declared once in app/globals.css (SECTION: " +
            "Touch tap targets); a field outside `.input` carries it itself."
        ).toBe(CONTROL_BOX_PX);
    }
    await page.setViewportSize(PHONE);

    // CONTAINMENT AND DISJOINTNESS, asked of the pair that shares a row. Start and
    // End sit in one two-column grid, so they are the adjacent fields the ruling's
    // "provably disjoint" clause is about; a floor applied by growing a box is
    // exactly the change that could make two of them overlap.
    const start = await boxOf("start time", fields[2].locator);
    const end = await boxOf("end time", fields[3].locator);
    for (const [name, box] of [
      ["start time", start],
      ["end time", end],
    ] as const) {
      expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(
        PHONE.width
      );
    }
    const overlapX =
      Math.min(start.x + start.width, end.x + end.width) -
      Math.max(start.x, end.x);
    const overlapY =
      Math.min(start.y + start.height, end.y + end.height) -
      Math.max(start.y, end.y);
    expect(
      overlapX > 0 && overlapY > 0,
      "Start and End must not own the same point"
    ).toBe(false);

    // FOCUS AND ACCESSIBLE NAME survive the taller box — the two things a purely
    // geometric change is most likely to break silently.
    await fields[3].locator.focus();
    await expect(fields[3].locator).toBeFocused();
    await expect(fields[0].locator).toHaveAttribute(
      "aria-label",
      "Activity name"
    );

    // …and the box a thumb finds is this field, top edge and bottom edge.
    expect(
      await ownsItsOwnEdges(page, fields[3].locator),
      "End time measures 44px but something else answers at its edges — a taller " +
        "field under a sticky header passes an absolute check and fails a person."
    ).toBe(true);

    // THE OLD BOUNDARY, ASKED TO BE ABSENT. `sm` is 40rem and #3708's rule was
    // written `max-width: 639.98px`, so 639 and 640 are the only two widths that
    // can tell a surviving phone-only height from the one box; 390 and 1280
    // cannot see it at all.
    for (const width of [639, 640]) {
      await page.setViewportSize({ width, height: 900 });
      const at = (await boxOf(`end time at ${width}`, fields[3].locator))
        .height;
      expect(
        at,
        `end time is ${at}px at ${width}px — the box does not step at 40rem any more`
      ).toBe(CONTROL_BOX_PX);
    }
  });

  // THE PICKER OWNS THREE MORE TARGETS (#3706): its clear command, its option rows
  // and its free-text command. They are the Combobox's, not a call site's, so they
  // are measured on the shared component rather than at one adopter — and this is
  // the fixture combobox-portal.mobile.spec.ts established as write-free: it types
  // and dismisses, and submits nothing.
  test("the picker's field, options and commands are 44px targets at 390", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/nutrition?tab=supplements");
    await hydratedClick(page, page.getByTestId("supplement-add-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add supplement" });
    await expect(dialog).toBeVisible();

    const name = dialog.getByRole("combobox", { name: "Name" });
    expect((await boxOf("picker field", name)).height).toBe(CONTROL_BOX_PX);
    await name.click();
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-expanded", "true");

    // Wait for the rows, then measure them — a listbox measured before its options
    // arrive is an empty sweep that passes by looking at nothing.
    const options = page.getByTestId("combobox-option");
    await expect(options.first()).toBeVisible(); // first-ok: the picker's own freshly-opened list, whose row count is asserted on the next line
    const rows = await options.count();
    expect(rows, "the picker must offer rows to measure").toBeGreaterThan(1);
    const rowBoxes = await options.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          height: r.height,
          left: r.left,
          right: r.right,
        };
      })
    );
    for (const [index, row] of rowBoxes.entries()) {
      expect(
        row.height + TAP_FLOOR_FLOAT_EPSILON_PX,
        `option row ${index} renders ${row.height}px`
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      if (index === 0) continue;
      const previous = rowBoxes[index - 1];
      expect(
        Math.min(previous.bottom, row.bottom) -
          Math.max(previous.top, row.top) >
          0 &&
          Math.min(previous.right, row.right) -
            Math.max(previous.left, row.left) >
            0,
        `option rows ${index - 1} and ${index} must not own the same point`
      ).toBe(false);
    }

    // EDITING BEHAVIOUR AND THE CLEAR COMMAND, in one gesture: a typed value brings
    // the clear button into the field's right column, and clearing it must empty
    // the field and leave the caret in it. Width is the half that needed saying —
    // the button takes the field's own ruled height from `inset-y-0`.
    await name.fill("Vitamin");
    const clear = dialog.getByRole("button", { name: "Clear" });
    const clearBox = await boxOf("picker clear", clear);
    // It takes the field's own box from `inset-y-0`, so the floor it meets is the
    // effective one — the reach around it, exactly like the field's neighbours.
    await expectEffectiveFloor("picker clear", clear);
    expect(clearBox.width + TAP_FLOOR_FLOAT_EPSILON_PX).toBeGreaterThanOrEqual(
      TAP_FLOOR_PX
    );
    expect(
      await ownsItsOwnEdges(page, clear),
      "the clear command measures 44px but something else answers at its edges"
    ).toBe(true);
    await clear.click();
    await expect(name).toHaveValue("");
    await expect(name).toBeFocused();

    // …and the same field is the same box above `sm`. An inequality here would
    // pass on 34, on 26 and on 12; the ruling's claim is an equality.
    await page.setViewportSize(DESKTOP);
    const wide = await boxOf("picker field at 1280", name);
    expect(wide.height).toBe(CONTROL_BOX_PX);
  });

  // #3706's own three typed fields, on the real component, at the mount that shows
  // both of the states they live in: the add-symptom picker (custom Combobox) and a
  // logged row's note. Both are pure client toggles, so this writes nothing.
  test("SymptomLogBar's typed fields clear the floor at 390", async ({
    browser,
  }) => {
    const page = await loginAs(
      browser,
      { username: E2E_LOGIN_SICK_SELF, password: E2E_MEMBER_PASSWORD },
      { viewport: PHONE, hasTouch: true }
    );
    try {
      await page.goto("/");
      const bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar — order-agnostic
      await expect(bar).toBeVisible();

      await bar.getByTestId("symptom-add-picker-toggle").click();
      const custom = bar
        .getByTestId("symptom-custom-input")
        .getByRole("combobox");
      const customBox = await boxOf("custom symptom field", custom);
      expect(customBox.height).toBe(CONTROL_BOX_PX);
      expect(customBox.x + customBox.width).toBeLessThanOrEqual(PHONE.width);
      await expect(custom).toHaveAttribute("aria-label", "Add another symptom");

      // The field and the "Add symptom" command share a row, so they are the
      // adjacent pair whose disjointness the enlargement could have cost.
      const add = await boxOf(
        "custom symptom add",
        bar.getByTestId("symptom-custom-add")
      );
      expect(
        Math.min(customBox.x + customBox.width, add.x + add.width) -
          Math.max(customBox.x, add.x) >
          0,
        "the custom-symptom field and its Add command must not own the same point"
      ).toBe(false);

      // A seeded logged row's note editor — the third typed field.
      await bar.getByTestId("symptom-cough-note-toggle").click();
      const note = bar.getByTestId("symptom-cough-note-input");
      const noteBox = await boxOf("symptom note field", note);
      expect(noteBox.height).toBe(CONTROL_BOX_PX);
      await note.focus();
      await expect(note).toBeFocused();

      await page.setViewportSize(DESKTOP);
      const wideNote = await boxOf("symptom note field at 1280", note);
      expect(wideNote.height).toBe(CONTROL_BOX_PX);
    } finally {
      await page.context().close();
    }
  });

  // THE SWEEP, IN BOTH DIRECTIONS, over two field surfaces on different routes and
  // under different logins. Under #3938 both directions are the SAME assertion —
  // every `.input` is the box at 390 and at 1280 — which is stronger than the
  // old pair of inequalities, and it is stated as the set of distinct heights
  // rather than as "nothing is short", because an empty filter is satisfied by a
  // tree where every field vanished.
  //
  // Family settings is here because it carries two of the reconciliation's own 15
  // named sites and neither one was edited: the whole migration for them is the
  // `.input` rule, so a second route is what shows the rule travelling.
  const FIELD_SURFACES = [
    {
      name: "activity editor",
      // Opened wide for the same reason as the tests above — Add activity is
      // `hidden md:inline-flex` and has no phone twin on this route.
      open: async (page: Page) => {
        await page.goto("/training?tab=log");
        await hydratedClick(
          page,
          page.getByTestId("training-log-add-activity")
        );
        await expect(page.getByTestId("date-time-fields")).toBeVisible();
      },
    },
    {
      name: "family settings",
      open: async (page: Page) => {
        await page.goto("/settings/family");
        await expect(page.locator("#family-new-profile-name")).toBeVisible();
      },
    },
  ] as const;

  for (const surface of FIELD_SURFACES)
    test(`no \`.input\` is short at 390 on ${surface.name}, and it is dense at 1280`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(DESKTOP);
      await surface.open(page);

      const measure = async () =>
        page.locator(".input:visible").evaluateAll((els) =>
          els.map((el) => ({
            what:
              el.getAttribute("data-testid") ??
              el.getAttribute("id") ??
              el.getAttribute("aria-label") ??
              el.tagName,
            height: el.getBoundingClientRect().height,
          }))
        );

      // A textarea that asks for MORE keeps it — `min-block-size` is a floor, not
      // a ceiling — so the sweep is over the single-line fields the box governs.
      const singleLine = (fs: { what: string; height: number }[]) =>
        fs.filter((f) => f.height <= CONTROL_BOX_PX + 1);

      const wide = await measure();
      expect(wide.length, "the sweep must find fields").toBeGreaterThan(1);
      await page.setViewportSize(PHONE);
      const phone = await measure();
      expect(phone.length, "the sweep must find fields").toBeGreaterThan(1);

      for (const [width, fields] of [
        [DESKTOP.width, wide],
        [PHONE.width, phone],
      ] as const) {
        const governed = singleLine([...fields]);
        expect(
          governed.length,
          `the sweep on ${surface.name} at ${width}px must reach single-line fields`
        ).toBeGreaterThan(1);
        expect(
          [...new Set(governed.map((f) => f.height))],
          `\`.input\` renders more than one height on ${surface.name} at ${width}px: ` +
            governed.map((f) => `${f.what}=${f.height}`).join(", ")
        ).toEqual([CONTROL_BOX_PX]);
      }
    });
});

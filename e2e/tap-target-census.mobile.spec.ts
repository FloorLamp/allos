import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { E2E_LOGIN_SICK_SELF } from "./logins/illness";
import { E2E_LOGIN_MULTI } from "./logins/household";
import { E2E_LOGIN_SHELL, SHELL_DOSE_ITEM } from "./logins/metrics";
import { E2E_MEMBER_PASSWORD } from "./logins/shared";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import {
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
  TAP_TARGET_INSET_PX,
} from "../lib/tap-floor-tokens";

const PHONE = { width: 390, height: 844 };

async function expectRenderedFloor(name: string, locator: Locator) {
  await expect(locator, name).toBeVisible();
  await expect(
    locator,
    `${name} owns its rendered target instead of overlapping its neighbours`
  ).not.toHaveClass(/(?:^|\s)tap-target(?:\s|$)/);
  const box = await locator.boundingBox();
  expect(box, name).not.toBeNull();
  expect(
    box!.height + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} rendered height`
  ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
}

async function expectOverlayFloor(
  name: string,
  locator: Locator,
  exactRenderedPx: number
) {
  await expect(locator, name).toBeVisible();
  await expect(locator, `${name} hit-area mechanism`).toHaveClass(
    /(?:^|\s)tap-target(?:\s|$)/
  );
  const box = await locator.boundingBox();
  expect(box, name).not.toBeNull();
  expect(
    Math.abs(box!.height - exactRenderedPx),
    `${name} rendered height delta from ${exactRenderedPx}px`
  ).toBeLessThanOrEqual(TAP_FLOOR_FLOAT_EPSILON_PX);
  expect(
    box!.height + 2 * TAP_TARGET_INSET_PX + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} effective height`
  ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
}

async function expectRenderedTargetsDisjoint(name: string, row: Locator) {
  await expect(row, `${name} row`).toBeVisible();
  const targets = row.locator("button");
  const count = await targets.count();
  expect(count, `${name} must exercise adjacent targets`).toBeGreaterThan(1);
  const boxes = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      targets.nth(index).boundingBox()
    )
  );
  for (let left = 0; left < boxes.length; left += 1) {
    await expect(
      targets.nth(left),
      `${name} target ${left} owns a rendered box`
    ).not.toHaveClass(/(?:^|\s)tap-target(?:\s|$)/);
    expect(boxes[left], name).not.toBeNull();
    expect(
      boxes[left]!.height + TAP_FLOOR_FLOAT_EPSILON_PX,
      `${name} target ${left}`
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const overlapX =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(
        overlapX > 0 && overlapY > 0,
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
      await expectRenderedFloor(
        "mobile profile identity",
        page.getByTestId("profile-identity-bar-mobile")
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
      await expectRenderedFloor(
        "mobile dock slot",
        page.getByTestId("dock-slot-home")
      );
      await hydratedClick(page, page.getByTestId("dock-log-puck"));
      const sheet = page.getByTestId("quick-log-sheet");
      await expect(sheet).toBeVisible();
      const trainSegment = sheet.getByTestId("log-sheet-segment-train");
      await hydratedClick(page, trainSegment);
      await expect(trainSegment).toHaveAttribute("aria-pressed", "true");
      await expectRenderedFloor(
        "quick-log row",
        sheet.getByTestId("quick-log-log-activity")
      );
      const context = sheet.getByTestId("log-sheet-context");
      const dueDose = context.getByTestId("log-sheet-chip-doses");
      await expect(dueDose).toHaveText(`Due: ${SHELL_DOSE_ITEM}`);
      await expectRenderedFloor("owned due-dose context chip", dueDose);
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
    await expectRenderedFloor(
      "visit fact chip",
      dialog.getByTestId("visit-fact-when")
    );
    await expectRenderedFloor(
      "visit more trigger",
      dialog.getByTestId("visit-fact-more")
    );
    await hydratedClick(page, dialog.getByTestId("visit-fact-more"));
    await expectRenderedFloor(
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
    await expectRenderedFloor(
      "protocol more trigger",
      protocol.getByTestId("protocol-fact-more")
    );
    await hydratedClick(page, protocol.getByTestId("protocol-fact-more"));
    await expectRenderedFloor(
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
    await expectRenderedFloor(
      "goal more trigger",
      goal.getByTestId("goal-fact-more")
    );
    await hydratedClick(page, goal.getByTestId("goal-fact-more"));
    await expectRenderedFloor(
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
    await expectRenderedFloor(
      "injury more trigger",
      injury.getByTestId("injury-fact-more")
    );
    await hydratedClick(page, injury.getByTestId("injury-fact-more"));
    await expectRenderedFloor(
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
    await expectRenderedFloor(
      "intake fact chip",
      form.getByTestId("intake-fact-dose")
    );
    await expectRenderedFloor(
      "intake add-rule chip",
      form.getByTestId("intake-add-rule")
    );
    await expectRenderedFloor(
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
    await expectRenderedFloor(
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
    await expectRenderedFloor(
      "purpose goal",
      form.getByTestId("purpose-goal-energy")
    );
    await expectRenderedFloor(
      "purpose suggestion",
      form.getByTestId("purpose-suggest-eyes")
    );
    await expectRenderedTargetsDisjoint(
      "purpose goals",
      form.getByTestId("purpose-goal-energy").locator("..")
    );
    await hydratedClick(page, form.getByTestId("intake-editor-done"));
    await hydratedClick(page, form.getByTestId("intake-add-rule"));
    await expectRenderedFloor(
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
    await expectRenderedFloor(
      "cadence weekday",
      form.getByTestId("cadence-weekday-1")
    );
    await expectRenderedTargetsDisjoint(
      "cadence weekdays",
      form.getByTestId("cadence-weekdays")
    );
  });
});

// ── THE RULED TYPED-FIELD BOX (#3708, owner ruling 2026-08-28) ──────────────
//
// The field BOX is the target. A labeled row beside it may not stand in for it,
// so these assertions read the `<input>`/`<select>`'s own rendered rectangle and
// nothing around it.
//
// TWO DIRECTIONS, ALWAYS, AND THAT IS THE WHOLE DESIGN OF THIS BLOCK. "Nothing is
// under 44 at 390" passes on the tree we want AND on a tree pinned at 44 at every
// width — which is exactly the defect #3896 shipped, where two `!` outranked a
// primitive's own `sm`+ reset and held 18 consumers at the phone floor on desktop.
// So every site measured below is measured at 390 AND above `sm`, and the desktop
// reading asserts the field is SHORTER, not merely present. 640 is included by
// name because `40rem` is the boundary itself and an off-by-one there is invisible
// at 1280.
const SM_EXACT = { width: 640, height: 900 };
const DESKTOP = { width: 1280, height: 900 };

async function boxOf(name: string, locator: Locator) {
  await expect(locator, name).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, name).not.toBeNull();
  return box!;
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

    // THE CONVERSE FIRST, on the wide editor. Desktop density is the half a
    // one-directional guard cannot see, and it is the half #3896 lost.
    for (const viewport of [DESKTOP, SM_EXACT]) {
      await page.setViewportSize(viewport);
      const wide = await fieldHeights(page, fields);
      for (const [name, height] of Object.entries(wide))
        expect(
          height,
          `${name} renders ${height}px at ${viewport.width}px. The phone floor has ` +
            "leaked above `sm` — it is confined by a max-width media query, and an " +
            "`!important` copy of it would rank ABOVE that query rather than below."
        ).toBeLessThan(TAP_FLOOR_PX);
    }

    await page.setViewportSize(PHONE);
    const phone = await fieldHeights(page, fields);
    for (const [name, height] of Object.entries(phone))
      expect(
        height + TAP_FLOOR_FLOAT_EPSILON_PX,
        `${name} renders ${height}px at ${PHONE.width}px. The floor is declared once for ` +
          "`.input` in app/globals.css (SECTION: Touch tap targets); a field outside " +
          "that family carries it itself."
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);

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
    await expectRenderedFloor("picker field", name);
    await name.click();
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-expanded", "true");

    // Wait for the rows, then measure them — a listbox measured before its options
    // arrive is an empty sweep that passes by looking at nothing.
    const options = page.getByTestId("combobox-option");
    await expect(options.first()).toBeVisible();
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
    expect(clearBox.height + TAP_FLOOR_FLOAT_EPSILON_PX).toBeGreaterThanOrEqual(
      TAP_FLOOR_PX
    );
    expect(clearBox.width + TAP_FLOOR_FLOAT_EPSILON_PX).toBeGreaterThanOrEqual(
      TAP_FLOOR_PX
    );
    await clear.click();
    await expect(name).toHaveValue("");
    await expect(name).toBeFocused();

    // …and the same field is denser above `sm`, so the floor is a phone contract
    // and not a new universal height.
    await page.setViewportSize(DESKTOP);
    const wide = await boxOf("picker field at 1280", name);
    expect(wide.height).toBeLessThan(TAP_FLOOR_PX);
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
      expect(
        customBox.height + TAP_FLOOR_FLOAT_EPSILON_PX
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
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
      expect(
        noteBox.height + TAP_FLOOR_FLOAT_EPSILON_PX
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      await note.focus();
      await expect(note).toBeFocused();

      await page.setViewportSize(DESKTOP);
      const wideNote = await boxOf("symptom note field at 1280", note);
      expect(wideNote.height).toBeLessThan(TAP_FLOOR_PX);
    } finally {
      await page.context().close();
    }
  });

  // THE SWEEP, IN BOTH DIRECTIONS, over the densest field surface in the app. On
  // its own the empty-list assertion is the shape the #3673 review called
  // structurally wrong — it is satisfied by a tree where every field is 44px at
  // every width — so the second half asserts the same page has SHORT fields at
  // 1280. Neither half is worth anything without the other.
  test("no `.input` is short at 390, and the same page is dense at 1280", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // Opened wide for the same reason as the test above — Add activity is
    // `hidden md:inline-flex`.
    await page.setViewportSize(DESKTOP);
    await page.goto("/training?tab=log");
    await hydratedClick(page, page.getByTestId("training-log-add-activity"));
    await expect(page.getByTestId("date-time-fields")).toBeVisible();

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

    const wide = await measure();
    expect(wide.length, "the sweep must find fields").toBeGreaterThan(2);
    expect(
      wide.filter((f) => f.height < TAP_FLOOR_PX).length,
      "Every `.input` on this page is already at the phone floor at 1280px, so the " +
        "contract is not confined below `sm` — the exact shape #3896 shipped."
    ).toBeGreaterThan(0);

    await page.setViewportSize(PHONE);
    const phone = await measure();
    expect(phone.length, "the sweep must find fields").toBeGreaterThan(2);
    expect(
      phone.filter((f) => f.height + TAP_FLOOR_FLOAT_EPSILON_PX < TAP_FLOOR_PX),
      `A \`.input\` renders under the ${TAP_FLOOR_PX}px floor at ${PHONE.width}px.`
    ).toEqual([]);
  });
});

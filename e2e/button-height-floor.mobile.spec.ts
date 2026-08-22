import { test, expect } from "./fixtures";

// THE BUTTON FAMILY'S HEIGHT FLOOR, MEASURED AS A RENDERED BOX (#3486).
//
// The defect this pins: `.btn` declared padding and no min-height, so a button's
// height was whatever its content happened to be. /wellness's add affordance is a
// plain `btn` whose label carries `hidden sm:inline`, so below `sm` its content is
// a 16px icon instead of a 20px text line and it rendered ~4px SHORTER than every
// labeled button in the family — the "shorter wellness +" the 2026-08-21 phone
// review spotted. Two other call sites had already hand-fixed their own copy of it
// with a local `min-h-10`; the floor now lives with the family in app/globals.css.
//
// WHY THIS SPEC MEASURES A BOX AND NOT A CLASS STRING. A computed-style or
// class-name assertion checks a DECLARATION; a user sees a RENDERED RESULT, and the
// gap between the two is exactly how this regression escaped notice for as long as
// it did. `min-h-10` appearing in a class string is not evidence the button is
// 40px tall, and a `min-block-size` in a stylesheet is not evidence it reached this
// element. So every assertion below reads `boundingBox()` off a real button in a
// real phone viewport, and the reference it compares against is another real
// button rendered at the same moment.
const PHONE = { width: 390, height: 844 };

// The floor itself, named rather than spelled inline. 40px is #644/#3377's tap
// floor for this app — the same number the two hand-fixed call sites had already
// reached for independently, which is what made it the family's number rather
// than a new one.
const TAP_FLOOR_PX = 40;

test.describe("the button family has one height at phone width (#3486)", () => {
  test.use({ viewport: PHONE });

  test("the icon-only wellness + is as tall as a labeled button in its own family", async ({
    page,
  }) => {
    await page.goto("/wellness");

    const trigger = page.getByTestId("practice-create-trigger");
    await expect(trigger).toBeVisible();

    // THE PRECONDITION, ASSERTED — without it this test passes for the wrong
    // reason. The whole defect only exists in the composition where the label is
    // HIDDEN; at any viewport that shows "Add" the two heights match trivially and
    // a green here would mean nothing. So prove we are in the icon-only case
    // before measuring it.
    const label = trigger.getByText("Add", { exact: true });
    await expect(label).toBeHidden();

    const iconOnly = await trigger.boundingBox();
    expect(iconOnly).not.toBeNull();

    // THE REFERENCE: a LABELED member of the same family, rendered on the same
    // page at the same viewport. Opening the add-practice modal mounts
    // PracticeEditor, whose "Save" is a plain `btn` carrying a text label — the
    // sibling shape the icon-only trigger used to fall short of.
    await trigger.click();
    const form = page.getByTestId("practice-create-form");
    await expect(form).toBeVisible();
    const labeled = await form
      .getByRole("button", { name: "Save", exact: true })
      .boundingBox();
    expect(labeled).not.toBeNull();

    // The comparison the issue is about. Before the family floor these were 32 and
    // 36, and this line is what fails if a future composition shrinks either one.
    expect(iconOnly!.height).toBe(labeled!.height);
    expect(iconOnly!.height).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
  });

  // THE TWO CALL SITES THE FAMILY RULE REPLACED, MEASURED WHERE THEY LIVE.
  //
  // These are the highest-risk buttons in the whole change and the only two that
  // got measurably LESS source: each carried its own `min-h-10 min-w-10 …
  // sm:min-h-0 sm:min-w-0`, and collapsing them into the family is what the issue
  // asked for — but it means their 40px now comes from a rule declared in another
  // file, under a media query, in a layer. Nothing about the deletion proves the
  // replacement reached them. So each is opened at 390px, in its icon-only state,
  // and its RENDERED box is read.
  //
  // Both halves matter and only one is a measurement: `noLocalFloor` is a
  // DECLARATION check (the hand fix is really gone, so there is one number in the
  // codebase rather than three), and it is checked only AFTER the element is
  // proven visible — an absence assertion over the class string of an element that
  // never mounted is green and means nothing.
  const COLLAPSED_HAND_FIXES = [
    {
      what: "the supplement add toggle (#3486: was min-h-10 min-w-10 …)",
      route: "/nutrition?tab=supplements",
      testId: "supplement-add-toggle",
    },
    {
      what: "the metric measurement toggle (#3486: was min-h-10 min-w-10 …)",
      route: "/trends/metric/weight",
      testId: "metric-measurement-toggle",
    },
  ];

  for (const site of COLLAPSED_HAND_FIXES) {
    test(`${site.what} keeps its floor from the family`, async ({ page }) => {
      await page.goto(site.route);
      const trigger = page.getByTestId(site.testId);
      await expect(trigger).toBeVisible();

      const box = await trigger.boundingBox();
      expect(box).not.toBeNull();
      expect(
        box!.height,
        `${site.testId} renders ${box!.height}px tall at ${PHONE.width}px. Its own ` +
          "`min-h-10` was removed in favour of the family floor in app/globals.css — " +
          "if this is short, the family rule is not reaching it."
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      expect(box!.width).toBeGreaterThanOrEqual(TAP_FLOOR_PX);

      // …and the hand fix really is gone, so 40 is written once and not three
      // times. Safe to ask only because the element above is proven present.
      const className = await trigger.getAttribute("class");
      expect(className).not.toMatch(/\bmin-[hw]-10\b/);
    });
  }

  test("no button on the page renders under the tap floor", async ({
    page,
  }) => {
    await page.goto("/wellness");

    // Wait for the CONTENT this measures, not the container: a page measured
    // before its buttons mount reports an empty sweep and passes by looking at
    // nothing.
    await expect(page.getByTestId("practice-create-trigger")).toBeVisible();

    const family = page.locator(
      ".btn:visible, .btn-ghost:visible, .btn-danger:visible"
    );

    // A sweep over nothing is green and says nothing (#3206's lesson, applied to a
    // DOM census): assert the sweep found buttons before believing it found no
    // short ones.
    expect(await family.count()).toBeGreaterThan(0);

    const undersized = await family.evaluateAll(
      (els, floor) =>
        els
          .map((el) => ({
            text: (el.textContent ?? "").trim().slice(0, 40),
            height: el.getBoundingClientRect().height,
          }))
          .filter((b) => b.height < floor),
      TAP_FLOOR_PX
    );

    expect(
      undersized,
      "A `.btn` / `.btn-ghost` / `.btn-danger` control renders under the " +
        `${TAP_FLOOR_PX}px tap floor at ${PHONE.width}px. The floor is declared once, ` +
        "for the whole family, in app/globals.css (SECTION: Touch tap targets) — " +
        "a call site should not be re-declaring its own height, and a control that " +
        "genuinely must be shorter on a phone is not a member of this family."
    ).toEqual([]);
  });
});

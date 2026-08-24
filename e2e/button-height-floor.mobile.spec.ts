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
// it did. `min-h-11` appearing in a class string is not evidence the button is
// 44px tall, and a `min-block-size` in a stylesheet is not evidence it reached this
// element. So every assertion below reads `boundingBox()` off a real button in a
// real phone viewport, and the reference it compares against is another real
// button rendered at the same moment.
const PHONE = { width: 390, height: 844 };

// The floor itself, named rather than spelled inline.
//
// 44px, and the quantity is a RENDERED height. That is the owner ruling on #3514
// (2026-08-21): the tap floor is 44px EFFECTIVE everywhere, met by either of two
// registered mechanisms — a RENDERED size (the `.btn` family's rule below `sm`, or
// a call site's own `min-h-11`) or a deliberately smaller rendered control extended
// to >=44 effective by `.tap-target`'s `inset: -6px` hit-area overlay. Rendered
// height and hit area are different guarantees, and a rule has to say which one it
// means or its number is not citable.
//
// THIS SPEC MEASURES THE RENDERED ONE. That makes it the right threshold for a
// `.btn`-family member and the WRONG check to point at a `.tap-target` control,
// whose box is legitimately smaller than its target — a sweep that swept both would
// fail honest code. The family shipped at 40 because #3486's text said 40; #3514
// found that #644, the issue §5 cited for that number, never produced 40 at all.
const TAP_FLOOR_PX = 44;

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
  // asked for — but it means their floor now comes from a rule declared in another
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
      label: "Add supplement",
    },
    {
      what: "the metric measurement toggle (#3486: was min-h-10 min-w-10 …)",
      route: "/trends/metric/weight",
      testId: "metric-measurement-toggle",
      label: "Log Manually",
    },
  ];

  for (const site of COLLAPSED_HAND_FIXES) {
    test(`${site.what} keeps its floor from the family`, async ({ page }) => {
      await page.goto(site.route);
      const trigger = page.getByTestId(site.testId);
      await expect(trigger).toBeVisible();

      // THE PRECONDITION, ASSERTED — the same one the wellness test makes, for
      // the same reason. The defect only exists in the composition where the
      // label is HIDDEN (`hidden sm:inline`), leaving a 16px icon as the whole
      // content. At a viewport that shows the label the height is comfortable
      // anyway and a green here would mean nothing, so prove we are in the
      // icon-only case before measuring it.
      await expect(trigger.getByText(site.label, { exact: true })).toBeHidden();

      const box = await trigger.boundingBox();
      expect(box).not.toBeNull();
      expect(
        box!.height,
        `${site.testId} renders ${box!.height}px tall at ${PHONE.width}px. Its own ` +
          "`min-h-10` was removed in favour of the family floor in app/globals.css — " +
          "if this is short, the family rule is not reaching it."
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      expect(box!.width).toBeGreaterThanOrEqual(TAP_FLOOR_PX);

      // …and the hand fix really is gone, so the number is written once and not
      // three times. Safe to ask only because the element above is proven present.
      // Both spellings are refused: `min-h-10` is the hand fix #3510 deleted, and
      // `min-h-11` would be the same mistake made again at #3514's new number —
      // re-declaring the family's floor at a call site is the defect, not the
      // value it re-declares.
      const className = await trigger.getAttribute("class");
      expect(className).not.toMatch(/\bmin-[hw]-1[01]\b/);
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

test.describe("segmented controls own disjoint rendered targets (#3514)", () => {
  test.use({ viewport: PHONE });

  const BINDING_SURFACES = [
    {
      binding: "button",
      route: "/sleep",
      optionTestId: "sleep-trend-range-14",
      tagName: "BUTTON",
    },
    {
      binding: "Link",
      route: "/medical/episodes",
      optionTestId: "care-trail-kind-illness",
      tagName: "A",
    },
  ];

  for (const surface of BINDING_SURFACES) {
    test(`the ${surface.binding} binding is at least 44px tall and overlaps no sibling`, async ({
      page,
    }) => {
      await page.goto(surface.route);
      const premise = page.getByTestId(surface.optionTestId);
      await expect(premise).toBeVisible();

      // Scope the sweep to the known option instead of accepting an unrelated
      // SegmentedControl elsewhere on the page as proof this binding rendered.
      const tracks = page
        .locator("[data-segmented]:visible")
        .filter({ has: premise });
      expect(await tracks.count()).toBe(1);
      const geometry = await tracks.evaluateAll((groups) =>
        groups.map((group) => {
          const targets = Array.from(
            group.querySelectorAll<HTMLElement>("[data-segmented-option]")
          ).map((target) => {
            const rect = target.getBoundingClientRect();
            return {
              label: (target.textContent ?? "").trim(),
              tagName: target.tagName,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              height: rect.height,
            };
          });
          const overlaps: string[] = [];
          for (let i = 0; i < targets.length; i += 1) {
            for (let j = i + 1; j < targets.length; j += 1) {
              const horizontal =
                Math.min(targets[i].right, targets[j].right) -
                Math.max(targets[i].left, targets[j].left);
              const vertical =
                Math.min(targets[i].bottom, targets[j].bottom) -
                Math.max(targets[i].top, targets[j].top);
              if (horizontal > 0 && vertical > 0)
                overlaps.push(`${targets[i].label}/${targets[j].label}`);
            }
          }
          return { targets, overlaps };
        })
      );

      for (const track of geometry) {
        expect(track.targets.length).toBeGreaterThan(1);
        expect(
          [...new Set(track.targets.map((target) => target.tagName))],
          `the ${surface.route} premise must exercise the ${surface.binding} binding`
        ).toEqual([surface.tagName]);
        for (const target of track.targets) {
          expect(
            target.height,
            `${target.label} renders below the ${TAP_FLOOR_PX}px segmented target floor`
          ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
        }
        expect(track.overlaps, "segment hit boxes must stay disjoint").toEqual(
          []
        );
      }
    });
  }
});

// ── THE FLOOR'S REACH, OUTSIDE THE FAMILY (#3486 part 3) ────────────────────
//
// Everything above is about the `.btn` family, which is the set #3510 declared
// the floor on. This block is about the OTHER registered mechanism, and about the
// fact that it has an arithmetic precondition nothing in the tree stated.
//
// `.tap-target` extends a control's clickable area by `inset: -6px` — SIX PIXELS
// PER SIDE, a fixed 12px in total. So it reaches 44 only from a 32px rendered box
// up. Four steppers on /nutrition carried the class at `h-7` (28px), which is 40px
// effective: under the floor while wearing the token that says the floor is met.
// That is worse than a plainly undersized control, because nothing was ever going
// to look at it again.
//
// WHY THIS IS MEASURED HERE AND NOT ONLY IN THE SOURCE CENSUS.
// `lib/__tests__/tap-floor-reach.test.ts` reads the class list, which is how it
// can cover every route and every state at once. It cannot tell you the rule
// REACHED the element: `@media (pointer: coarse)` is a real condition, and this
// project's own history is a floor that read correctly in the stylesheet and did
// not arrive (#3514's cascade bug, caught by a bounding box). So the numbers below
// come from `getBoundingClientRect()` and from the browser's own computed style
// for the pseudo-element, and the effective target is those two measurements
// added — never a class name.
test.describe("the hit-area mechanism reaches the floor it claims (#3486)", () => {
  test.use({ viewport: PHONE });

  // `.tap-target`'s extension, and the smallest rendered box it can lift to the
  // floor. Derived, not spelled — the same derivation `lib/tap-floor-reach.ts`
  // makes, so the two cannot disagree about what 32 means.
  const TAP_TARGET_INSET_PX = 6;
  const TAP_TARGET_MIN_RENDERED_PX = TAP_FLOOR_PX - 2 * TAP_TARGET_INSET_PX;

  test("the food-log steppers are 44px effective, by box plus overlay", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    await expect(page.getByTestId("food-log-bar")).toBeVisible();

    // Wait for the CONTENT this measures. A row still folded behind "more
    // groups" is not in the DOM, and a sweep over what is not there is green.
    const row = page.getByTestId("food-group-nuts_seeds");
    if (!(await row.isVisible())) {
      await page.getByTestId("food-more-groups-summary").click();
      await expect(row).toBeVisible();
    }

    for (const testId of ["undo-nuts_seeds", "log-nuts_seeds"]) {
      const stepper = page.getByTestId(testId);
      await expect(stepper).toBeVisible();
      const box = await stepper.boundingBox();
      expect(box).not.toBeNull();

      // Half one: the rendered box clears the mechanism's minimum.
      expect(
        box!.height,
        `${testId} renders ${box!.height}px. \`.tap-target\` adds a fixed ` +
          `2x${TAP_TARGET_INSET_PX}px, so a control below ${TAP_TARGET_MIN_RENDERED_PX}px cannot reach the ` +
          `${TAP_FLOOR_PX}px floor no matter how the overlay is spelled.`
      ).toBeGreaterThanOrEqual(TAP_TARGET_MIN_RENDERED_PX);
      expect(box!.width).toBeGreaterThanOrEqual(TAP_TARGET_MIN_RENDERED_PX);

      // Half two: the overlay actually ARRIVED at this element in this viewport.
      // Read back out of the browser, not out of the stylesheet — the whole
      // reason the family's floor needed a rendered guard.
      const overlayInset = await stepper.evaluate((el) => {
        const style = getComputedStyle(el, "::after");
        return { content: style.content, top: style.top };
      });
      expect(
        overlayInset.content,
        `${testId} has no \`::after\` in a coarse-pointer viewport, so the ` +
          "`.tap-target` class in its class list is decoration. The rule lives in " +
          "app/globals.css under `@media (pointer: coarse)`."
      ).not.toBe("none");
      const inset = Math.abs(Number.parseFloat(overlayInset.top));
      expect(Number.isFinite(inset)).toBe(true);
      expect(
        box!.height + 2 * inset,
        `${testId} is ${box!.height}px rendered + 2x${inset}px overlay = ` +
          `${box!.height + 2 * inset}px effective, under the ${TAP_FLOOR_PX}px floor #3514 ruled.`
      ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);

      // …and the extension is where a thumb would find it, rather than merely
      // declared: a point outside the visible box still resolves to this control.
      const outside = await page.evaluate(
        ({ x, y, id }) => {
          const hit = document.elementFromPoint(x, y);
          return hit?.closest(`[data-testid="${id}"]`) !== null;
        },
        {
          x: box!.x + box!.width / 2,
          y: box!.y - (TAP_TARGET_INSET_PX - 2),
          id: testId,
        }
      );
      expect(
        outside,
        `A tap ${TAP_TARGET_INSET_PX - 2}px above ${testId}'s visible edge does not land on it, so ` +
          "the overlay is not receiving the tap it exists to receive."
      ).toBe(true);
    }
  });

  test("no `.tap-target` on this page is too small for its own mechanism", async ({
    page,
  }) => {
    await page.goto("/nutrition");
    await expect(page.getByTestId("food-log-bar")).toBeVisible();

    const extended = page.locator(".tap-target:visible");
    // A sweep over nothing is green and says nothing — the same discipline the
    // family sweep above keeps.
    expect(await extended.count()).toBeGreaterThan(0);

    const tooSmall = await extended.evaluateAll(
      (els, minimum) =>
        els
          .map((el) => ({
            what:
              el.getAttribute("data-testid") ??
              el.getAttribute("aria-label") ??
              (el.textContent ?? "").trim().slice(0, 30),
            height: el.getBoundingClientRect().height,
          }))
          .filter((b) => b.height < minimum),
      TAP_TARGET_MIN_RENDERED_PX
    );

    expect(
      tooSmall,
      `A \`.tap-target\` control renders under ${TAP_TARGET_MIN_RENDERED_PX}px at ${PHONE.width}px. The ` +
        `overlay adds a fixed 2x${TAP_TARGET_INSET_PX}px, so below that it lands short of the ` +
        `${TAP_FLOOR_PX}px floor while carrying the class that claims it. Either give the ` +
        "control the rendered height, or register it in " +
        "`lib/__tests__/tap-floor-reach.test.ts` with what would close it."
    ).toEqual([]);
  });
});

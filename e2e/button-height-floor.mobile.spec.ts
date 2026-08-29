import { test, expect } from "./fixtures";
import {
  CONTROL_BOX_PX,
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
  TAP_TARGET_INSET_PX,
  TAP_TARGET_MIN_RENDERED_PX,
} from "@/lib/tap-floor-tokens";

// THE CONTROL BOX (`--control-box` in app/globals.css, SECTION: Touch tap
// targets), MEASURED — owner ruling #3938; the family floor it replaces was
// #3486/#3514. THE FILENAME PREDATES THE RULING: this file held the `.btn`
// family's below-`sm` height floor, the box superseded it in place, and renaming
// the file would re-partition all twelve CI shards for a word. Grep the describe.
//
// Every control kind renders `CONTROL_BOX_PX` at every viewport, and the 44px floor
// is met EFFECTIVELY — the rendered box plus the reach a coarse pointer gets around
// it — rather than by rendering 44. Before this the phone drew four heights for one
// idea; the dose ledger's own chip row is the owner's example and it is measured
// below.
//
// WHY THIS SPEC MEASURES A BOX AND NOT A CLASS STRING. A computed-style or
// class-name assertion checks a DECLARATION; a user sees a RENDERED RESULT, and the
// gap between the two is exactly how #3514's cascade bug shipped. `min-h-11` in a
// class string is not evidence a control is 44px tall, and a `padding-block` in a
// stylesheet is not evidence it reached this element. So every number below comes
// from `boundingBox()` and from the browser's computed style for the pseudo-element.
//
// AND EVERY ASSERTION IS A RELATIONSHIP AS WELL AS AN ABSOLUTE. "34 at 390" also
// passes on a tree that is 34 everywhere by accident and on one where a whole row
// shrank together; the claim the ruling makes is that the kinds AGREE, so each
// route's surfaces are compared to each other at the same instant as well as to the
// constant.
const PHONE = { width: 390, height: 844 };

// 390 is the phone, 639.98 is where the old below-`sm` floors stopped, 640 is `sm`
// itself (`button-control` used to drop to 26 here) and 1280 is the desktop the
// ruling says wears the same box.
const BOX_WIDTHS = [390, 639, 640, 1280];

type BoxSurface = {
  kind: string;
  testId: string;
  /** Whether a coarse pointer can repair this control's reach at all. */
  repairable: boolean;
  /** Below `sm` only — the mobile disclosure that replaces a desktop panel. */
  phoneOnly?: boolean;
};

// One representative per control kind the ruling binds, grouped by the route that
// renders it so the sweep costs one navigation per route rather than one per case.
const BOX_ROUTES: { route: string; ready: string; surfaces: BoxSurface[] }[] = [
  {
    route: "/medications/dose-history",
    ready: "dose-ledger-chip-row",
    surfaces: [
      { kind: "chip", testId: "dose-ledger-pill-7D", repairable: true },
      { kind: "btn-ghost", testId: "dose-ledger-add", repairable: true },
      // A native <select> renders no pseudo-element, so its target IS its box —
      // the `chip-sm` lesson, and the reason #3938 states the floor as effective.
      {
        kind: "native select",
        testId: "dose-ledger-item-filter",
        repairable: false,
      },
      {
        kind: "btn-ghost disclosure",
        testId: "custom-range-toggle",
        repairable: true,
        phoneOnly: true,
      },
    ],
  },
  {
    route: "/",
    ready: "dashboard-canvas",
    surfaces: [
      { kind: "btn", testId: "vitals-log-reading", repairable: true },
      {
        kind: "button-control",
        testId: "cockpit-end-episode",
        repairable: true,
      },
      // A typed <input> cannot grow a pseudo-element either; it wears the box with
      // a >=16px line so iOS does not zoom the page on focus.
      {
        kind: "typed field",
        testId: "weight-quick-add-input",
        repairable: false,
      },
    ],
  },
  {
    route: "/nutrition?tab=supplements",
    ready: "supplement-add-toggle",
    surfaces: [
      // The #3486 shape: below `sm` its label is hidden and a 16px icon is the whole
      // content, which the derived padding alone renders 30px tall.
      {
        kind: "icon-only btn",
        testId: "supplement-add-toggle",
        repairable: true,
      },
    ],
  },
];

type Measured = {
  kind: string;
  height: number;
  reach: number;
  effective: number;
  /** The element's own line box — the quantum the control grows by when it wraps. */
  lineHeight: number;
  /** Whole line boxes above the control box: 0 for a control on one line. */
  extraLines: number;
  /**
   * Whether this control CANNOT wrap, read off the render rather than declared:
   * `white-space: nowrap`, or a replaced element that has no wrapping to do.
   * Declared per surface it would drift from the markup; measured it cannot.
   */
  singleLine: boolean;
};

async function measure(
  page: import("@playwright/test").Page,
  surfaces: readonly BoxSurface[],
  width: number
): Promise<Measured[]> {
  return page.evaluate(
    ({ list, phone }) =>
      list
        .filter((s) => s.phoneOnly !== true || phone)
        .map((s) => {
          const el = document.querySelector<HTMLElement>(
            `[data-testid="${s.testId}"]`
          );
          if (!el) throw new Error(`${s.kind} (${s.testId}) is not in the DOM`);
          const after = getComputedStyle(el, "::after");
          const reach =
            after.content === "none"
              ? 0
              : Math.abs(Number.parseFloat(after.top));
          const height = el.getBoundingClientRect().height;
          const style = getComputedStyle(el);
          const lineHeight = Number.parseFloat(style.lineHeight);
          return {
            kind: s.kind,
            height,
            reach,
            effective: height + 2 * reach,
            lineHeight,
            extraLines:
              Number.isFinite(lineHeight) && lineHeight > 0
                ? (height - 34) / lineHeight
                : Number.NaN,
            singleLine:
              style.whiteSpace === "nowrap" ||
              el.tagName === "INPUT" ||
              el.tagName === "SELECT",
          };
        }),
    { list: [...surfaces], phone: width < 640 }
  );
}

test.describe("the control box: one height, every kind, every viewport (#3938)", () => {
  test.use({ viewport: PHONE });

  for (const { route, ready, surfaces } of BOX_ROUTES) {
    test(`${route} renders one box at ${BOX_WIDTHS.join("/")}`, async ({
      page,
    }) => {
      await page.goto(route);
      // Wait for the CONTENT this measures, not the container: a route measured
      // before its controls mount reports an empty sweep and passes on nothing.
      await expect(page.getByTestId(ready)).toBeVisible();

      for (const width of BOX_WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        const measured = await measure(page, surfaces, width);
        expect(measured.length, `${route} @${width} corpus`).toBeGreaterThan(0);

        for (const m of measured) {
          // THE BOX PLUS A WHOLE NUMBER OF ITS OWN LINE BOXES, and `lines: 0`
          // wherever the control cannot wrap. A flat equality is wrong for a
          // control that legitimately wraps — the derived padding makes the line
          // box the QUANTUM a control grows by, so a second line reads 54, not a
          // defect — and an inequality is wrong for everything, because `< 44`
          // passes on 34, on 26 and on 12 alike. This is the form that reds on a
          // stray `py-*`, a rogue `min-h-11` or any ad-hoc padding, and stays
          // silent on a wrap.
          const lines = Math.round(m.extraLines);
          const reading = `${m.kind} on ${route} renders ${m.height}px at ${width}px with a ${m.lineHeight}px line box`;
          expect(
            Math.abs(m.extraLines - lines) <= 0.02 && lines >= 0,
            `${reading}: ${CONTROL_BOX_PX} + ${m.extraLines.toFixed(3)} line boxes. A control is ` +
              "the control box plus a WHOLE number of them; a fraction is padding " +
              "or a height a call site set itself."
          ).toBe(true);
          if (m.singleLine)
            expect(
              lines,
              `${reading}, so it is on ${lines + 1} lines — and this control cannot wrap ` +
                "(`white-space: nowrap`, or a replaced element), so the extra height is the defect."
            ).toBe(0);

          if (m.reach > 0) {
            expect(m.reach, `${m.kind} reach at ${width}px`).toBe(
              TAP_TARGET_INSET_PX
            );
            expect(
              m.effective + TAP_FLOOR_FLOAT_EPSILON_PX,
              `${m.kind} effective height at ${width}px`
            ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
          } else {
            // Recorded rather than assumed: these are the two kinds the ruling
            // says render no reach, so their target is the box itself.
            expect(
              m.kind,
              `${m.kind} grew no reach at ${width}px; only the unrepairable kinds may`
            ).toMatch(/native select|typed field/);
          }
        }

        // The relationship, not just the absolute: every kind on this page agrees
        // — compared with their wraps taken off, so a control on two lines still
        // has to be the same BOX as its single-line neighbours.
        expect(
          [
            ...new Set(
              measured.map((m) =>
                Math.round(m.height - Math.round(m.extraLines) * m.lineHeight)
              )
            ),
          ],
          `${route} @${width} renders more than one box: ${measured
            .map(
              (m) => `${m.kind}=${m.height}(+${Math.round(m.extraLines)} lines)`
            )
            .join(", ")}`
        ).toEqual([CONTROL_BOX_PX]);
      }
    });
  }

  // THE REACH HAS TO HAVE SOMEWHERE TO SIT — the other half of the disjointness
  // test below, and the half neither it nor the one-height table above can see.
  //
  // Those two ask about a control against its NEIGHBOUR and against a constant.
  // Neither can see a hit region hanging off the outside of the box that CONTAINS
  // it, which is how three dialog bodies went red in CI on a tree where 78 local
  // assertions were green (#3938; the shape is #3392/#3395's). Before this issue
  // only `.tap-target` controls carried the extension, so only they could overflow
  // a container; every `.btn`-family and `button-control` element is in that
  // population now, and a `w-full` or `flex-1` button is flush by construction —
  // no gap between neighbours can help it.
  //
  // WHY `overflow-x: hidden` AND NOT EVERY SCROLLPORT. A region that scrolls
  // sideways ON PURPOSE (the ledger's chip row, any `overflow-x-auto` strip) has
  // extent by construction and a reach inside it is reachable by scrolling — that
  // is not the defect. A `hidden` region has declared it will NOT scroll sideways:
  // extent there is invisible, unreachable, and per #3382 still lets a script park
  // the box. So `hidden` is exactly the population, and it is the one the dialog
  // bodies are in. Written the other way round this guard flagged every chip
  // scrolled past its own strip's edge, which is not a defect at all.
  //
  // The fix when it fires is the CONTAINER — give the extension room — never the
  // control; the extension is the accessibility feature.
  //
  // THE ROUTE LIST IS THE ENUMERATION, and it is not the whole app: this reads the
  // pages below plus one open sheet. `e2e/mobile-clipping.mobile.spec.ts` owns the
  // dialog-body half over its own list of sheets. Neither is a census of every
  // container in the tree, and no assertion here implies one.
  const REACH_CONTAINMENT_ROUTES = [
    { route: "/", ready: "dashboard-canvas" },
    { route: "/medications/dose-history", ready: "dose-ledger-chip-row" },
    { route: "/nutrition?tab=supplements", ready: "supplement-add-toggle" },
    // An OPEN SHEET, deliberately: a page absorbs the reach in `<main>`'s clip and
    // a sheet body does not, so a page-only list would be green on the very tree
    // that shipped the CI red.
    { route: "/?quick=log-period", ready: "quick-cycle-panel" },
  ] as const;

  for (const { route, ready } of REACH_CONTAINMENT_ROUTES) {
    test(`no sideways-clipped region on ${route} holds an escaping reach`, async ({
      page,
    }) => {
      await page.goto(route);
      await expect(page.getByTestId(ready)).toBeVisible();

      const regions = await page.evaluate((reach) => {
        const escaping: { what: string; over: number; culprit: string }[] = [];
        let seen = 0;
        for (const node of Array.from(document.querySelectorAll("*"))) {
          if (!(node instanceof HTMLElement)) continue;
          const cs = getComputedStyle(node);
          if (cs.overflowX !== "hidden") continue;
          // A REGION THAT SIGNALS ITS CLIPPING IS A LABEL ENDING ITS OWN TEXT, not
          // a container refusing to scroll (#3607). Inside `truncate` an inline run
          // keeps its FULL natural width in the box model while the ancestor paints
          // the ellipsis at its own edge: measured on /medications/dose-history at
          // 390px, the span is 97 wide with scrollWidth 167 and its right edge flush
          // inside its parent, while the `<a>` in it reports 70px further right.
          // Nothing is off screen; one rect is.
          //
          // THE REGION-FRAME RULE, AND NOT A COPY OF THE CENSUS'S.
          // `insideEllipsisTruncation` (scripts/ux-geometry-census.mjs) asks whether
          // a box sits inside an ellipsis ANCESTOR that is itself inside the
          // VIEWPORT; this asks whether the region being examined is itself such a
          // label. Different question, and the viewport half has no meaning when the
          // frame is a region's own edge.
          //
          // THEY STAY SEPARATE — #3814 ruled it (2026-08-29), against its own AC's
          // wording. Four sites read this family and they ask THREE questions: the
          // census's ancestor-inside-viewport, `overflowStory`'s is-this-a-culprit,
          // and this one's is-the-region-itself-a-label. One predicate answering all
          // three needs a mode parameter, which is the variant axis this repo
          // forbids; and neither way of crossing the `page.evaluate` boundary is
          // better than the split — threading a predicate's source through
          // `geometryProbe`'s options changes its signature and both callers to unify
          // questions that differ, and folding this sweep into `geometryProbe` breaks
          // its deliberate `<main>` scope, which this spec must escape to reach a
          // portalled sheet. So each rule is stated ONCE, in its own frame, with
          // cross-references. This line is one of those references, not a deferral.
          //
          // BEFORE the `seen` count, deliberately: a truncated label is not a region
          // of the kind this sweep is about, so it must not satisfy the "this route
          // renders at least one sideways-clipped region" converse below either.
          //
          // Stated HERE because `if (!culprit) continue` further down only ever
          // covered a truncated TEXT NODE, and the dose ledger's item-name link is
          // the first `title` cell in the tree to wrap that text in an element.
          if (cs.textOverflow === "ellipsis") continue;
          const box = node.getBoundingClientRect();
          // A region narrower or shorter than the extension itself cannot be a
          // container holding a control with room for its reach. This is what
          // skips `sr-only`, which is a 1px box clipping a whole sentence on
          // purpose — twelve of them topped the first run of this list, and a
          // guard that cries wolf on visually-hidden text gets deleted within a
          // week, taking the real assertion with it. Derived from the reach, not
          // a magic number.
          if (box.width < 2 * reach || box.height < 2 * reach) continue;
          seen += 1;
          const over = node.scrollWidth - node.clientWidth;
          if (over <= 0) continue;
          const edge = box.right;
          // `overflowStory`'s own formula and its own filter, so this and the
          // dialog-body guard cannot disagree about what a culprit is: only
          // overflow that ESCAPES can make a region scrollable, which is why a
          // `truncate` label — the deliberate ellipsis, clipping every pixel of
          // its own overrun — is not a suspect.
          const culprit = Array.from(node.querySelectorAll("*"))
            .filter(
              (el): el is HTMLElement =>
                el instanceof HTMLElement &&
                getComputedStyle(el).overflowX === "visible"
            )
            .map((el) => ({
              el,
              reach:
                el.getBoundingClientRect().right +
                (el.scrollWidth - el.clientWidth) -
                edge,
            }))
            .filter((c) => c.reach > -0.5)
            .sort((a, b) => b.reach - a.reach)[0];
          // NO ESCAPING ELEMENT, NO FINDING. A region whose extent is its own
          // truncated TEXT is not this defect, and reporting it is how a guard
          // gets deleted: the first run of this list was twelve `sr-only` boxes
          // and every `truncate` label on the dashboard. The defect is an
          // ELEMENT — a control and the hit region around it — arriving at the
          // edge of a region that has declared it will not scroll.
          if (!culprit) continue;
          escaping.push({
            what:
              node.getAttribute("data-testid") ??
              `${node.tagName.toLowerCase()}.${node.className}`.slice(0, 60),
            over,
            culprit: `<${culprit.el.tagName.toLowerCase()} data-testid="${
              culprit.el.getAttribute("data-testid") ?? ""
            }" class="${culprit.el.className}"> reaches ${Math.round(
              culprit.reach
            )}px past`,
          });
        }
        return { escaping, seen };
      }, TAP_TARGET_INSET_PX);

      // A sweep over nothing is green and says nothing: prove the route HAS
      // sideways-clipped regions before believing none of them overflows.
      expect(
        regions.seen,
        `${route} must render at least one sideways-clipped region`
      ).toBeGreaterThan(0);
      expect(
        regions.escaping,
        `on ${route} a region that has declared it will not scroll sideways is ` +
          "holding content past its edge — usually a flush control's hit-area " +
          "extension with nowhere to sit. THE FIX IS THE CONTAINER: give the " +
          "extension room (`pointer-coarse:pr-1.5` is what " +
          "components/BottomSheet.tsx uses), never the control."
      ).toEqual([]);
    });
  }

  // THE OWNER'S EXAMPLE, MEASURED AS A ROW. The dose ledger's quick-range strip
  // mixes chips with a `btn-ghost` disclosure and a native select; at 390 it used
  // to render 34 beside 44 beside 44. One height is half the claim — the other half
  // is that the reach the box now gets does not make two neighbours fight over the
  // same pixel, which is what the `gap-3` floor (2x the reach) buys.
  test("the ledger's mixed chip row is one height with disjoint hit regions", async ({
    page,
  }) => {
    await page.goto("/medications/dose-history");
    const row = page.getByTestId("dose-ledger-chip-row");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("custom-range-toggle")).toBeVisible();

    const geometry = await row.evaluate((el, epsilon) => {
      const targets = Array.from(
        el.querySelectorAll<HTMLElement>("a, button, select")
      ).filter((t) => t.getBoundingClientRect().height > 0);
      const boxes = targets.map((t) => {
        const r = t.getBoundingClientRect();
        const after = getComputedStyle(t, "::after");
        const reach =
          after.content === "none" ? 0 : Math.abs(Number.parseFloat(after.top));
        return {
          what: (t.textContent ?? "").trim().slice(0, 18) || t.tagName,
          height: r.height,
          left: r.left - reach,
          right: r.right + reach,
          top: r.top - reach,
          bottom: r.bottom + reach,
        };
      });
      const overlaps: string[] = [];
      let smallestGap = Number.POSITIVE_INFINITY;
      for (let i = 0; i < boxes.length; i += 1)
        for (let j = i + 1; j < boxes.length; j += 1) {
          const x =
            Math.min(boxes[i].right, boxes[j].right) -
            Math.max(boxes[i].left, boxes[j].left);
          const y =
            Math.min(boxes[i].bottom, boxes[j].bottom) -
            Math.max(boxes[i].top, boxes[j].top);
          if (x > epsilon && y > epsilon)
            overlaps.push(`${boxes[i].what}/${boxes[j].what}`);
          if (y > epsilon) smallestGap = Math.min(smallestGap, -x);
        }
      return { boxes, overlaps, smallestGap };
    }, TAP_FLOOR_FLOAT_EPSILON_PX);

    expect(
      geometry.boxes.length,
      "the row must mix adjacent kinds"
    ).toBeGreaterThan(2);
    expect(
      [...new Set(geometry.boxes.map((b) => Math.round(b.height)))],
      `the ledger row renders more than one height: ${geometry.boxes
        .map((b) => `${b.what}=${b.height}`)
        .join(", ")}`
    ).toEqual([CONTROL_BOX_PX]);
    expect(
      geometry.overlaps,
      "two extended targets in the ledger row own the same point; the row's gap must be at least twice the reach"
    ).toEqual([]);
    // The gap floor, stated as the quantity it actually bounds: a non-negative gap
    // between EXTENDED boxes is exactly "the rendered gap is at least twice the
    // reach", so this is the floor measured rather than the constant restated.
    expect(
      geometry.smallestGap + TAP_FLOOR_FLOAT_EPSILON_PX,
      `the ledger row's tightest gap between extended targets is ${geometry.smallestGap}px`
    ).toBeGreaterThanOrEqual(0);
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
// WHY THIS IS MEASURED IN THE BROWSER. A class name cannot prove that a conditional
// rule reached the element: `@media (pointer: coarse)` is a real condition, and
// this project's own history is a floor that read correctly in the stylesheet and
// did not arrive (#3514's cascade bug, caught by a bounding box). So the numbers
// below come from `getBoundingClientRect()` and the browser's computed style for
// the pseudo-element, and the effective target is those two measurements added.
test.describe("the hit-area mechanism reaches the floor it claims (#3486)", () => {
  test.use({ viewport: PHONE });

  // `.tap-target`'s extension, and the smallest rendered box it can lift to the
  // floor. Derived, not spelled — the same derivation `lib/tap-floor-tokens.ts`
  // makes, so the two cannot disagree about what 32 means.
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
        `${TAP_FLOOR_PX}px floor while carrying the class that claims it. Give the ` +
        "control the rendered height or migrate it to a primitive that owns the floor."
    ).toEqual([]);
  });
});

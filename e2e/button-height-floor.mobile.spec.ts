import { test, expect } from "./fixtures";
import {
  CONTROL_BOX_PX,
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
  TAP_TARGET_INSET_PX,
  TAP_TARGET_MIN_RENDERED_PX,
} from "@/lib/tap-floor-tokens";
import { roundControlBoxExtraLines } from "./control-box-lines";
import {
  expectPhoneTapTargets,
  hydratedClick,
  openFoodAdd,
  settledBoxes,
  settledClick,
} from "./helpers";

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
  /**
   * Measure this ancestor of the testid'd node instead. A checkbox primitive puts
   * the testid on the 16px native `<input>` — the thing a spec clicks — while the
   * control IS the `<label>` around it, so without the hop this table would
   * measure the paint and call it the box.
   */
  ancestor?: string;
  /** Whether a coarse pointer can repair this control's reach at all. */
  repairable: boolean;
  /**
   * Below `sm` only — the mobile disclosure that replaces a desktop panel. NO
   * SURFACE DECLARES IT SINCE #3958: its one tenant was the dose ledger's range
   * disclosure, and that route folded into `/history`, which has no range chrome to
   * disclose. Kept because the next phone-only disclosure to be bound needs exactly
   * this, and because deleting it would also delete the `phone` argument the
   * measurement threads for it.
   */
  phoneOnly?: boolean;
};

// One representative per control kind the ruling binds, grouped by the route that
// renders it so the sweep costs one navigation per route rather than one per case.
const BOX_ROUTES: { route: string; ready: string; surfaces: BoxSurface[] }[] = [
  // THE OWNER'S EXAMPLE, RE-HOMED (#3958). This entry read the dose ledger, whose
  // route is deleted: the four ledgers folded into `/history`, and the record is the
  // surface that now renders the two controls this row still binds. The dose door's
  // control is `history-add-open-dose` — the same btn-ghost, mounted by the record's
  // kind-resolved Add door, which since #4424's dose leg opens the domain's shared form
  // directly rather than `DoseBackfillLauncher`'s own toggle (that launcher is deleted)
  // — and the chip is the record's own filter row.
  //
  // TWO SURFACES LEFT WITH THE RANGE ROW RATHER THAN MOVING, and neither was replaced
  // by a nearby element to keep this list the same length:
  //   • `dose-ledger-item-filter` (native select) — the ledger's Item filter. The
  //     record narrows by URL, not by a select. The KIND is still bound, on
  //     /settings/notifications' `waking-start-hour`, so nothing stopped being
  //     measured.
  //   • `custom-range-toggle` (btn-ghost disclosure, phone-only) — the range card's
  //     mobile disclosure. `/history` HAS NO RANGE CHROME AT ALL (a record is
  //     navigated, not windowed), so this table has no route left that renders it on
  //     arrival. The COMPONENT still ships (components/CustomRangeDisclosure.tsx, on
  //     /trends), and the kind keeps its box coverage there:
  //     e2e/trends-fold.mobile.spec.ts measures this exact control through the shared
  //     `expectPhoneTapTargets`, which is the same effective-floor assertion this
  //     table makes. It is not re-homed HERE because reaching it costs an
  //     interaction — the phone's context bar is collapsed — and every entry in this
  //     table is a plain `goto` plus a readiness marker. Nothing stopped being
  //     measured; one route stopped being able to measure it on arrival.
  {
    route: "/history?kind=dose",
    ready: "history-filters",
    surfaces: [
      { kind: "chip", testId: "history-chip-all", repairable: true },
      { kind: "btn-ghost", testId: "history-add-open-dose", repairable: true },
    ],
  },
  {
    route: "/",
    ready: "dashboard-canvas",
    surfaces: [
      {
        kind: "button-control",
        testId: "cockpit-end-episode",
        repairable: true,
      },
      // #3954: the owner's second row. These rendered 44 square beside the 34px
      // icon buttons on their own line — the mixed row that opened this issue.
      {
        kind: "severity option",
        testId: "symptom-cough-sev-1",
        repairable: true,
      },
      // THE FOLD AS A CONTROL (#4505 family 1). A `<summary>` that IS the control
      // wears `fold-control` and joins the selector list; this one held a hand-rolled
      // `min-h-11` and is the dashboard's one fold mechanism (#4232).
      {
        kind: "fold-control",
        testId: "dashboard-all-summary",
        repairable: true,
      },
    ],
  },
  // THE ICON BUTTON (#4505 family 3). Hand-rolled `h-(--control-box) w-(--control-box)`
  // with `.tap-target` for the reach — the pair that rendered 36 here, and 40/32
  // across the twins this family converged. A button and a Link, so both bindings
  // are measured beside each other.
  {
    route: "/medications",
    ready: "medication-share-open",
    surfaces: [
      {
        kind: "icon button",
        testId: "medication-share-open",
        repairable: true,
      },
      {
        kind: "icon button (Link)",
        testId: "medication-print-link",
        repairable: true,
      },
    ],
  },
  // TWO SUBJECTS RE-PICKED (#3366). This route used to bind `vitals-log-reading`
  // (`btn btn-sm`) and `weight-quick-add-input` — the dashboard tail's own vitals
  // and weight write controls. The 2026-08-29 ruling retired the tail's generic
  // write cards because the quick logger is the app's one quick-write surface, so
  // neither control renders on `/` any more.
  //
  //   • The TYPED FIELD moved WITH the capability, to the sheet's measurements
  //     overlay below — the surface the weigh-in itself moved to. `m-time` is the
  //     shared WhenControl's own input, rendered above the disclosure groups, so it
  //     is there on arrival exactly as the weight field used to be.
  //   • The `btn btn-sm` KIND did not need re-homing: `supplement-add-toggle` on
  //     `/nutrition?tab=supplements` below is the same class family in its harder,
  //     icon-only form, so nothing stopped being measured. No nearby element was
  //     drafted onto route `/` to keep this list the same length.
  {
    route: "/?quick=log-measurements",
    ready: "measurements-quick-add",
    surfaces: [
      // A typed <input> cannot grow a pseudo-element, so it wears the box itself.
      { kind: "typed field", testId: "m-time", repairable: false },
    ],
  },
  // THE SHARED TIME STATEMENT'S CLOCK DOOR (#3273's question, #4426's rendering).
  // These were `btn-ghost btn-sm` text buttons carrying no `.tap-target`, so the
  // `/nutrition` sweep further down was structurally unable to see them and no other
  // entry here names them — two phone controls outside the standing census is the gap
  // #3938 exists to close. #4426 made them the ONE clock door: a hand-rolled 34px
  // icon button in the dose-action paint, which is a DIFFERENT construction from
  // `.btn`'s derived padding and is exactly why the two entries stay. One route per
  // sheet, because the two forms are different overlays; both are a plain `goto` plus
  // a readiness marker like every entry above.
  {
    route: "/?quick=log-stool",
    ready: "quick-entry-stool",
    surfaces: [
      {
        kind: "icon-only clock door",
        testId: "stool-when-toggle",
        repairable: true,
      },
    ],
  },
  {
    route: "/?quick=log-practice",
    ready: "quick-entry-practice-list",
    surfaces: [
      {
        kind: "icon-only clock door",
        testId: "practice-when-toggle",
        repairable: true,
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
  // #3954's two kinds, each measured BESIDE an already-bound kind on its own page,
  // because "34" alone also passes on a tree where one row shrank by itself.
  {
    route: "/sleep",
    ready: "sleep-trends",
    surfaces: [
      {
        kind: "segmented option",
        testId: "sleep-trend-range-14",
        repairable: true,
      },
      // The typed Button's PRIMARY variant (#3982). Its rank changed and its box
      // must not have: the variant adds paint on top of `button-control` rather
      // than swapping to `.btn`, so this row is where that is measured rather
      // than asserted — same box as the segmented option beside it at all four
      // widths, and the same coarse-pointer reach.
      {
        kind: "button-control, primary variant",
        testId: "sleep-add-entry-header",
        repairable: true,
      },
    ],
  },
  {
    route: "/settings/notifications",
    ready: "notification-kinds",
    surfaces: [
      // A `<label>` CAN grow a pseudo-element, so unlike the native select beside
      // it the checkbox's floor is effective rather than rendered.
      {
        kind: "checkbox-control",
        testId: "matrix-column-all-push",
        ancestor: "[data-checkbox-control]",
        repairable: true,
      },
      { kind: "native select", testId: "waking-start-hour", repairable: false },
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
          const found = document.querySelector<HTMLElement>(
            `[data-testid="${s.testId}"]`
          );
          const el = s.ancestor
            ? found?.closest<HTMLElement>(s.ancestor)
            : found;
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
          const lines = roundControlBoxExtraLines(m.extraLines);
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
    { route: "/history?kind=dose", ready: "history-filters" },
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
          // the ellipsis at its own edge: measured on the cross-item dose ledger at
          // 390px (the route folded into `/history` in #3958), the span is 97 wide
          // with scrollWidth 167 and its right edge flush inside its parent, while
          // the `<a>` in it reports 70px further right.
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
          // wording. Five sites read this family and they ask FOUR questions: the
          // census's ancestor-inside-viewport, `overflowStory`'s is-this-a-culprit,
          // this one's is-the-region-itself-a-label, and probe (d)'s does-this-clip-
          // cut-a-person's-name (#3623). One predicate answering all
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

  // THE OWNER'S EXAMPLE, MEASURED AS A ROW — re-homed to the surface that replaced
  // the one it was written on (#3958). The dose ledger's quick-range strip mixed
  // chips with a `btn-ghost` disclosure and a native select, and at 390 it rendered
  // 34 beside 44 beside 44. That strip is gone: `/history` has no range chrome, so
  // the MIXED-KIND half of the claim has no row left to make it on and is carried
  // kind-by-kind by BOX_ROUTES above instead.
  //
  // WHAT SURVIVES IS THE HALF THAT ONLY A ROW CAN ASSERT, and it is the half the
  // owner's example was really about: one height across a row, and a reach that does
  // not make two neighbours fight over the same pixel — the `gap-3` floor being
  // exactly 2x the reach. The record's filter row is where that is now hardest,
  // because it holds TWO independently placed clusters: the kind pills in their own
  // group, and the Photos toggle outside it behind a hairline. Nothing else in the
  // app puts two control clusters that close together.
  //
  // WHAT IS AND IS NOT MEASURED HERE, because the honest scope shrank once. This
  // briefly opened `/history?kind=dose&media=1` to force the Photos chip into the row
  // and measure TWO independently placed clusters across the hairline. That URL no
  // longer produces it: `?media=1` degrades when no row can satisfy it (owner ruling
  // 2026-08-29), and no phase-1 kind carries row media — so the chip is unreachable
  // until symptoms land, and forcing it back would mean asserting over a state the
  // app deliberately refuses to enter.
  //
  // So this measures the kind-chip row: every chip one height, every extended target
  // disjoint from its neighbour. WHICH GAP THAT IS, stated because it is no longer the
  // one it used to be: with a single cluster the separation is `FilterPills`' own
  // `gap-3`, not the page row's — verified by mutating each, the pill group's turns
  // this red and the row's no longer can. The cluster-against-cluster case comes back
  // with the Photos chip; it is recorded here rather than silently dropped.
  //
  // AND `gap-2` WAS NEVER SHORT, said because a comment claiming a catch it did not
  // make is worse than no comment: the hairline divider is itself gapped on both
  // sides, so the distance across it was two gaps plus the rule. The page spends
  // `gap-3` because that is the gap the pill group already spends, and this test is
  // what would notice if either stopped.
  test("the record's filter row is one height with disjoint hit regions", async ({
    page,
  }) => {
    await page.goto("/history");
    const row = page.getByTestId("history-filters");
    await expect(row).toBeVisible();
    // THE CONTENT, BEFORE THE GEOMETRY. A chip row that rendered only "All" cannot
    // fail the way this test exists to catch, and the kind chips are data-presence
    // earned — so their presence is asserted rather than assumed.
    await expect(row.getByTestId("history-chip-all")).toBeVisible();

    const geometry = await row.evaluate((el, epsilon) => {
      // A TARGET'S LIVE HIT REGION ENDS AT ITS SCROLLPORT (#3607's rule, one row
      // over). The kind pills live in an `overflow-x-auto` group: a chip scrolled
      // past its edge keeps its FULL rect in the box model while being clipped on
      // screen, so comparing that rect with the pinned Photos chip beside the strip
      // reports two things owning one point that a finger can never touch at once.
      // The sibling reach-containment guard in this file states the same thing: a
      // region that scrolls sideways ON PURPOSE has extent by construction and that
      // is not the defect.
      //
      // CLIPPED, NOT SKIPPED, and the difference is the case that matters. Dropping
      // fully-outside targets still compares a PARTLY visible chip by its whole
      // width, which is how "Practices/Photos" survived the first attempt — the chip
      // straddles the strip's edge and only its hidden half reaches the neighbour.
      // Intersecting each rect with its port measures the region that is actually
      // touchable; a fully scrolled-out chip falls out of the set on width alone.
      const clipToPort = (t: HTMLElement, r: DOMRect) => {
        for (
          let p: HTMLElement | null = t.parentElement;
          p && p !== el.parentElement;
          p = p.parentElement
        ) {
          const overflowX = getComputedStyle(p).overflowX;
          if (overflowX !== "auto" && overflowX !== "scroll") continue;
          const port = p.getBoundingClientRect();
          return {
            left: Math.max(r.left, port.left),
            right: Math.min(r.right, port.right),
            top: r.top,
            bottom: r.bottom,
            height: r.height,
          };
        }
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          height: r.height,
        };
      };
      const boxes = Array.from(
        el.querySelectorAll<HTMLElement>("a, button, select")
      )
        .map((t) => {
          const visible = clipToPort(t, t.getBoundingClientRect());
          const after = getComputedStyle(t, "::after");
          const reach =
            after.content === "none"
              ? 0
              : Math.abs(Number.parseFloat(after.top));
          return {
            what: (t.textContent ?? "").trim().slice(0, 18) || t.tagName,
            height: visible.height,
            width: visible.right - visible.left,
            left: visible.left - reach,
            right: visible.right + reach,
            top: visible.top - reach,
            bottom: visible.bottom + reach,
          };
        })
        .filter((b) => b.height > 0 && b.width > 0);
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
      "the row must hold more than one pair of adjacent targets"
    ).toBeGreaterThan(2);
    expect(
      [...new Set(geometry.boxes.map((b) => Math.round(b.height)))],
      `the record's filter row renders more than one height: ${geometry.boxes
        .map((b) => `${b.what}=${b.height}`)
        .join(", ")}`
    ).toEqual([CONTROL_BOX_PX]);
    expect(
      geometry.overlaps,
      "two extended targets in the record's filter row own the same point; the row's gap must be at least twice the reach"
    ).toEqual([]);
    // The gap floor, stated as the quantity it actually bounds: a non-negative gap
    // between EXTENDED boxes is exactly "the rendered gap is at least twice the
    // reach", so this is the floor measured rather than the constant restated.
    expect(
      geometry.smallestGap + TAP_FLOOR_FLOAT_EPSILON_PX,
      `the record filter row's tightest gap between extended targets is ${geometry.smallestGap}px`
    ).toBeGreaterThanOrEqual(0);
  });
});

// A TILED CONTROL'S TARGET, MEASURED PER AXIS (#3514, re-ruled by #3938/#3954).
//
// A segmented track's options sit shoulder to shoulder inside one inset track:
// they tile their line with no gap, by construction. So the reach they get on a
// coarse pointer is BLOCK-ONLY (app/globals.css) — there is no inline gap to spend
// on the 2x floor, and an inline reach could only be taken from the option next
// door, moving the boundary between two targets rather than enlarging either.
//
// THAT MAKES THE INLINE REACH PART OF THE CLAIM, NOT AN OMISSION. If a later
// change puts segments back on the all-sides reach every other control gets, the
// track is still 34 tall, still reaches 44 effective, and every disjointness sum
// in a test that only added `top` still comes out clean — while real taps 6px
// inside a boundary start landing on the wrong view. So the inline inset is
// asserted to be zero, and the disjointness is computed from the EXTENDED boxes
// rather than the rendered ones, which is the pair that can now collide.
test.describe("segmented options wear the box and tile their track (#3954)", () => {
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
    test(`the ${surface.binding} binding is one box, 44 effective, and overlaps no sibling at ${BOX_WIDTHS.join("/")}`, async ({
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

      for (const width of BOX_WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await tracks.evaluateAll((groups) =>
          groups.map((group) => {
            const targets = Array.from(
              group.querySelectorAll<HTMLElement>("[data-segmented-option]")
            ).map((target) => {
              const rect = target.getBoundingClientRect();
              const after = getComputedStyle(target, "::after");
              const side = (raw: string) => {
                const inset = Math.abs(Number.parseFloat(raw));
                return after.content === "none" || !Number.isFinite(inset)
                  ? 0
                  : inset;
              };
              const block = side(after.top);
              const inline = side(after.left);
              return {
                label: (target.textContent ?? "").trim(),
                tagName: target.tagName,
                block,
                inline,
                height: rect.height,
                width: rect.width,
                left: rect.left - inline,
                right: rect.right + inline,
                top: rect.top - block,
                bottom: rect.bottom + block,
              };
            });
            // THE INLINE HALF OF THE PREMISE, MEASURED (#4505, C's finding on #5399).
            // Block-only reach is licensed by the tiling: the option next door starts
            // where this one ends, so the tiling IS the inline target. Seven cadence
            // weekday tiles wore this marker in a row with gaps and drew a hairline
            // ring, 42px wide, with nothing reaching sideways — and a guard reading
            // height alone passed them. So each option's inline target must clear the
            // floor, and consecutive options on a line must actually touch.
            const byLeft = [...targets].sort((a, b) => a.left - b.left);
            const gaps: number[] = [];
            for (let i = 1; i < byLeft.length; i += 1) {
              const prev = byLeft[i - 1];
              const next = byLeft[i];
              const sameLine =
                Math.min(prev.bottom, next.bottom) -
                  Math.max(prev.top, next.top) >
                0;
              if (sameLine) gaps.push(next.left - prev.right);
            }
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
            return { targets, overlaps, gaps };
          })
        );

        for (const track of geometry) {
          expect(
            track.targets.length,
            `${surface.route} @${width} swept no segments`
          ).toBeGreaterThan(1);
          expect(
            [...new Set(track.targets.map((target) => target.tagName))],
            `the ${surface.route} premise must exercise the ${surface.binding} binding`
          ).toEqual([surface.tagName]);
          expect(
            [...new Set(track.targets.map((t) => Math.round(t.height)))],
            `${surface.route} @${width} renders more than one segment height: ${track.targets
              .map((t) => `${t.label}=${t.height}`)
              .join(", ")}`
          ).toEqual([CONTROL_BOX_PX]);
          for (const target of track.targets) {
            expect(
              target.block,
              `${target.label} @${width} reach per side`
            ).toBe(TAP_TARGET_INSET_PX);
            expect(
              target.inline,
              `${target.label} @${width} reaches sideways into the segment beside it; a tiled track has no gap to spend`
            ).toBe(0);
            expect(
              target.height + 2 * target.block + TAP_FLOOR_FLOAT_EPSILON_PX,
              `${target.label} @${width} effective height`
            ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
            expect(
              target.width + 2 * target.inline + TAP_FLOOR_FLOAT_EPSILON_PX,
              `${target.label} @${width} effective inline width`
            ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
          }
          expect(
            track.gaps.length,
            `${surface.route} @${width} has no adjacent segment pair to measure`
          ).toBeGreaterThan(0);
          expect(
            track.gaps.every((gap) => Math.abs(gap) < 0.5),
            `@${width} segments marked as a tiled track leave gaps between them (${track.gaps
              .map((gap) => gap.toFixed(2))
              .join(
                ", "
              )}px); a gapped row takes the all-sides reach, not this marker`
          ).toBe(true);
          expect(
            track.overlaps,
            `@${width} two extended segment targets own the same point`
          ).toEqual([]);
        }
      }
    });
  }
});

// THE OWNER'S OTHER ROW (#3954). `SymptomSeverityControl`'s four options used to
// render 44 square beside the 34px icon buttons that share their line — the
// report that opened #3938 in the first place. One height is half the claim; the
// other half is that four 34px squares 12px apart do not overlap once each one
// carries its reach.
test.describe("the illness cockpit's symptom row (#3954)", () => {
  test.use({ viewport: PHONE });

  test("renders exactly one height with disjoint hit regions", async ({
    page,
  }) => {
    await page.goto("/");
    const row = page.getByTestId("symptom-cough");
    await expect(row).toBeVisible();
    // Wait for the CONTENT this measures: the row's testid is on the card, and a
    // card whose severity control has not mounted sweeps to an empty, green list.
    await expect(page.getByTestId("symptom-cough-sev-1")).toBeVisible();

    const geometry = await row.evaluate((el, epsilon) => {
      const targets = Array.from(
        el.querySelectorAll<HTMLElement>("button")
      ).filter((t) => t.getBoundingClientRect().height > 0);
      const boxes = targets.map((t) => {
        const r = t.getBoundingClientRect();
        const after = getComputedStyle(t, "::after");
        const side = (raw: string) => {
          const inset = Math.abs(Number.parseFloat(raw));
          return after.content === "none" || !Number.isFinite(inset)
            ? 0
            : inset;
        };
        const block = side(after.top);
        const inline = side(after.left);
        return {
          what: t.getAttribute("aria-label")?.slice(0, 28) ?? t.tagName,
          height: r.height,
          left: r.left - inline,
          right: r.right + inline,
          top: r.top - block,
          bottom: r.bottom + block,
        };
      });
      const overlaps: string[] = [];
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
        }
      return { boxes, overlaps };
    }, TAP_FLOOR_FLOAT_EPSILON_PX);

    // The four severity options AND the note/clear icon buttons beside them: a
    // sweep that found only the severity control would be green on the very row
    // the report was about.
    expect(
      geometry.boxes.length,
      "the row must mix the severity options with the icon buttons"
    ).toBeGreaterThan(4);
    expect(
      [...new Set(geometry.boxes.map((b) => Math.round(b.height)))],
      `the symptom row renders more than one height: ${geometry.boxes
        .map((b) => `${b.what}=${b.height}`)
        .join(", ")}`
    ).toEqual([CONTROL_BOX_PX]);
    expect(
      geometry.overlaps,
      "two extended targets in the symptom row own the same point; the row's gap must be at least twice the reach"
    ).toEqual([]);
  });
});

// THE FACT CHIP IS A CONTROL KIND (#4035). The fact row's chips drew their own 44 in
// all eight consumers and were in NO vocabulary here, so nothing measured them — the
// gap the owner reported as "these chips are huge". They wear `data-fact-chip` now and
// this is where that is checked.
//
// WHY A TEST OF ITS OWN RATHER THAN A ROW IN `BOX_ROUTES`. Every entry in that table is
// a plain `goto` plus a readiness marker, deliberately, and NO route in this app renders
// a fact row on arrival: a fact row is a FORM's summary, and every form is behind a
// door. One click is the smallest honest way in, so the kind is measured here instead of
// weakening that table's contract.
//
// WHAT THIS FIXTURE REACHES, said plainly because a shape it cannot produce is a shape
// this test cannot be claiming anything about. A fresh injury form states two MISSING
// essentials and the one trailing affordance — three `solo` chips, the shape eight
// consumers draw. The REMOVABLE chip (`pill` plus two `tiled` halves) needs a rule to
// exist first, and it is measured where the walk that builds one already runs:
// e2e/tap-target-census.mobile.spec.ts's "fact chip split", which asserts the same
// effective floor and the same disjointness on exactly those two halves.
//
// AND THE BOUND KINDS BESIDE THEM, at the same instant: "34" also passes on a form
// where everything shrank together, so the form's own `button-control` submit and its
// `btn-ghost` are swept into the same one-height set rather than compared to the
// constant alone.
test.describe("the fact chip wears the box (#4035)", () => {
  test.use({ viewport: PHONE });

  test(`the injury form's fact row is one box at ${BOX_WIDTHS.join("/")}, with disjoint reach`, async ({
    page,
  }) => {
    await page.goto("/training?tab=overview");
    const bar = page.getByRole("main").getByTestId("injury-bar");
    await expect(bar).toBeVisible();
    // A pure client toggle and the first interaction after a navigation, so the tap
    // itself can be lost pre-hydration with no error (#2942).
    await hydratedClick(page, bar.getByTestId("injury-add-toggle"));
    const form = bar.getByTestId("injury-form");
    await expect(form).toBeVisible();
    // Wait for the CONTENT this measures, not its container: a row swept before its
    // chips mount reports an empty corpus and passes on nothing.
    await expect(form.getByTestId("injury-fact-label")).toBeVisible();

    for (const width of BOX_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await form.evaluate((el) => {
        const read = (t: HTMLElement) => {
          const r = t.getBoundingClientRect();
          const after = getComputedStyle(t, "::after");
          const side = (raw: string) => {
            const inset = Math.abs(Number.parseFloat(raw));
            return after.content === "none" || !Number.isFinite(inset)
              ? 0
              : inset;
          };
          const block = side(after.top);
          const inline = side(after.left);
          return {
            what:
              t.getAttribute("data-testid") ??
              (t.textContent ?? "").trim().slice(0, 20),
            shape: t.getAttribute("data-fact-chip") ?? "bound kind",
            height: r.height,
            block,
            inline,
            left: r.left - inline,
            right: r.right + inline,
            top: r.top - block,
            bottom: r.bottom + block,
          };
        };
        const visible = (t: HTMLElement) =>
          t.getBoundingClientRect().height > 0;
        const chips = Array.from(
          el.querySelectorAll<HTMLElement>("[data-fact-chip]")
        )
          .filter(visible)
          .map(read);
        const bound = Array.from(
          el.querySelectorAll<HTMLElement>(
            '[data-testid="injury-submit"], .btn-ghost'
          )
        )
          .filter(visible)
          .map(read);
        const overlaps: string[] = [];
        for (let i = 0; i < chips.length; i += 1)
          for (let j = i + 1; j < chips.length; j += 1) {
            const x =
              Math.min(chips[i].right, chips[j].right) -
              Math.max(chips[i].left, chips[j].left);
            const y =
              Math.min(chips[i].bottom, chips[j].bottom) -
              Math.max(chips[i].top, chips[j].top);
            if (x > 0 && y > 0)
              overlaps.push(`${chips[i].what}/${chips[j].what}`);
          }
        return { chips, bound, overlaps };
      });

      expect(
        geometry.chips.length,
        `the injury fact row @${width} swept no fact chips`
      ).toBeGreaterThan(2);
      expect(
        geometry.bound.length,
        `the injury form @${width} must also render an already-bound kind to compare against`
      ).toBeGreaterThan(0);
      // What this fixture actually produces. Recorded rather than assumed, so a
      // removable chip appearing on this row later reads as "extend this test" instead
      // of as a height failure on a shape whose box is its pill's.
      expect([...new Set(geometry.chips.map((c) => c.shape))]).toEqual([
        "solo",
      ]);

      expect(
        [
          ...new Set(
            [...geometry.chips, ...geometry.bound].map((c) =>
              Math.round(c.height)
            )
          ),
        ],
        `the injury form @${width} renders more than one box: ${[
          ...geometry.chips,
          ...geometry.bound,
        ]
          .map((c) => `${c.what}=${c.height}`)
          .join(", ")}`
      ).toEqual([CONTROL_BOX_PX]);

      for (const chip of geometry.chips) {
        // A solo chip has a gap around it, so unlike a tiled one it takes the reach on
        // BOTH axes — and the row's `pointer-coarse:gap-3` is what pays for the inline
        // half without taking it from the chip next door.
        expect(chip.block, `${chip.what} @${width} block reach`).toBe(
          TAP_TARGET_INSET_PX
        );
        expect(chip.inline, `${chip.what} @${width} inline reach`).toBe(
          TAP_TARGET_INSET_PX
        );
        expect(
          chip.height + 2 * chip.block + TAP_FLOOR_FLOAT_EPSILON_PX,
          `${chip.what} @${width} effective height`
        ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      }

      expect(
        geometry.overlaps,
        `@${width} two extended fact chips own the same point; the row's gap must be at least twice the reach`
      ).toEqual([]);
    }
  });
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
    await openFoodAdd(page);
    await expect(page.getByTestId("food-log-bar")).toBeVisible();

    // Wait for the CONTENT this measures. A row still folded behind "more
    // groups" is not in the DOM, and a sweep over what is not there is green.
    const row = page.getByTestId("food-group-nuts_seeds");
    if (!(await row.isVisible())) {
      await page.getByTestId("food-more-groups-summary").click();
      await expect(row).toBeVisible();
    }

    // THE MINUS IS NOT DRAWN AT ZERO (#3987) — a permanently disabled control on the
    // row people tap most is chrome that says nothing. It is still a stepper and still
    // owes the floor, so the row is put at a non-zero count to bring it on screen, and
    // restored below. Measuring only the "+" would quietly halve what this test covers.
    await settledClick(page, page.getByTestId("log-nuts_seeds"));
    await expect(page.getByTestId("undo-nuts_seeds")).toBeVisible();

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
    }

    // Leave the shared profile's day as it was found.
    await settledClick(page, page.getByTestId("undo-nuts_seeds"));
  });

  // THE SWEEP, TIGHTENED AND WIDENED (#4505). It asked `height >= 32` of `/nutrition`
  // alone, so 36, 40 and 44 passed it by construction and every other route was
  // unmeasured. Now: EXACT box on both hand-rolled kinds — `.tap-target` (a control
  // that spells `h-(--control-box)` itself) and `.fold-control` (the `<summary>` that
  // is a control) — on several routes at three widths, with the inline half of the
  // floor measured too, since a guard that reads height alone is how C's #5399
  // finding was missed.
  //
  // THE CONVERSE, so dropping the class is not an escape: every bare `<summary>` on
  // the route must be a ROW — a card header stacking a title over a description,
  // which #3979 rules is not a control — measured as a descendant holding two or
  // more block-level children, or one of the ruled row-mechanism folds cited here
  // by testid. THE CITED THREE, by issue: `food-more-groups-summary` (#3987 — one
  // dense line row, the same height as the rows it extends),
  // `dashboard-everything-*-fold-summary` (#4232's band fold) and
  // `suppressed-summary` (upcoming/FoldSummary, pinned by its own spec). The other
  // three row-mechanism sites the issue cites — IllnessNowGroup's toggle and its
  // "More details" link (#3514) and DoseHistoryPanel's sheet rows — wear neither
  // class and are not `<summary>`, so this sweep never reaches them; they are
  // recorded here so their absence reads as scope rather than as coverage.
  //
  // WHAT THIS DOES NOT COVER, said plainly: controls that exist only after an
  // interaction. A toast's buttons are rendered from `shown.map(...)`, so a plain
  // `goto` renders none and a green here says nothing about them; the toast is
  // measured by the targeted case below, and the add-layer's controls by the
  // `open` step /nutrition declares. Anything else behind a door is outside this
  // sweep's claim.
  const SWEEP_ROUTES: {
    route: string;
    ready: string;
    open?: (page: import("@playwright/test").Page) => Promise<void>;
  }[] = [
    { route: "/", ready: "dashboard-canvas" },
    // EVERY `.tap-target` ON /nutrition IS IN THE ADD LAYER, behind one door (#4477).
    { route: "/nutrition", ready: "food-log-bar", open: openFoodAdd },
    { route: "/medications", ready: "medication-share-open" },
    { route: "/upcoming", ready: "upcoming-total" },
    { route: "/settings/notifications", ready: "notification-kinds" },
    {
      route: "/records/history/immunizations",
      ready: "immunization-schedule-disclosure",
    },
  ];
  const SWEEP_WIDTHS = [390, 768, 1280];
  const CITED_ROW_FOLDS = [
    "food-more-groups-summary",
    "dashboard-everything-",
    "suppressed-summary",
  ];

  for (const { route, ready, open } of SWEEP_ROUTES) {
    test(`every hand-rolled control on ${route} is the box at ${SWEEP_WIDTHS.join("/")}`, async ({
      page,
    }) => {
      await page.goto(route);
      await expect(page.getByTestId(ready)).toBeVisible();
      if (open) await open(page);

      for (const width of SWEEP_WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        // Visibility and geometry from ONE rendered snapshot: a `:visible` filter
        // and a later `evaluateAll` can straddle a responsive transition and leave
        // now-hidden controls in the set with a 0px box. Zero area is not rendered.
        const swept = await page.evaluate(
          ({ box, floor, epsilon, cited }) => {
            const rectOf = (el: Element) => el.getBoundingClientRect();
            const reachOf = (el: Element) => {
              const after = getComputedStyle(el, "::after");
              const side = (raw: string) => {
                const inset = Math.abs(Number.parseFloat(raw));
                return after.content === "none" || !Number.isFinite(inset)
                  ? 0
                  : inset;
              };
              return { block: side(after.top), inline: side(after.left) };
            };
            const nameOf = (el: Element) =>
              el.getAttribute("data-testid") ??
              el.getAttribute("aria-label") ??
              (el.textContent ?? "").trim().slice(0, 30);
            const offBox: string[] = [];
            let controls = 0;
            let folds = 0;
            for (const el of Array.from(
              document.querySelectorAll<HTMLElement>(
                ".tap-target, .fold-control"
              )
            )) {
              const r = rectOf(el);
              if (r.width <= 0 || r.height <= 0) continue;
              controls += 1;
              if (el.classList.contains("fold-control")) folds += 1;
              const style = getComputedStyle(el);
              const lineHeight = Number.parseFloat(style.lineHeight);
              const extra = (r.height - box) / lineHeight;
              const lines = Math.round(extra);
              const wholeLines =
                Number.isFinite(extra) && Math.abs(extra - lines) <= 0.02;
              const singleLine =
                style.whiteSpace === "nowrap" || el.tagName === "INPUT";
              const reach = reachOf(el);
              const what = `<${el.tagName.toLowerCase()} ${nameOf(el)}>`;
              if (!wholeLines || lines < 0 || (singleLine && lines !== 0))
                offBox.push(
                  `${what} renders ${r.height}px (${box} + ${extra.toFixed(3)} line boxes of ${lineHeight}px)`
                );
              if (r.height + 2 * reach.block + epsilon < floor)
                offBox.push(
                  `${what} reaches ${r.height + 2 * reach.block}px tall`
                );
              if (r.width + 2 * reach.inline + epsilon < floor)
                offBox.push(
                  `${what} reaches ${r.width + 2 * reach.inline}px wide`
                );
            }
            const bareFolds: string[] = [];
            for (const el of Array.from(
              document.querySelectorAll<HTMLElement>(
                "summary:not(.fold-control)"
              )
            )) {
              const r = rectOf(el);
              if (r.width <= 0 || r.height <= 0) continue;
              const testId = el.getAttribute("data-testid") ?? "";
              if (cited.some((id) => testId.startsWith(id))) continue;
              const isBlock = (node: Element) =>
                /^(block|flex|grid|list-item)$/.test(
                  getComputedStyle(node).display
                ) && (node.textContent ?? "").trim().length > 0;
              const stacksTitleOverDescription = Array.from(
                el.querySelectorAll("*")
              ).some(
                (node) => Array.from(node.children).filter(isBlock).length >= 2
              );
              if (!stacksTitleOverDescription)
                bareFolds.push(`<summary ${nameOf(el)}> at ${r.height}px`);
            }
            return { controls, folds, offBox, bareFolds };
          },
          {
            box: CONTROL_BOX_PX,
            floor: TAP_FLOOR_PX,
            epsilon: TAP_FLOOR_FLOAT_EPSILON_PX,
            cited: CITED_ROW_FOLDS,
          }
        );
        // A sweep over nothing is green and says nothing.
        expect(
          swept.controls,
          `${route} @${width} swept no controls`
        ).toBeGreaterThan(0);
        expect(
          swept.folds,
          `${route} @${width} swept no fold-control`
        ).toBeGreaterThan(0);
        expect(
          swept.offBox,
          `${route} @${width}: a hand-rolled control is off the ${CONTROL_BOX_PX}px box or ` +
            `under the ${TAP_FLOOR_PX}px effective floor. One height, no exceptions ` +
            "(#3938, re-ratified on #4505); give it `h-(--control-box)` / `fold-control`."
        ).toEqual([]);
        expect(
          swept.bareFolds,
          `${route} @${width}: a <summary> that is one line — a control — wears no ` +
            "`fold-control`, and is neither a title-over-description row (#3979) nor a " +
            "cited row-mechanism fold. Adopt the class, or cite the ruling here."
        ).toEqual([]);
      }
    });
  }
});

// THE TOAST'S PAIR (#4505; owner ruling 2026-09-05 overturning the rendered 44 that
// #2642 and #644 had argued). Below `md` the action and the dismiss render the box
// and take `.tap-target`'s reach, 46 effective; from `md` up the action is the
// inline link under the message and the dismiss its bare glyph, by design, so this
// is a phone claim. TRIGGERED, because the sweep above cannot see it: a toast's
// buttons exist only inside a rendered toast. The e2e fixture harness raises one
// through the same Toast layer with no write behind it, and its notice carries an
// action for exactly this measurement.
test.describe("the toast's action and dismiss wear the box (#4505)", () => {
  test.use({ viewport: PHONE });

  test("a rendered toast's pair is the box with reach at 390", async ({
    page,
  }) => {
    await page.goto("/e2e-fixtures/bottom-sheet");
    const raise = page.getByRole("dialog").getByTestId("fixture-raise-notice");
    await hydratedClick(page, raise);
    const toast = page.getByTestId("toast"); // testid-scope-ok: the toast layer is portalled above every streamed boundary
    await expect(toast).toContainText("Fixture notice.");
    const pair = [
      toast.getByRole("button", { name: "Undo" }),
      toast.getByRole("button", { name: "Dismiss" }),
    ];
    const boxes = await settledBoxes(pair);
    expect(
      boxes.map((b) => Math.round(b.height)),
      "the toast's action and dismiss render more than one height"
    ).toEqual([CONTROL_BOX_PX, CONTROL_BOX_PX]);
    expect(Math.round(boxes[1].width), "the dismiss is square").toBe(
      CONTROL_BOX_PX
    );
    await expectPhoneTapTargets(page, "the toast's pair", pair, {
      disjoint: true,
    });
  });
});

// ONE CONTROL, TWO STATES, ONE HEIGHT (#4505 family 5). The weekly-target toggle
// rendered `btn-ghost` closed and a hand-rolled `min-h-11` open; both states are
// the box now. ProtocolLogButton's two tones share the dose-action pill, whose box
// e2e/dose-history.spec.ts pins, and the lightbox delete is behind a photo — a
// fixture this table does not build — so the state pair is the case measured here.
test.describe("the weekly-target toggle is one height open and closed (#4505)", () => {
  test.use({ viewport: PHONE });

  test("renders the box in both states at 390", async ({ page }) => {
    await page.goto("/training?tab=plan");
    const toggle = page
      .getByRole("main")
      .getByTestId("frequency-target-toggle");
    await expect(toggle).toBeVisible();
    const [closed] = await settledBoxes([toggle]);
    await hydratedClick(page, toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const [open] = await settledBoxes([toggle]);
    expect(
      [Math.round(closed.height), Math.round(open.height)],
      "the toggle renders two heights across its states"
    ).toEqual([CONTROL_BOX_PX, CONTROL_BOX_PX]);
    await expectPhoneTapTargets(page, "the open weekly-target toggle", [
      toggle,
    ]);
  });
});

// THE BADGE THAT WAS A BUTTON (#4505 family 4). The mood form's day and factor chips
// were `.badge`-styled buttons at 22px with no reach at all; they render through
// `Chip` now — `chip-base`, an already-bound kind — in a `gap-1.5
// pointer-coarse:gap-3.5` row, and its Details fold is a `fold-control`. The factor
// row is measured here because it is on the sheet on arrival; the day chips exist
// only when a day was missed, and are the same primitive in the same row grammar.
test.describe("the mood sheet's chips and fold wear the box (#4505)", () => {
  test.use({ viewport: PHONE });

  test(`the factor chips and the Details fold are one box at ${BOX_WIDTHS.join("/")}`, async ({
    page,
  }) => {
    await page.goto("/?quick=log-mood");
    const form = page.getByRole("dialog").getByTestId("mood-form");
    await expect(form).toBeVisible();
    const details = form.getByTestId("mood-details").locator("summary");
    await hydratedClick(page, details);
    const chips = form.locator('[data-chip-role="filter"]');
    await expect(chips.last()).toBeVisible();

    for (const width of BOX_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const targets = [details, ...(await chips.all())];
      const boxes = await settledBoxes(targets);
      expect(
        [...new Set(boxes.map((b) => Math.round(b.height)))],
        `the mood sheet @${width} renders more than one box: ${boxes
          .map((b) => b.height)
          .join(", ")}`
      ).toEqual([CONTROL_BOX_PX]);
      await expectPhoneTapTargets(page, `the mood sheet @${width}`, targets, {
        disjoint: true,
      });
    }
  });
});

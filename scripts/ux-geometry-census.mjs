// GEOMETRY PROBES FOR THE UX CENSUS (#3489, deliverable 1).
//
// WHY THIS EXISTS. A single live phone review on 2026-08-21 filed fifteen issues
// that many past census runs never surfaced, and three of them are pure geometry:
// the dose ledger's Item select sizing to its widest imported name and running off
// the right edge (#3478), the medicine cabinet's add row pairing an `input`-height
// select with a `btn-sm` submit (#3481), and the wellness `+` rendering ~4px
// shorter than every labeled sibling (#3486). All three are MECHANICALLY
// DETECTABLE. None was detected, because the census only ever took pictures — and
// a contact sheet at 220px tall cannot show a 4px height difference or a control
// whose right edge is one chevron past the viewport.
//
// ── IT MEASURES BOXES, NOT DECLARATIONS ─────────────────────────────────────────
//
// Every reading below comes from `getBoundingClientRect()` on a real element in a
// real viewport. That is not a stylistic preference. A computed-style assertion
// measures a DECLARATION and the user sees a RENDERED result: #3466 shipped a
// stepped 16px seam whose rendered gap stayed 24px because it collapsed against an
// unstepped parent two files away, and the guard that was supposed to catch it read
// the computed value on that exact element and saw 16. `min-h-10` in a class string
// is not evidence a button is 40px tall, and a `min-block-size` in a stylesheet is
// not evidence the rule reached this element. So: boxes.
//
// ── IT MEASURES, IT DOES NOT ASSERT ─────────────────────────────────────────────
//
// The census is a seeing tool (`.claude/skills/ux-walkthrough/SKILL.md`'s standing
// rule) and #3489 puts "making any of this a CI gate" explicitly out of scope. The
// probe's output lands in `metrics.json` and as two ranked tables in `audit.md`; a
// human reads them. What IS asserted, in CI, is that the probe can SEE — see
// e2e/ux-geometry-probe.mobile.spec.ts, which plants offenders of both classes in a
// live DOM and requires them back, and asserts the probe's silence on the benign
// neighbours that would get it deleted within a week if it cried wolf on them.
//
// #3481 HAS SINCE BEEN FIXED (2026-08-23), so the medicine cabinet's add row no
// longer serves as a live example of the height class — the sentences above and
// below describe what the probe was BUILT to find, not what is on main today.
//
// ── AND A THIRD PROBE, ADDED BECAUSE THE SWEEP LIED ONCE (#3814) ────────────────
//
// A phone review read `textContent` off Data -> Trash, got `"Recently
// deletedDeleted rows are kept here for 30 days…"`, and filed a collision (#3716).
// The two boxes were correctly stacked; the string is what `textContent` returns
// for any two block elements, so that finding was unfalsifiable as filed and the
// sweep would have re-filed its shape for every heading above a paragraph in the
// app. Probe (c) below answers the same question from RECTS, and the refutation
// cost more work than fixing a real bug would have — which is the argument for
// making the instrument honest rather than reading its output more carefully.
//
// ── WHAT IT FOUND ON ITS FIRST RUN, so "it works" is not left as a claim ────────
//
// Measured 2026-08-22 against the e2e seed at 390px, by the guard spec itself. Both
// are RECORDED, not fixed — #3489 puts fixing individual findings out of scope, and
// neither of these is among the fifteen the phone review filed:
//
//   • /supplies — three `<span>· Supply Parent (e2e)</span>` run 8–16px past the
//     right edge with nothing that scrolls to them. #3478's class exactly, on a
//     surface nobody had looked at, found with no human in the loop.
//     DIAGNOSED 2026-08-23 (#3607 item 1) AND IT WAS THE PROBE, not the page: the
//     three spans sit inside a `.truncate` chip label, which is `white-space:
//     nowrap` — so their rects keep full natural width while the ancestor's
//     `overflow: hidden` clips them at 250px and paints an ellipsis. Nothing was
//     off screen. `insideEllipsisTruncation` below now exempts exactly that, and
//     only when the truncating ancestor is itself inside the viewport.
//   • /trends/metric/weight — one row pairs a 40px `metric-measurement-toggle`
//     (a `.btn`, sitting on the family's 40px phone floor) with a 36px
//     `star-toggle`. #3486's shape surviving the fix that closed #3486: the floor
//     is declared for `.btn`/`.btn-ghost`/`.btn-danger`, and StarButton is a
//     hand-rolled `h-9 w-9` (components/StarButton.tsx) that is not a member of
//     that family, so nothing reached it. A class-string guard could not have said
//     this; only the two rendered boxes side by side can.
//
// These are the "corpus count" half of proving a guard can see (a scan that found
// real candidates reaches the tree); the guard spec carries the other half (a
// hand-written violation comes back flagged). Neither implies the other.
//
// ── WHY A `.mjs` MODULE AND NOT `lib/*.ts` ──────────────────────────────────────
//
// The same reason `scripts/ux-census-routes.mjs` is one: the harness is run as
// plain `node scripts/ux-walkthrough.mjs`, so it cannot import TypeScript, while
// vitest and Playwright can both import this. One spelling of the rule, three
// readers — the alternative is a probe in the harness and a second copy in the
// guard, which is the arrangement that lets a guard go quietly green while the
// thing it guards drifts.

/**
 * The two thresholds, with their units, and where each number comes from.
 *
 * Stating the unit is not bookkeeping. #3391 measured the cost of not doing it: a
 * lane asked to write down what a bound was FOR discovered while writing the
 * sentence that the bound was checked against the wrong quantity and could never
 * fire. Having to say out loud what a number bounds is the check.
 */
export const GEOMETRY_THRESHOLDS = {
  /**
   * PIXELS OF RENDERED HEIGHT. Two interactive controls sharing one visual row may
   * differ by at most this much before the row is reported. 2px is #3489's own
   * number, and it is a NOISE floor rather than a design tolerance: sub-pixel
   * layout and a 1px border difference are not what anybody means by "two control
   * heights". The defects it must clear are much larger — #3481's `input` beside a
   * `btn-sm`, and #3486's icon-only button, 4px short of its labeled siblings.
   *
   * #3481's spread was MEASURED at 6px when it was fixed (2026-08-23), not the 8px
   * this comment used to state from the issue's own prose — and it read 6px in BOTH
   * directions: a 38px select against a 32px `btn-sm` at 1280px, and 38px against
   * 44px at 390px once #3486's own fix put the button family on its tap floor. Both
   * clear a 2px noise floor three-fold, which is the claim this number has to be
   * able to make about itself; the correction is recorded because a threshold
   * justified by a number nobody re-measured is a guess wearing a citation.
   */
  controlHeightTolerancePx: 2,
  /**
   * PIXELS OF RENDERED WIDTH past the viewport edge. A box must exit by more than
   * this to be called clipped, so that a border-box rounding to 390.4px on a 390px
   * viewport is not a finding. #3478's select overhangs by tens of pixels.
   */
  clipEpsilonPx: 1,
  /**
   * PIXELS OF RENDERED OVERLAP, on each axis, before two text boxes are called
   * collided. Two independent rect reads cannot be compared exactly (#2505) and a
   * shared border rounds; the defect this looks for puts a whole line of copy on
   * top of another and overlaps by tens of pixels. Data → Trash's correctly stacked
   * pair — `<h2>` at [128, 152], `<p>` at [156, 276], measured at 390x844 — does not
   * overlap vertically AT ALL, so it clears this by 4px of gap rather than by the
   * tolerance.
   */
  overlapEpsilonPx: 1,
  /**
   * Rows kept per route/viewport in `metrics.json`. A capped list keeps one
   * pathological page from making the artifact unreadable; the UNCAPPED count is
   * recorded beside it so a truncation is never silent.
   */
  maxRowsPerVisit: 12,
};

/**
 * THE IN-PAGE PROBE. Runs inside the browser, under `page.evaluate`, in both the
 * census harness and the guard spec.
 *
 * SELF-CONTAINED ON PURPOSE: `page.evaluate` serializes this function's SOURCE into
 * the page, so it may not reference anything in module scope. Every helper is
 * defined inside it and every threshold arrives as an argument — which is also what
 * keeps the harness and the guard measuring with the same numbers instead of two
 * drifting copies.
 *
 * `subjectSelector` is the NAMED SUBJECT (#3522's pattern): a selector the caller
 * claims this surface renders. The probe reports whether it was among the boxes it
 * actually measured, which is the tighter half of proving a sweep took place — a
 * candidate COUNT says "something was here", the subject says "the thing you are
 * making a claim about was here". The harness does not pass one; the guard does.
 *
 * `forgeries` is a GUARD-ONLY affordance and the census never passes it: HTML
 * fragments appended to `<main>` for the duration of ONE measurement and removed
 * before this returns.
 *
 * It exists because the guard cannot plant in one call and measure in another.
 * Measured 2026-08-22: on a live App Router page a re-render between the two
 * removes the planted node — 1 run in 5 on `/wellness`, with the node reading
 * `connected: false` at probe time while the surviving runs read an identical rect
 * every time. A stable value with an unstable occurrence is something real
 * happening sometimes, not noise. The available answers were to re-plant until it
 * stuck (a retry, which masks which step raced) or to make the plant and the
 * measurement THE SAME SYNCHRONOUS TURN, after which there is nothing left to race.
 * This is the second.
 *
 * @param {{controlHeightTolerancePx: number, clipEpsilonPx: number, overlapEpsilonPx: number, maxRowsPerVisit: number, subjectSelector?: string, forgeries?: string[]}} opts
 */
export function geometryProbe(opts) {
  const {
    controlHeightTolerancePx,
    clipEpsilonPx,
    overlapEpsilonPx,
    maxRowsPerVisit,
  } = opts;
  const subjectSelector = opts.subjectSelector ?? null;
  let subjectExamined = false;

  // SCOPE: `<main>`. The page's own content, not the shell.
  //
  // Off-canvas chrome is positioned outside the viewport BY DESIGN — a closed
  // drawer at `translate-x-full`, a sheet parked below the fold — so sweeping the
  // whole document would return a page's worth of "findings" that are the layout
  // working correctly, and a probe that cries wolf gets deleted (the #3325 lesson).
  // Every geometry defect #3489 cites is inside the page's own content. Same scope
  // choice, same reason, as the rendered-text census in lib/machine-date-census.ts.
  const root = document.querySelector("main");
  if (!root)
    return {
      clipCandidates: 0,
      clippedTotal: 0,
      clipped: [],
      controlRowsExamined: 0,
      heightRowsTotal: 0,
      heightRows: [],
      textBoxesExamined: 0,
      overlapsTotal: 0,
      overlaps: [],
      ...(subjectSelector ? { subjectExamined: false } : {}),
    };

  // The viewport's CONTENT width — `clientWidth` and not `innerWidth`, because
  // `innerWidth` includes a classic scrollbar and would forgive ~15px of real
  // overhang on a desktop run.
  const viewportWidth = document.documentElement.clientWidth;

  // Guard-only forgeries, planted here so the plant and the measurement are one
  // synchronous turn. `getBoundingClientRect()` below forces layout, so the boxes
  // read are the boxes these produce.
  const planted = [];
  for (const html of opts.forgeries ?? []) {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    for (const child of [...holder.children]) {
      root.appendChild(child);
      planted.push(child);
    }
  }
  const unplant = () => {
    for (const el of planted) el.remove();
  };
  try {
    return measure();
  } finally {
    unplant();
  }

  function measure() {
    const CONTROL_SELECTOR = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="switch"]',
      '[role="combobox"]',
    ].join(",");

    /** Rendered, non-degenerate, and actually painted. */
    const shown = (el) => {
      if (el.getClientRects().length === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    /** A human-readable name for an element, so a row NAMES what it found. */
    const describe = (el) => {
      const tag = el.tagName.toLowerCase();
      const testId = el.getAttribute("data-testid");
      const id = el.getAttribute("id");
      const text = (el.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 48);
      const label =
        el.getAttribute("aria-label") ||
        (el.tagName === "SELECT"
          ? `select of ${el.querySelectorAll("option").length} options`
          : "");
      return (
        tag +
        (testId ? `[data-testid="${testId}"]` : id ? `#${id}` : "") +
        (label ? ` (${label})` : text ? ` "${text}"` : "")
      );
    };

    // Document-relative coordinates, so a reading does not depend on where the page
    // happens to be scrolled when the probe runs. The census takes a full-page
    // screenshot immediately before this, and a full-page screenshot scrolls.
    const docLeft = (r) => r.left + window.scrollX;

    // ── PROBE (a): boxes that exit the viewport horizontally ──────────────────────
    //
    // The user-visible consequence has two shapes and this looks for both: a CONTROL
    // you cannot reach, and COPY you cannot read. So the candidate set is interactive
    // controls plus text leaves (an element with text and no element children) —
    // never every element, because a wrapper that overhangs reports the same single
    // defect once for each level of the tree above the thing that actually overhangs.
    const clipCandidateEls = new Set();
    for (const el of root.querySelectorAll(CONTROL_SELECTOR))
      clipCandidateEls.add(el);
    for (const el of root.querySelectorAll("*")) {
      if (el.children.length === 0 && (el.textContent ?? "").trim())
        clipCandidateEls.add(el);
    }

    /**
     * Is this element reachable by scrolling a scroller that was DESIGNED to scroll?
     * A wide table inside an `overflow-x:auto` wrapper is the layout working: the
     * user swipes and reads the rest. An `overflow-x:hidden` ancestor is the opposite
     * and is exactly #3478 — the app shell clips horizontal overflow, so the select's
     * cut-off right edge has no scroll that reaches it. Hidden therefore does NOT
     * exempt; only a scroller with something to scroll does.
     */
    const insideHorizontalScroller = (el) => {
      for (
        let p = el.parentElement;
        p && p !== document.body;
        p = p.parentElement
      ) {
        const ox = getComputedStyle(p).overflowX;
        if (
          (ox === "auto" || ox === "scroll") &&
          p.scrollWidth > p.clientWidth + 1
        )
          return true;
      }
      return false;
    };

    /**
     * The part of an element's box that is actually PAINTED: its own rect,
     * intersected with every clipping ancestor's.
     *
     * A rect is what layout gave an element, not what the reader sees, and the gap
     * between the two is this whole issue's subject. `sr-only` is the loudest case
     * — `position: absolute` on a 1px box with `overflow: hidden` — so every
     * screen-reader description inside one reports its full natural rect and every
     * such box piles them on top of each other. Measured before this: /wellness
     * returned 93 collisions and /nutrition?tab=supplements 62, nearly all of them
     * chart descriptions stacked inside a 1px box that paints none of them. A
     * census that reports the layout working gets deleted within a week (#3325),
     * and #3938 hit the same twelve `sr-only` boxes from the other direction.
     *
     * It is the same fact `insideEllipsisTruncation` encodes for probe (a): an
     * inline run under `white-space: nowrap` keeps its full natural width while the
     * ancestor paints an ellipsis at its own edge (#3607). Intersecting with the
     * clip states it once, for any clipping ancestor, without naming a mechanism.
     */
    const paintedRect = (el) => {
      const r = el.getBoundingClientRect();
      let { left, top, right, bottom } = r;
      const horizontalClips = [];
      for (
        let p = el.parentElement;
        p && p !== document.body;
        p = p.parentElement
      ) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const pr = p.getBoundingClientRect();
        left = Math.max(left, pr.left);
        top = Math.max(top, pr.top);
        right = Math.min(right, pr.right);
        bottom = Math.min(bottom, pr.bottom);
        if (cs.overflowX !== "visible")
          horizontalClips.push({
            right: pr.right,
            signalsEllipsis: cs.textOverflow === "ellipsis",
          });
      }
      return { left, top, right, bottom, horizontalClips };
    };

    /**
     * Is this element's overflow ABSORBED by an ancestor that truncates with an
     * ellipsis? `paintedRect` owns which ancestors clip and where they paint; this
     * helper keeps probe (a)'s narrower policy that the clip must signal an
     * ellipsis and its own right edge must remain inside the viewport. Silent
     * `overflow-x: hidden` is still #3478's reportable shape.
     */
    const insideEllipsisTruncation = (el) => {
      for (const clip of paintedRect(el).horizontalClips) {
        if (!clip.signalsEllipsis) continue;
        const pRight = clip.right + window.scrollX;
        if (pRight - viewportWidth <= clipEpsilonPx) return true;
      }
      return false;
    };

    const clipped = [];
    let clipCandidates = 0;
    for (const el of clipCandidateEls) {
      if (!shown(el)) continue;
      clipCandidates += 1;
      if (subjectSelector && el.matches(subjectSelector))
        subjectExamined = true;
      const r = el.getBoundingClientRect();
      const left = docLeft(r);
      const right = left + r.width;
      const overRight = right - viewportWidth;
      const overLeft = -left;
      const overflowPx = Math.round(Math.max(overRight, overLeft, 0));
      if (overflowPx <= clipEpsilonPx) continue;
      if (insideHorizontalScroller(el)) continue;
      if (insideEllipsisTruncation(el)) continue;
      clipped.push({
        el: describe(el),
        side: overRight > overLeft ? "right" : "left",
        overflowPx,
        // A box entirely outside the viewport reads differently from one whose edge
        // is cut off, so say which — the second is #3478's shape.
        visiblePart: left >= viewportWidth || right <= 0 ? "none" : "partial",
        width: Math.round(r.width),
        viewportWidth,
      });
    }
    clipped.sort((a, b) => b.overflowPx - a.overflowPx);

    // ── PROBE (b): control heights within one rendered row ────────────────────────
    //
    // A "row" is not a class name. `flex-wrap` means the declared row and the RENDERED
    // rows are different things, so rows are recovered from geometry: controls whose
    // vertical extents overlap are on one row. Ownership is by NEAREST flex/grid
    // ancestor, so a control is compared once, against the siblings it visually sits
    // beside, and a nested flex does not report its parent's row a second time.
    const isRowContainer = (el) => {
      const d = getComputedStyle(el).display;
      return (
        d === "flex" ||
        d === "inline-flex" ||
        d === "grid" ||
        d === "inline-grid"
      );
    };

    const byContainer = new Map();
    const allControls = [...root.querySelectorAll(CONTROL_SELECTOR)].filter(
      shown
    );
    const controlSet = new Set(allControls);
    if (subjectSelector && !subjectExamined)
      subjectExamined = allControls.some((el) => el.matches(subjectSelector));
    for (const el of allControls) {
      // A control that CONTAINS another control is a container wearing a control's
      // tag — a card-sized `<a>` wrapping a row of buttons. Comparing its height to
      // the buttons inside it is a category error and would flag every such card.
      if (
        [...el.querySelectorAll(CONTROL_SELECTOR)].some((c) =>
          controlSet.has(c)
        )
      )
        continue;
      let owner = null;
      for (
        let p = el.parentElement;
        p && p !== document.body;
        p = p.parentElement
      ) {
        if (isRowContainer(p)) {
          owner = p;
          break;
        }
      }
      if (!owner) continue;
      if (!byContainer.has(owner)) byContainer.set(owner, []);
      const r = el.getBoundingClientRect();
      byContainer.get(owner).push({
        el: describe(el),
        height: Math.round(r.height * 10) / 10,
        top: r.top + window.scrollY,
        bottom: r.top + window.scrollY + r.height,
      });
    }

    const heightRows = [];
    let controlRowsExamined = 0;
    for (const [container, controls] of byContainer) {
      if (controls.length < 2) continue;
      // Cluster into rendered rows: sorted by top, a control joins the open row when
      // its vertical extent overlaps that row's.
      controls.sort((a, b) => a.top - b.top);
      const rows = [];
      for (const c of controls) {
        const row = rows[rows.length - 1];
        if (row && c.top < row.bottom && c.bottom > row.top) {
          row.items.push(c);
          row.top = Math.min(row.top, c.top);
          row.bottom = Math.max(row.bottom, c.bottom);
        } else rows.push({ top: c.top, bottom: c.bottom, items: [c] });
      }
      for (const row of rows) {
        if (row.items.length < 2) continue;
        controlRowsExamined += 1;
        const heights = row.items.map((i) => i.height);
        const spread =
          Math.round((Math.max(...heights) - Math.min(...heights)) * 10) / 10;
        if (spread <= controlHeightTolerancePx) continue;
        heightRows.push({
          row: describe(container),
          spread,
          controls: row.items.map((i) => `${i.el} ${i.height}px`),
        });
      }
    }
    heightRows.sort((a, b) => b.spread - a.spread);

    // ── PROBE (c): text boxes that COLLIDE ────────────────────────────────────────
    //
    // #3716 reported Data -> Trash as `"Recently deletedDeleted rows are kept here
    // for 30 days…"` and read that concatenation as a collision. It was not one.
    // Measured at 390x844 the `<h2>` sits at [128, 152] and the `<p>` at [156, 276],
    // both `display: block`, both inside the card's 358px column: correctly stacked,
    // with 4px of gap. The string is simply what `textContent` returns for two block
    // elements, because extraction has no access to line breaks — so it is the same
    // string EVERY heading above a paragraph produces, and a finding of that form is
    // unfalsifiable as filed (#3814).
    //
    // So the evidence is the two BOXES, never the concatenation, and the claim is
    // the one a reader would make looking at the screen: ONE CONTAINER LAID THESE
    // TWO OUT AND THEY ARE PAINTED ON TOP OF EACH OTHER. The text rides along in
    // `describe()` to make the row recognisable — alongside the geometry rather than
    // in place of it.
    //
    // WHY THE PAIR MUST SHARE A PARENT, measured rather than assumed. Three rules
    // were run over six real routes at 390px before this one was chosen, counting
    // findings on /wellness, /nutrition?tab=supplements and / :
    //
    //   any two text boxes that overlap                        89, 62, 21
    //   …unless a positioned ancestor differs                  89, 62, 21
    //   …unless a positioned-or-z-stacked ancestor differs      4, 47, 21
    //   …only when ONE PARENT laid both out                     0,  0,  0
    //
    // The first three are the #3325 failure mode: an app layers text over text all
    // day on purpose — a disclosure popover over the row beneath it, a chip strip
    // over a card — and a census that reports the layout working gets deleted within
    // a week, taking its real findings with it. The last rule is silent on all six
    // and still catches a paragraph pulled up onto its own heading, which is the
    // defect this class was filed for and what e2e/ux-geometry-probe.mobile.spec.ts
    // forges. IT IS NARROWER THAN THE ISSUE'S WORDS: a title wrapped in a `<div>`
    // and a body beside it are not siblings, and that pair is not reported.
    const textLeaves = [];
    for (const el of root.querySelectorAll("*")) {
      if (el.children.length !== 0) continue;
      if (!(el.textContent ?? "").trim()) continue;
      if (!shown(el)) continue;
      const r = paintedRect(el);
      // A box clipped smaller than the tolerance cannot produce a finding anyway,
      // and it is not copy anybody is reading. Derived from the threshold rather
      // than picked.
      if (
        r.right - r.left <= overlapEpsilonPx ||
        r.bottom - r.top <= overlapEpsilonPx
      )
        continue;
      textLeaves.push({
        el,
        left: r.left + window.scrollX,
        right: r.right + window.scrollX,
        top: r.top + window.scrollY,
        bottom: r.bottom + window.scrollY,
      });
    }
    const textBoxesExamined = textLeaves.length;
    // Sorted by top, so the inner loop can stop at the first box that begins below
    // where this one ends — nothing after it can overlap vertically either.
    textLeaves.sort((a, b) => a.top - b.top);
    const overlaps = [];
    for (let i = 0; i < textLeaves.length; i++) {
      const a = textLeaves[i];
      for (let j = i + 1; j < textLeaves.length; j++) {
        const b = textLeaves[j];
        if (b.top >= a.bottom - overlapEpsilonPx) break;
        if (a.el.parentElement !== b.el.parentElement) continue;
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        // BOTH axes. Two runs side by side on one line overlap vertically and not
        // horizontally, and that is the commonest arrangement in the app; a heading
        // above a paragraph overlaps horizontally and not vertically, which is
        // #3716's whole case. Only a box painted ON another does both.
        if (overlapX <= overlapEpsilonPx || overlapY <= overlapEpsilonPx)
          continue;
        overlaps.push({
          container: describe(a.el.parentElement),
          a: describe(a.el),
          b: describe(b.el),
          overlapX: Math.round(overlapX),
          overlapY: Math.round(overlapY),
          aRect: [
            Math.round(a.left),
            Math.round(a.top),
            Math.round(a.right),
            Math.round(a.bottom),
          ],
          bRect: [
            Math.round(b.left),
            Math.round(b.top),
            Math.round(b.right),
            Math.round(b.bottom),
          ],
        });
      }
    }
    // Worst first, by the smaller of the two overlaps — a pair that overlaps 200px
    // horizontally and 1px vertically is a shared border, not a collision.
    overlaps.sort(
      (x, y) =>
        Math.min(y.overlapX, y.overlapY) - Math.min(x.overlapX, x.overlapY)
    );

    return {
      clipCandidates,
      clippedTotal: clipped.length,
      clipped: clipped.slice(0, maxRowsPerVisit),
      controlRowsExamined,
      heightRowsTotal: heightRows.length,
      heightRows: heightRows.slice(0, maxRowsPerVisit),
      textBoxesExamined,
      overlapsTotal: overlaps.length,
      overlaps: overlaps.slice(0, maxRowsPerVisit),
      ...(subjectSelector ? { subjectExamined } : {}),
    };
  }
}

/**
 * The two ranked `audit.md` sections, built from the metrics rows the harness
 * collected. Pure — no DOM, no filesystem — so lib/__tests__/ux-geometry-census.test.ts
 * can prove the ranking and the truncation notice without booting a browser.
 *
 * @param {Array<Record<string, any>>} metricsRows
 * @param {number} [top] how many rows each table shows
 * @returns {string[]} markdown lines (empty when nothing was found)
 */
export function geometryAuditSections(metricsRows, top = 15) {
  const lines = [];
  const clips = [];
  const rows = [];
  const collisions = [];
  for (const r of metricsRows) {
    for (const c of r.clipped ?? [])
      clips.push({ route: r.route, viewport: r.viewport, ...c });
    for (const h of r.heightRows ?? [])
      rows.push({ route: r.route, viewport: r.viewport, ...h });
    for (const o of r.overlaps ?? [])
      collisions.push({ route: r.route, viewport: r.viewport, ...o });
  }
  const truncated = (key, totalKey) =>
    metricsRows
      .filter((r) => (r[totalKey] ?? 0) > (r[key]?.length ?? 0))
      .map((r) => `${r.route} (${r.viewport}) ${r[totalKey]}`);

  if (clips.length) {
    clips.sort((a, b) => b.overflowPx - a.overflowPx);
    lines.push(
      "## Clipped elements (rendered box exits the viewport horizontally)",
      "",
      "Measured from `getBoundingClientRect()` inside `<main>`, excluding anything a designed horizontal scroller can reach. `visible: none` means the box is entirely off-screen; `partial` is #3478's shape — an edge cut off.",
      "",
      "| route | viewport | element | over px | visible | box w |",
      "|---|---|---|---|---|---|"
    );
    for (const c of clips.slice(0, top))
      lines.push(
        `| ${c.route} | ${c.viewport} | ${c.el} | ${c.overflowPx} (${c.side}) | ${c.visiblePart} | ${c.width} |`
      );
    const t = truncated("clipped", "clippedTotal");
    if (t.length) lines.push("", `Truncated per-visit lists: ${t.join(", ")}.`);
    lines.push("");
  }
  if (rows.length) {
    rows.sort((a, b) => b.spread - a.spread);
    lines.push(
      `## Mixed control heights in one rendered row (>${GEOMETRY_THRESHOLDS.controlHeightTolerancePx}px)`,
      "",
      "Rows are recovered from rendered geometry, not from `flex-wrap` class names; each control is compared against the controls it visually sits beside.",
      "",
      "| route | viewport | row | spread px | controls |",
      "|---|---|---|---|---|"
    );
    for (const h of rows.slice(0, top))
      lines.push(
        `| ${h.route} | ${h.viewport} | ${h.row} | ${h.spread} | ${h.controls.join(" · ")} |`
      );
    const t = truncated("heightRows", "heightRowsTotal");
    if (t.length) lines.push("", `Truncated per-visit lists: ${t.join(", ")}.`);
    lines.push("");
  }
  if (collisions.length) {
    collisions.sort(
      (a, b) =>
        Math.min(b.overlapX, b.overlapY) - Math.min(a.overlapX, a.overlapY)
    );
    lines.push(
      "## Colliding text (two rendered boxes overlap on both axes)",
      "",
      "The evidence is the two RECTS, `[left, top, right, bottom]` in document coordinates, clipped to what their ancestors actually paint. A heading above a paragraph reads as one string through `textContent` and is not a collision (#3814). Only pairs ONE container laid out are compared — an app layers text over text on purpose all day.",
      "",
      "| route | viewport | container | a | b | overlap x/y | a rect | b rect |",
      "|---|---|---|---|---|---|---|---|"
    );
    for (const c of collisions.slice(0, top))
      lines.push(
        `| ${c.route} | ${c.viewport} | ${c.container} | ${c.a} | ${c.b} | ${c.overlapX}/${c.overlapY} | ${c.aRect.join(", ")} | ${c.bRect.join(", ")} |`
      );
    const t = truncated("overlaps", "overlapsTotal");
    if (t.length) lines.push("", `Truncated per-visit lists: ${t.join(", ")}.`);
    lines.push("");
  }
  return lines;
}

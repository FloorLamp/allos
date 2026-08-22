// HOVER CAPTURES FOR THE UX CENSUS (#3489, deliverable 4).
//
// WHY THIS EXISTS. The census takes STATIC shots: it navigates, waits, and
// photographs the resting state. Anything that exists only while a pointer is over
// an element is therefore invisible to it BY CONSTRUCTION — not missed, not
// under-sampled, structurally unphotographable. #3489 names the miss: the Standing
// family door labels (#3459 item 2, the #3253 decision-2 affordance) were shipped,
// re-ruled and fixed without the census ever having produced one picture of them.
// #3375 is a whole issue about information that exists only on hover, and every
// site it lists is a surface the census has photographed many times without ever
// seeing the content the issue is about.
//
// A registered surface gets a SECOND capture, `…-hover.png`, beside its default
// shot — the same contract `DISCLOSURE_EXPANSIONS` uses for content behind a
// collapsed group (#2616), with `page.hover()` in place of the click loop.
//
// ── IT MEASURES THE RENDERED DIFFERENCE, NOT A CLASS AND NOT A STYLE ────────────
//
// The question a hover capture answers is "does this hover reveal something, and
// what". Neither half may be answered from a declaration. `.standing-row:hover
// .standing-door { opacity: 1 }` in app/globals.css is not evidence that a door
// appears — the rule may not reach the element, a later rule may win the cascade
// (which is exactly how #3459 item 1 shipped: `sm:` beat `min-[720px]:` because
// Tailwind cannot order a px breakpoint against its rem-based named ones), and an
// ancestor at `opacity: 0` makes the whole argument moot. So this module reads two
// rendered quantities and no declared ones:
//
//   1. PAINTED PIXELS. A clipped PNG of the region, taken before the hover and
//      again after it, compared as bytes. Playwright's encoder is deterministic, so
//      byte-identical means pixel-identical: this is the closest thing to "what the
//      user sees" that exists, and it has no interpretation layer at all.
//   2. ENGINE VISIBILITY. `Element.checkVisibility({ opacityProperty: true, … })`,
//      which is the rendering engine's own answer to "is this painted", inclusive
//      of ancestors — not `getComputedStyle(el).opacity` on the element, which is
//      a declaration read back and says nothing about the two ancestors above it.
//      Elements that flip visible/invisible across the hover are the PAYLOAD: they
//      are the information that only exists on hover, named, with their text.
//
// Boxes are read too (`getBoundingClientRect`), because a hover affordance often
// moves or grows something — the standing door's own `translateX(0.25rem) → 0` is
// a rendered 4px shift — but a move alone is decoration, and the module reports it
// as such rather than as revealed information.
//
// ── WHAT IT CANNOT CAPTURE, STATED SO NOBODY REGISTERS IT ───────────────────────
//
// A bare `title=` tooltip is NATIVE BROWSER CHROME. It is drawn by the browser
// outside the page, it is not in the DOM, and it does not appear in a screenshot at
// any viewport. #3489's deliverable text names "the sparkline titles" alongside the
// Standing doors; the sparkline titles are `title=` attributes
// (components/dashboard/StandingSparkline.tsx) and registering them here would
// produce a shot that shows nothing while sitting in the contact sheet looking like
// evidence, which is the failure mode this whole deliverable exists to avoid.
// #3375 owns that class and its fix is to stop using `title=`, not to photograph
// it. REGISTER ONLY hover states the PAGE renders: a CSS rule on a page element, or
// a JS/React panel. If you register a `title=` the mechanism does not lie — it
// reports a no-op and skips the shot — but it costs a BLIND SPOT line every run.
//
// ── WHY A `.mjs` MODULE AND NOT `lib/*.ts` ──────────────────────────────────────
//
// Same reason as scripts/ux-census-routes.mjs and scripts/ux-geometry-census.mjs:
// the harness runs as plain `node scripts/ux-walkthrough.mjs` and cannot import
// TypeScript, while vitest and Playwright can both import this. One spelling of the
// rule, three readers — the alternative is a probe in the harness and a second copy
// in the guard, which is the arrangement that lets a guard go quietly green while
// the thing it guards drifts.

/**
 * The thresholds, with their units and where each number comes from.
 *
 * Stating the unit is not bookkeeping (#3391): a lane asked to write down what a
 * bound was FOR discovered while writing the sentence that it was checked against
 * the wrong quantity and could never fire. Having to say out loud what a number
 * bounds is the check.
 */
export const HOVER_THRESHOLDS = {
  /**
   * MILLISECONDS to wait after the pointer lands before reading anything. The
   * app's hover affordances are CSS transitions: app/globals.css times the
   * Standing door exchange at 120ms ("deliberately faster than and NOT part of the
   * micro-motion vocabulary"), and the immunization grid's panel is a React state
   * update plus a paint. 400ms is ~3× the longest declared transition in the tree,
   * so a reading is taken at the END state and never mid-fade — an element caught
   * at opacity 0.5 reads as visible, which would make a no-op indistinguishable
   * from a reveal in the direction that flatters the census.
   */
  settleMs: 400,
  /**
   * PIXELS of padding around the measured region before the two clipped PNGs are
   * taken. A hover affordance commonly paints just outside its target's own box (a
   * focus ring, a shadow, the door's 4px slide), and a region cut exactly to the
   * box would call that no change. 24px covers every such bleed in this tree with
   * room to spare; it costs nothing but a slightly larger clip.
   */
  regionPadPx: 24,
  /**
   * PIXELS of rendered movement. An element visible before AND after must move or
   * resize by more than this to be reported as moved, so sub-pixel layout jitter is
   * not a finding. The standing door's `translateX(0.25rem)` is 4px.
   */
  movedEpsilonPx: 1,
  /**
   * Elements kept per registered entry in `hover.json` / `audit.md`. A capped list
   * keeps one pathological surface from making the artifact unreadable; the
   * UNCAPPED count is recorded beside it so a truncation is never silent.
   */
  maxElementsPerEntry: 8,
  /** Characters of an element's text kept in a row, so a table stays readable. */
  maxTextChars: 96,
};

/**
 * THE IN-PAGE SNAPSHOT. Runs inside the browser under `page.evaluate`, once before
 * the pointer lands and once after; `summarizeHover` diffs the two.
 *
 * SELF-CONTAINED ON PURPOSE: `page.evaluate` serializes this function's SOURCE into
 * the page, so it may not reference anything in module scope. Every helper is
 * defined inside it and every threshold arrives as an argument — which is also what
 * keeps the harness and the guard measuring with the same numbers instead of two
 * drifting copies.
 *
 * SCOPE IS `document.body`, NOT `<main>` — and that is the opposite choice from
 * scripts/ux-geometry-census.mjs, deliberately. The geometry probe scopes to
 * `<main>` because off-canvas chrome is positioned outside the viewport by design
 * and would flood it with non-findings. A hover panel does the opposite: the
 * immunization schedule grid PORTALS its tooltip to `document.body` on purpose
 * (`app/(app)/immunizations/ScheduleGrid.tsx` explains why — the card's
 * backdrop-filter would otherwise become its containing block), so the single
 * clearest example of "information that exists only on hover" in this tree is
 * OUTSIDE `<main>` by design. A `<main>`-scoped hover probe would report it as a
 * no-op, which is the failure direction that reads as a clean sweep.
 *
 * WHAT IS SNAPSHOTTED: text leaves and interactive controls, not every element. A
 * wrapper reports the same single reveal once per level of the tree above the thing
 * that actually appears.
 *
 * @param {{maxTextChars: number, subjectSelector?: string}} opts
 */
export function hoverSnapshot(opts) {
  const maxTextChars = opts.maxTextChars;
  const subjectSelector = opts.subjectSelector ?? null;
  const root = document.body;

  /**
   * A key that survives from one snapshot to the next. Structural, because an
   * element revealed by hover has no id of its own to be keyed by, and a text key
   * would move an element into a different bucket the moment the hover changes its
   * text (which is precisely what a door label does).
   */
  const keyOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== root; e = e.parentElement) {
      const parent = e.parentElement;
      if (!parent) break;
      let n = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling)
        if (s.tagName === e.tagName) n++;
      parts.push(`${e.tagName.toLowerCase()}:${n}`);
    }
    return parts.reverse().join(">");
  };

  /** A human-readable name, so a row NAMES what it found. */
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid");
    const id = el.getAttribute("id");
    const label = el.getAttribute("aria-label") || "";
    return (
      tag +
      (testId ? `[data-testid="${testId}"]` : id ? `#${id}` : "") +
      (label ? ` (${label})` : "")
    );
  };

  /**
   * THE ENGINE'S OWN ANSWER, not a declaration read back. `checkVisibility` walks
   * the inclusive ancestors for `display:none`, `visibility:hidden`, `opacity:0`
   * and `content-visibility:auto` skipping — the exact set of ways this tree hides
   * a hover payload (`app/globals.css` parks the standing door at `opacity: 0`,
   * three ancestors below the element that owns the hover rule). The old option
   * spellings are passed alongside the current ones so a browser on either side of
   * the rename answers the same question rather than silently ignoring the flag
   * and calling an `opacity: 0` element visible — which is the direction that turns
   * a reveal into a no-op and a no-op into a reveal.
   */
  const visible = (el) => {
    if (el.getClientRects().length === 0) return false;
    if (typeof el.checkVisibility === "function")
      return el.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
    const cs = getComputedStyle(el);
    return (
      cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0"
    );
  };

  const candidates = new Set();
  for (const el of root.querySelectorAll(
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role="button"],[role="link"],[role="tooltip"]'
  ))
    candidates.add(el);
  for (const el of root.querySelectorAll("*"))
    if (el.children.length === 0 && (el.textContent ?? "").trim())
      candidates.add(el);

  const elements = [];
  let subjectSeen = false;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const key = keyOf(el);
    if (subjectSelector && !subjectSeen && el.matches(subjectSelector))
      subjectSeen = true;
    elements.push({
      key,
      name: describe(el),
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, maxTextChars),
      visible: visible(el),
      // Document-relative, so a reading does not depend on where the page happens
      // to be scrolled: `scrollIntoViewIfNeeded` before the hover and the hover
      // itself can both scroll, and a viewport-relative box would then read as
      // "moved" on every entry.
      rect: [
        Math.round(r.left + window.scrollX),
        Math.round(r.top + window.scrollY),
        Math.round(r.width),
        Math.round(r.height),
      ],
    });
  }
  return {
    elements,
    examined: elements.length,
    ...(subjectSelector ? { subjectExamined: subjectSeen } : {}),
  };
}

/**
 * Reads the target's own box and the box of whatever the entry claims it reveals,
 * in document coordinates, so the caller can compute the clip region for the two
 * PNGs BEFORE the pointer lands. Both boxes are read up front on purpose: the
 * standing door exists in the DOM at `opacity: 0` before any hover, so its box is
 * known, and the region can be cut to include it. A payload that does not exist
 * yet (the portalled schedule-grid panel) contributes nothing here and is caught by
 * the visibility diff instead — which is why neither signal is sufficient alone.
 *
 * @param {{targetSelector: string, revealsSelector?: string|null}} opts
 */
export function hoverRegionProbe(opts) {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    };
  };
  // THE TARGET IS ALWAYS `.first()` — the harness hovers the first match, so the
  // region must be cut around that same one. `reveals` is resolved INSIDE the
  // target first: every standing row carries its own `standing-door`, and a
  // document-wide lookup would cut the region around a DIFFERENT row's door than
  // the one being hovered, which is the alias failure (#2616's `landedOn ===
  // wanted`) wearing a smaller hat — a capture that quietly documents something
  // other than what it names. The document fallback is for a payload that is
  // legitimately not a descendant: the schedule grid portals its panel to
  // `<body>`, and before the first hover it does not exist at all.
  const target = document.querySelector(opts.targetSelector);
  const reveals = opts.revealsSelector
    ? (target && target.querySelector(opts.revealsSelector)) ||
      document.querySelector(opts.revealsSelector)
    : null;
  return {
    target: rect(target),
    reveals: rect(reveals),
    targetFound: !!target,
  };
}

/**
 * PURE. The clip passed to `page.screenshot({ clip })`, from the boxes above.
 * Clamped to the page so a target at the right edge cannot produce a clip that
 * Playwright rejects — a thrown screenshot would abort the whole entry and read as
 * "this surface has no hover state".
 *
 * @param {Array<{x:number,y:number,width:number,height:number}|null>} boxes
 * @param {{pad: number, pageWidth: number, pageHeight: number}} opts
 */
export function hoverClip(boxes, opts) {
  const present = boxes.filter(Boolean);
  if (!present.length) return null;
  const left = Math.min(...present.map((b) => b.x)) - opts.pad;
  const top = Math.min(...present.map((b) => b.y)) - opts.pad;
  const right = Math.max(...present.map((b) => b.x + b.width)) + opts.pad;
  const bottom = Math.max(...present.map((b) => b.y + b.height)) + opts.pad;
  const x = Math.max(0, Math.floor(left));
  const y = Math.max(0, Math.floor(top));
  const width = Math.min(Math.ceil(right), opts.pageWidth) - x;
  const height = Math.min(Math.ceil(bottom), opts.pageHeight) - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * PURE. Diffs two snapshots into the rendered difference the hover made.
 *
 * `pixelsChanged` is the caller's byte comparison of the two clipped PNGs, handed
 * in rather than computed here so this stays pure and unit-testable. It is a
 * SEPARATE signal from the visibility diff, not a cross-check of it, and the two
 * disagree in both directions for real reasons: a payload painted outside the clip
 * (the schedule grid's cursor-following panel) changes no pixels inside it, and a
 * hover that only tints a background changes pixels while revealing nothing. The
 * verdict is the OR; the two columns are kept apart in the output so a reader can
 * see which one fired.
 *
 * @param {{elements: Array<object>, examined: number}} before
 * @param {{elements: Array<object>, examined: number}} after
 * @param {{movedEpsilonPx: number, maxElementsPerEntry: number}} opts
 * @param {boolean} pixelsChanged
 */
export function summarizeHover(before, after, opts, pixelsChanged) {
  const byKey = new Map(before.elements.map((e) => [e.key, e]));
  const revealed = [];
  const hidden = [];
  const moved = [];
  for (const a of after.elements) {
    const b = byKey.get(a.key);
    if (a.visible && !(b && b.visible)) {
      revealed.push({ el: a.name, text: a.text });
      continue;
    }
    if (!a.visible && b && b.visible) {
      hidden.push({ el: b.name, text: b.text });
      continue;
    }
    if (a.visible && b && b.visible) {
      const d = Math.max(
        ...a.rect.map((v, i) => Math.abs(v - b.rect[i]))
      );
      if (d > opts.movedEpsilonPx)
        moved.push({ el: a.name, byPx: Math.round(d) });
    }
  }
  // An element present before and gone from the DOM after (React unmounted it) is
  // a hide, and it is only reachable from the `before` side.
  const afterKeys = new Set(after.elements.map((e) => e.key));
  for (const b of before.elements)
    if (b.visible && !afterKeys.has(b.key))
      hidden.push({ el: b.name, text: b.text });

  const cap = opts.maxElementsPerEntry;
  return {
    examined: after.examined,
    pixelsChanged,
    revealedTotal: revealed.length,
    hiddenTotal: hidden.length,
    movedTotal: moved.length,
    revealed: revealed.slice(0, cap),
    hidden: hidden.slice(0, cap),
    moved: moved.slice(0, cap),
    // THE VERDICT, and the reason the shot is taken or skipped. A hover that
    // changes no pixels in its own region, reveals nothing, hides nothing and moves
    // nothing produced a `…-hover.png` byte-identical to the default shot — noise
    // in a ~120-shot contact sheet that a reader cannot tell from the default
    // without opening both. The FACT is still a finding (a ruled hover affordance
    // that stopped doing anything), so it is reported loudly; the picture is not.
    changed:
      pixelsChanged ||
      revealed.length > 0 ||
      hidden.length > 0 ||
      moved.length > 0,
    // Decoration vs information. A hover that only tints a row or slides a box
    // reveals no content a static shot was missing; a reviewer scanning the table
    // should be able to skip it and spend their attention on the rows that carry
    // text nothing else shows.
    revealsInformation: revealed.length > 0,
  };
}

/**
 * The `audit.md` section, so a hover capture LANDS IN THE REVIEW OUTPUT rather
 * than only on disk. A capture nobody looks at closes no blind spot: the census's
 * output is read by a person reviewing surfaces, and a `…-hover.png` sitting in a
 * ~120-shot contact sheet with no table pointing at it is a file, not evidence.
 *
 * This is also HOW A READER TELLS A HOVER SHOT FROM A STATIC ONE. There are three
 * marks and they are deliberately redundant, because a hover shot can differ from
 * its static twin by a dozen pixels and nothing about the picture announces itself:
 *   1. the filename carries `-hover` (the contact sheet prints it as the caption);
 *   2. this table names the shot file, what was hovered, and what appeared;
 *   3. a hover that revealed nothing has NO shot at all, so every `-hover.png` in
 *      the run is a state that provably differs from the default capture.
 *
 * @param {Array<object>} rows
 * @returns {string[]}
 */
export function hoverAuditSections(rows) {
  if (!rows.length) return [];
  const lines = [
    "## Hover captures (#3489 d4) — states a static shot cannot show",
    "",
    "Desktop only: a phone has no hover, so a mobile hover shot would picture a",
    "state no phone user can reach. A row with no shot is a registered hover",
    "ruling that changed nothing this run — a finding, not a missing capture.",
    "",
    "| route | affordance | shot | reveals | hidden | moved | pixels |",
    "|---|---|---|---|---|---|---|",
  ];
  const cell = (list) =>
    !list || !list.length
      ? "—"
      : list
          .map((r) => (r.text ? `${r.el} "${r.text}"` : r.el))
          .join("<br>")
          .replace(/\|/g, "\\|");
  for (const r of rows) {
    if (!r.found) {
      lines.push(
        `| ${r.route} | ${r.label} | **BLIND SPOT** | ${r.why} | — | — | — |`
      );
      continue;
    }
    lines.push(
      `| ${r.route} | ${r.label} | ${r.shot ?? "**none — no-op**"} | ` +
        `${cell(r.revealed)} | ${cell(r.hidden)} | ` +
        `${r.movedTotal ? `${r.movedTotal} el` : "—"} | ` +
        `${r.pixelsChanged ? "changed" : "identical"} |`
    );
  }
  lines.push("");
  return lines;
}

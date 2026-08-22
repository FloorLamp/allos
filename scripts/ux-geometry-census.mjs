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
   * heights". The defects it must clear are much larger — #3481's `input` (40px)
   * beside a `btn-sm` (32px) is 8px, and #3486's icon-only button was 4px short of
   * its labeled siblings.
   */
  controlHeightTolerancePx: 2,
  /**
   * PIXELS OF RENDERED WIDTH past the viewport edge. A box must exit by more than
   * this to be called clipped, so that a border-box rounding to 390.4px on a 390px
   * viewport is not a finding. #3478's select overhangs by tens of pixels.
   */
  clipEpsilonPx: 1,
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
 * @param {{controlHeightTolerancePx: number, clipEpsilonPx: number, maxRowsPerVisit: number}} opts
 */
export function geometryProbe(opts) {
  const { controlHeightTolerancePx, clipEpsilonPx, maxRowsPerVisit } = opts;

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
    };

  // The viewport's CONTENT width — `clientWidth` and not `innerWidth`, because
  // `innerWidth` includes a classic scrollbar and would forgive ~15px of real
  // overhang on a desktop run.
  const viewportWidth = document.documentElement.clientWidth;

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
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
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
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (
        (ox === "auto" || ox === "scroll") &&
        p.scrollWidth > p.clientWidth + 1
      )
        return true;
    }
    return false;
  };

  const clipped = [];
  let clipCandidates = 0;
  for (const el of clipCandidateEls) {
    if (!shown(el)) continue;
    clipCandidates += 1;
    const r = el.getBoundingClientRect();
    const left = docLeft(r);
    const right = left + r.width;
    const overRight = right - viewportWidth;
    const overLeft = -left;
    const overflowPx = Math.round(Math.max(overRight, overLeft, 0));
    if (overflowPx <= clipEpsilonPx) continue;
    if (insideHorizontalScroller(el)) continue;
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
      d === "flex" || d === "inline-flex" || d === "grid" || d === "inline-grid"
    );
  };

  const byContainer = new Map();
  const allControls = [...root.querySelectorAll(CONTROL_SELECTOR)].filter(shown);
  const controlSet = new Set(allControls);
  for (const el of allControls) {
    // A control that CONTAINS another control is a container wearing a control's
    // tag — a card-sized `<a>` wrapping a row of buttons. Comparing its height to
    // the buttons inside it is a category error and would flag every such card.
    if ([...el.querySelectorAll(CONTROL_SELECTOR)].some((c) => controlSet.has(c)))
      continue;
    let owner = null;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
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

  return {
    clipCandidates,
    clippedTotal: clipped.length,
    clipped: clipped.slice(0, maxRowsPerVisit),
    controlRowsExamined,
    heightRowsTotal: heightRows.length,
    heightRows: heightRows.slice(0, maxRowsPerVisit),
  };
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
  for (const r of metricsRows) {
    for (const c of r.clipped ?? [])
      clips.push({ route: r.route, viewport: r.viewport, ...c });
    for (const h of r.heightRows ?? [])
      rows.push({ route: r.route, viewport: r.viewport, ...h });
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
  return lines;
}

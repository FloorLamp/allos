// THE COMMITTED CENSUS CHROME BASELINE (#3390's owner ruling, folded into #3489).
//
// WHY THIS EXISTS. Dozens of issues carry a variant of "the UX census baseline is
// re-annotated where the chrome changed (#1510)", and until this file there was
// nothing in the tree to annotate: `scripts/ux-walkthrough.mjs` writes
// `metrics.json` into a RUN's shots directory and `--baseline <dir>` diffs one run
// against another run. Three separate lanes went looking for a committed baseline,
// found none, and each spent a paragraph saying so (#3390). An acceptance criterion
// nobody can satisfy trains people to skip acceptance criteria, so the owner ruled
// option 2 on 2026-08-22: commit a real one.
//
// So: a small file of rendered chrome geometry, recorded from a real browser at the
// census's own two viewports, that a PR CAN edit alongside a visual change and that
// a reviewer meets as a diff of numbers instead of as a claim in prose.
//
// ── IT MEASURES BOXES, NOT DECLARATIONS ─────────────────────────────────────────
//
// Every number here comes from `getBoundingClientRect()` on a real element in a
// real viewport, for the reason scripts/ux-geometry-census.mjs states at length: a
// computed style measures a DECLARATION and the reader sees a RENDERED result.
// #3466 shipped a stepped 16px seam whose rendered gap stayed 24px because it
// collapsed against an unstepped parent two files away, and the guard meant to
// catch it read the computed value on that exact element and saw 16. A committed
// baseline of class strings would have the same hole.
//
// ── WHAT IS IN IT, AND WHAT IS DELIBERATELY NOT ─────────────────────────────────
//
// CHROME: the shell's own geometry — the top bar's height, the sidebar's width, the
// gutters the content sits inside, the page title's rendered box. Every landmark
// below was chosen because it is SEED-INDEPENDENT: the same number whether the
// profile has three rows or three thousand. That is what makes one committed file
// comparable across the e2e fixture seed, the census's fresh/thin/seeded shapes and
// its personas, and it is why the landmark list is short.
//
// NOT the geometry FINDINGS (`clipped`, `heightRows`). Those are the census's other
// half and they are data-shaped: #3478's off-viewport select needs a long imported
// name to overflow. Committing a finding count would also pin today's OPEN defects
// as expected — #3478, #3481 and /supplies are unfixed right now — so fixing one
// would turn this file red and the fix would arrive with a baseline edit that looks
// exactly like a regression. Findings stay in the run artifact where a human reads
// and ranks them.
//
// NOT a timestamp or a commit sha. Git already records when each number changed and
// who changed it; a provenance field inside the file is one more thing to edit and
// the first thing to go stale.
//
// ── THE REFRESH DISCIPLINE, which is the binding condition on this file ─────────
//
// #3390's ruling: "the baseline ships with a refresh discipline — a stated,
// tooling-enforced way it is regenerated — or it rots into a number people edit to
// make review quiet". That was #3369's lesson, paid for by a query budget that had
// decayed into a cap at twice the real number.
//
// The discipline here has three parts, and the third is the one with teeth:
//
//   1. ONE COMMAND REGENERATES IT: `npm run gen:census-baseline`. It re-measures
//      every surface in a real browser and rewrites this file; you commit the diff.
//   2. THE ENFORCER IS THE RECORDER. e2e/census-chrome-baseline.spec.ts measures
//      and compares in the same run, so the file cannot drift from the thing it
//      describes without a red — and cannot be refreshed by any route that did not
//      measure.
//   3. A HAND EDIT IS DETECTABLE. `serializeBaseline` below is the ONLY writer, and
//      lib/__tests__/census-chrome-baseline.test.ts asserts the committed bytes are
//      exactly what it produces. Retyping a number to make a red go away leaves the
//      file in the tool's own canonical form and is therefore invisible in THAT
//      check — which is the point of the check next to it: the e2e recorder will
//      re-measure and disagree. The canonical-form check catches the other half, an
//      edit that adds, drops or reorders surfaces and landmarks by hand.
//
// ── WHY A `.mjs` MODULE AND NOT `lib/*.ts` ──────────────────────────────────────
//
// Same reason scripts/ux-geometry-census.mjs is one: the census harness runs as
// plain `node scripts/ux-walkthrough.mjs` and cannot import TypeScript, while
// vitest and Playwright can both import this. One spelling of the rule, three
// readers. The alternative is a probe in the harness and a second copy in the
// guard, which is the arrangement that lets a guard go quietly green while the
// thing it guards drifts.

import fs from "node:fs";
import path from "node:path";

/**
 * The committed file, as a REPO-RELATIVE path, resolved by the caller.
 *
 * Not `new URL(..., import.meta.url)`, which is the obvious spelling and does not
 * work here: Playwright transpiles a spec and everything it imports to CommonJS, so
 * an `import.meta` token anywhere in this module is a SyntaxError at parse time —
 * before any branch could avoid it — and the whole spec file fails to collect. The
 * sibling scripts/ux-geometry-census.mjs is importable from all three runtimes for
 * the same reason: it never names one.
 */
export const BASELINE_FILE = "scripts/census-chrome-baseline.json";

/** @param {string} [repoRoot] defaults to the process cwd, which is the repo root under vitest, Playwright and `node scripts/…`. */
export function baselinePath(repoRoot = process.cwd()) {
  return path.join(repoRoot, BASELINE_FILE);
}

/** The command that regenerates the file. Quoted in every failure message. */
export const REFRESH_COMMAND = "npm run gen:census-baseline";

/**
 * THE TWO VIEWPORTS, taken from the census rather than restated.
 *
 * `scripts/ux-walkthrough.mjs` visits every route at 1280x900 and again at 390x844.
 * A baseline recorded at any other width would describe geometry the census never
 * looks at, so the recorder pins these exactly.
 */
export const CENSUS_VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
};

/**
 * THE TOLERANCE, IN PIXELS OF RENDERED DIFFERENCE, and where the number comes from.
 *
 * Stating the unit is the check and not bookkeeping (#3391, where a lane asked to
 * write down what a bound was FOR discovered while writing the sentence that the
 * bound was checked against the wrong quantity and could never fire).
 *
 * This bounds |recorded - measured| for ONE landmark, in CSS pixels of a rendered
 * box, already rounded to whole pixels by the probe. A box can land on either side
 * of a half pixel between two Chromium builds, so 1px absorbs a rounding difference
 * and nothing else.
 *
 * It cannot hide anything this file exists to show: the smallest spacing step in
 * the app's scale is 4px (Tailwind's `1`), the gutters it records move in 4px steps
 * (`p-4` -> `p-5` is 16 -> 20), and the two type scales the page title crosses
 * (`text-xl` -> `text-2xl`) differ by 4px of box height. The tolerance is
 * INCLUSIVE: a delta of exactly 1 is silent, 2 is a drift row.
 */
export const CHROME_TOLERANCE_PX = 1;

/**
 * THE LANDMARKS, named, with what each one is a number OF.
 *
 * The probe measures these and nothing else. Every one is a quantity the shell
 * decides, not one the profile's data decides — see the header. `viewports` records
 * where a landmark is expected to exist at all; it is documentation for a reader of
 * this list, NOT a filter the probe applies. The probe reports what it found and
 * what it did not, and the committed file records that per surface, so a sidebar
 * appearing on a phone is an `unrecorded` drift row rather than a silent shrug.
 */
export const CHROME_LANDMARKS = [
  {
    name: "shellChromeHeight",
    what: "height of the app's top bar (`[data-testid=shell-chrome]`) — a phone landmark: from `md` up the bar collapses to nothing and the rail carries the nav, so it is absent from every desktop surface and an appearance there is an `unrecorded` row",
    viewports: ["mobile"],
  },
  {
    name: "sidebarWidth",
    what: "width of the desktop nav rail — `<main>`'s own previous sibling, so no testid is needed to name it",
    viewports: ["desktop"],
  },
  {
    name: "dockHeight",
    what: "height of the bottom dock (`[data-testid=mobile-dock]`), the phone's primary nav",
    viewports: ["mobile"],
  },
  {
    name: "mainInsetLeft",
    what: "px from the viewport's left content edge to `<main>`'s left edge",
    viewports: ["desktop", "mobile"],
  },
  {
    name: "mainInsetRight",
    what: "px from `<main>`'s right edge to the viewport's right content edge",
    viewports: ["desktop", "mobile"],
  },
  {
    name: "contentGutterLeft",
    what: "px between `<main>`'s left edge and where the content actually starts — the page gutter",
    viewports: ["desktop", "mobile"],
  },
  {
    name: "contentGutterRight",
    what: "px between where the content ends and `<main>`'s right edge",
    viewports: ["desktop", "mobile"],
  },
  {
    name: "contentTopInset",
    what: "px from `<main>`'s top to the first pixel of content — on a phone that spans the top bar too, because the bar renders inside `<main>`",
    viewports: ["desktop", "mobile"],
  },
  {
    name: "contentWidth",
    what: "the reading column's rendered width — the single number a layout change moves most visibly",
    viewports: ["desktop", "mobile"],
  },
  {
    name: "pageTitleHeight",
    what: "rendered box height of the page's first `<h1>` — the type scale the title is drawn at. Absent where a page passes `compactBelowSm` and the phone title is `sr-only` (today `/` and the nutrition hub), which is recorded per surface rather than smoothed over",
    viewports: ["desktop", "mobile"],
  },
];

export const CHROME_LANDMARK_NAMES = CHROME_LANDMARKS.map((l) => l.name);

/**
 * FLOORS ON THE FILE ITSELF, asserted before any verdict is pronounced over it.
 *
 * A baseline comparison is an ABSENCE assertion — "no surface drifted" — and that
 * is the shape that passes hardest when the thing underneath it has gone missing.
 * A file emptied to `[]` compares clean; a file that lost its whole mobile half
 * compares clean on the desktop half that remains. Both floors below are checked by
 * lib/__tests__/census-chrome-baseline.test.ts and again by the e2e recorder.
 *
 * PER VIEWPORT and not only in total, for the reason the temp-dir census states
 * (lib/__tests__/tmp-dir-census.test.ts): a total clears a global floor while one
 * root has silently dropped out. Ten desktop surfaces would carry a floor of 8 on
 * their own while every phone reading had gone.
 */
export const MIN_SURFACES = 8;
export const MIN_SURFACES_PER_VIEWPORT = 4;
/**
 * The landmarks a single surface must produce before its readings mean anything. A
 * probe pointed at a login page, a 404 or a `<main>` that never arrived resolves
 * two or three selectors and reports them cheerfully. Six is every viewport-shared
 * landmark, so this clears only if the shell really rendered.
 */
export const MIN_LANDMARKS_PER_SURFACE = 6;

/** The stable key for a surface. Route and viewport together; neither alone. */
export function surfaceKey(surface) {
  return `${surface.viewport} ${surface.route}`;
}

/**
 * THE IN-PAGE PROBE. Runs inside the browser, under `page.evaluate`, in both the
 * e2e recorder and the census harness.
 *
 * SELF-CONTAINED ON PURPOSE: `page.evaluate` serializes this function's SOURCE into
 * the page, so it may not reference anything in module scope — not even
 * CHROME_LANDMARKS above. What keeps the two lists in step is that the recorder
 * asserts the measured name set equals CHROME_LANDMARK_NAMES exactly, on every
 * surface, in both directions.
 *
 * SCROLL IS PARKED FIRST. Every reading is viewport-relative, the top bar is
 * `sticky` below `md`, and a full-page screenshot immediately before this in the
 * census run leaves the page scrolled. Parking at the top makes the reading a
 * property of the layout instead of a property of when it was taken.
 *
 * `mutations` and `inserts` are GUARD-ONLY affordances that the census never
 * passes: inline style patches and nodes, applied for the duration of ONE
 * measurement and reverted before this returns. An insert names the element it
 * goes BEFORE, so a forged piece of chrome sits where a real one would and the
 * probe has to walk to it rather than be handed a selector for it. They are applied HERE, in the same
 * synchronous turn as the measurement, rather than by a separate `page.evaluate` —
 * measured 2026-08-22 on the sibling geometry probe, a node planted in its own call
 * was gone from the DOM by probe time on 1 run in 5, because a live App Router page
 * re-renders in the window between two calls.
 *
 * @param {{mutations?: Array<{selector: string, style: Record<string,string>}>, inserts?: Array<{html: string, before: string}>}} [opts]
 */
export function chromeProbe(opts) {
  const mutations = (opts && opts.mutations) || [];
  const inserts = (opts && opts.inserts) || [];

  const restore = [];
  for (const m of mutations) {
    for (const el of document.querySelectorAll(m.selector)) {
      for (const [prop, value] of Object.entries(m.style)) {
        restore.push([el, prop, el.style.getPropertyValue(prop)]);
        el.style.setProperty(prop, value);
      }
    }
  }
  const planted = [];
  for (const insert of inserts) {
    const anchor = document.querySelector(insert.before);
    if (!anchor || !anchor.parentElement) continue;
    const holder = document.createElement("div");
    holder.innerHTML = insert.html;
    for (const child of [...holder.children]) {
      anchor.parentElement.insertBefore(child, anchor);
      planted.push(child);
    }
  }

  try {
    return measure();
  } finally {
    for (const el of planted) el.remove();
    for (const [el, prop, value] of restore.reverse()) {
      if (value) el.style.setProperty(prop, value);
      else el.style.removeProperty(prop);
    }
  }

  function measure() {
    window.scrollTo(0, 0);

    // The viewport's CONTENT width — `clientWidth`, never `innerWidth`, which
    // includes a classic scrollbar. Every inset below is measured RELATIVE to this
    // edge for the same reason: a page that grew tall enough to want a scrollbar
    // must not read as a 15px layout change.
    const viewportContentWidth = document.documentElement.clientWidth;

    const one = (selector) => document.querySelector(selector);
    /** Rendered, non-degenerate, and actually painted. */
    const shown = (el) => {
      if (!el || el.getClientRects().length === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const box = (el) => (shown(el) ? el.getBoundingClientRect() : null);
    const px = (n) => Math.round(n);

    /**
     * The element's CONTENT box — where the reader's content actually starts.
     *
     * The gutters in this shell are PADDING (`pl-[max(1rem,env(safe-area-inset-left))]`
     * on the content container), so the container's border box spans `<main>` edge to
     * edge and a border-box reading reports every gutter as 0. The first refresh run
     * did exactly that, on all ten surfaces, and the numbers looked plausible.
     *
     * This is the one place a computed value is read, and it is NOT the #3466 trap the
     * header warns about. That failure was a declared 16px seam rendering at 24 because
     * it collapsed against an unstepped parent two files away — a claim about a
     * DECLARATION reaching an element. `padding` does not collapse, does not inherit,
     * and its resolved value is the used length in pixels; combined with a rendered
     * rect it yields the rendered content box. The outer edge is still a real box, and
     * the forged 40px shift in e2e/census-chrome-baseline.spec.ts comes back through
     * this arithmetic rather than around it.
     */
    const contentBox = (el) => {
      const r = box(el);
      if (!r) return null;
      const cs = getComputedStyle(el);
      const inset = (side) =>
        parseFloat(cs.getPropertyValue(`padding-${side}`)) +
        parseFloat(cs.getPropertyValue(`border-${side}-width`));
      return {
        left: r.left + inset("left"),
        right: r.right - inset("right"),
        top: r.top + inset("top"),
        width: r.width - inset("left") - inset("right"),
      };
    };

    const main = one("main");
    const shell = one('[data-testid="shell-chrome"]');
    const container = one('[data-testid="app-content-container"]');
    const dock = one('[data-testid="mobile-dock"]');
    const title = main ? main.querySelector("h1") : null;
    // STRUCTURAL, not a testid. The desktop rail is `<main>`'s own previous
    // sibling in the shell's flex row; there are five other `<aside>` elements in
    // the tree (a supplements panel, a training detail column, the mobile drawer),
    // so `body aside` would name whichever rendered first. A testid here would
    // have been added because it was easier, which is exactly the bar #3540's
    // ruling set for one.
    const railCandidate = main ? main.previousElementSibling : null;
    const rail =
      railCandidate && railCandidate.tagName === "ASIDE" ? railCandidate : null;

    const mainBox = box(main);
    const shellBox = box(shell);
    const containerBox = contentBox(container);
    const dockBox = box(dock);
    const railBox = box(rail);
    const titleBox = box(title);

    /** @type {Record<string, number>} */
    const landmarks = {};
    /** @param {string} name @param {number|null|false|undefined} value */
    const set = (name, value) => {
      if (value !== null && Number.isFinite(value)) landmarks[name] = px(value);
    };

    set("shellChromeHeight", shellBox && shellBox.height);
    set("sidebarWidth", railBox && railBox.width);
    set("dockHeight", dockBox && dockBox.height);
    set("mainInsetLeft", mainBox && mainBox.left);
    set("mainInsetRight", mainBox && viewportContentWidth - mainBox.right);
    set(
      "contentGutterLeft",
      mainBox && containerBox && containerBox.left - mainBox.left
    );
    set(
      "contentGutterRight",
      mainBox && containerBox && mainBox.right - containerBox.right
    );
    // From `<main>`'s own top, never from the top bar's bottom. The bar renders
    // INSIDE `<main>` and collapses to nothing from `md` up, so anchoring on it
    // would leave every desktop surface without this landmark — and "absent" is
    // the reading that must stay rare enough to mean something.
    set(
      "contentTopInset",
      mainBox && containerBox && containerBox.top - mainBox.top
    );
    set("contentWidth", containerBox && containerBox.width);
    set("pageTitleHeight", titleBox && titleBox.height);

    return {
      landmarks,
      viewportContentWidth,
      // THE TWO ANCHORS EVERY SURFACE MUST HAVE, named separately from the landmark
      // map so a red says WHICH structural element went missing rather than only
      // that nine numbers turned into three. Deliberately just these two: the top
      // bar is absent from every desktop surface by design, and the page title is
      // absent wherever a page hides it below `sm`, so requiring either would make
      // "absent" a routine reading — and a routine absence is one nobody looks at.
      anchors: {
        main: !!mainBox,
        contentContainer: !!containerBox,
      },
    };
  }
}

/**
 * Compare one recorded surface against one measured surface.
 *
 * Returns a row per disagreement, in three kinds — and the two that are NOT a
 * moved number are the ones that matter most, because they are how a comparison
 * stops comparing:
 *
 *   - `moved`      a landmark both sides carry, differing by more than the tolerance
 *   - `missing`    recorded here, and the probe could not measure it at all
 *   - `unrecorded` measured here, and the committed file does not carry it
 *
 * A silent `missing` is the fail-open shape this whole file is written against: the
 * dock stops rendering, its landmark quietly leaves the measured set, and an
 * absence assertion over the remaining landmarks goes green.
 */
export function compareChrome(
  recorded,
  measured,
  tolerancePx = CHROME_TOLERANCE_PX
) {
  /** @type {Array<{landmark: string, kind: "moved"|"missing"|"unrecorded", was: number|null, now: number|null, delta: number|null}>} */
  const rows = [];
  const recordedLandmarks = (recorded && recorded.landmarks) || {};
  const measuredLandmarks = (measured && measured.landmarks) || {};
  for (const [name, was] of Object.entries(recordedLandmarks)) {
    if (!(name in measuredLandmarks)) {
      rows.push({
        landmark: name,
        kind: "missing",
        was,
        now: null,
        delta: null,
      });
      continue;
    }
    const now = measuredLandmarks[name];
    const delta = now - was;
    if (Math.abs(delta) > tolerancePx)
      rows.push({ landmark: name, kind: "moved", was, now, delta });
  }
  for (const [name, now] of Object.entries(measuredLandmarks)) {
    if (!(name in recordedLandmarks))
      rows.push({
        landmark: name,
        kind: "unrecorded",
        was: null,
        now,
        delta: null,
      });
  }
  rows.sort((a, b) => a.landmark.localeCompare(b.landmark));
  return rows;
}

/**
 * THE ONLY WRITER. Canonical, deterministic, byte-stable: surfaces sorted by key,
 * landmarks emitted in CHROME_LANDMARKS order (never in measurement order, which is
 * an implementation detail of the probe), two-space indent so a diff reads as one
 * changed number per line rather than one changed line per surface.
 */
export function serializeBaseline(baseline) {
  const surfaces = [...baseline.surfaces]
    .sort((a, b) => surfaceKey(a).localeCompare(surfaceKey(b)))
    .map((s) => {
      const landmarks = {};
      for (const name of CHROME_LANDMARK_NAMES)
        if (name in s.landmarks) landmarks[name] = s.landmarks[name];
      return { route: s.route, viewport: s.viewport, why: s.why, landmarks };
    });
  return (
    JSON.stringify(
      {
        note: baseline.note ?? BASELINE_NOTE,
        viewports: CENSUS_VIEWPORTS,
        surfaces,
      },
      null,
      2
    ) + "\n"
  );
}

/** The one line a reader of the raw JSON meets before any number. */
export const BASELINE_NOTE =
  `Rendered chrome geometry, in CSS pixels, recorded by e2e/census-chrome-baseline.spec.ts. ` +
  `Regenerate with \`${REFRESH_COMMAND}\` and commit the diff — never hand-edit a number.`;

/** Read the committed file. Throws loudly rather than returning an empty baseline. */
export function readCommittedBaseline(file = baselinePath()) {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.surfaces))
    throw new Error(
      `${path.basename(file)} has no \`surfaces\` array — it is not a chrome baseline. ` +
        `Regenerate with \`${REFRESH_COMMAND}\`.`
    );
  return parsed;
}

/**
 * The census's audit.md section. Pure — no DOM, no filesystem — so the pure tier
 * can prove its shape without booting a browser.
 *
 * It prints even when nothing drifted, and that is deliberate: "no drift" and "the
 * comparison never ran" are the two readings a reader must be able to tell apart,
 * and a section that vanishes when it is happy reads exactly like one that was
 * never wired up. So it always says how many surfaces it compared.
 *
 * @param {Array<{route: string, viewport: string, drift: Array<object>}>} compared
 */
export function chromeBaselineAuditSection(compared) {
  const lines = ["## Committed chrome baseline", ""];
  if (!compared.length) {
    lines.push(
      "No surface in this run matched a surface in `scripts/census-chrome-baseline.json`, so nothing was compared. That is expected on a scoped `UX_ROUTES` run and a blind spot on a full one.",
      ""
    );
    return lines;
  }
  const drifted = compared.filter((c) => c.drift.length);
  lines.push(
    `Compared ${compared.length} surface(s) against the committed baseline (tolerance ${CHROME_TOLERANCE_PX}px). ` +
      (drifted.length
        ? `${drifted.length} drifted.`
        : "None drifted — the shell renders where the committed file says it does."),
    ""
  );
  if (drifted.length) {
    lines.push(
      "| route | viewport | landmark | was | now | delta |",
      "|---|---|---|---|---|---|"
    );
    for (const c of drifted)
      for (const d of c.drift)
        lines.push(
          `| ${c.route} | ${c.viewport} | ${d.landmark} | ${d.was ?? "—"} | ${d.now ?? "—"} | ${
            d.kind === "moved" ? `${d.delta > 0 ? "+" : ""}${d.delta}` : d.kind
          } |`
        );
    lines.push(
      "",
      `If the change in front of you moved the chrome deliberately, run \`${REFRESH_COMMAND}\` and commit the diff — that annotation IS #1510's criterion.`,
      ""
    );
  }
  return lines;
}

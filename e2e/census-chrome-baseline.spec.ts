import fs from "node:fs";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  baselinePath,
  CENSUS_VIEWPORTS,
  CHROME_LANDMARK_NAMES,
  CHROME_TOLERANCE_PX,
  MIN_LANDMARKS_PER_SURFACE,
  MIN_SURFACES,
  MIN_SURFACES_PER_VIEWPORT,
  REFRESH_COMMAND,
  chromeProbe,
  compareChrome,
  readCommittedBaseline,
  serializeBaseline,
  surfaceKey,
} from "../scripts/census-chrome-baseline.mjs";

// THE RECORDER AND THE ENFORCER OF THE COMMITTED CHROME BASELINE (#3390 -> #3489).
//
// One file does both jobs on purpose, and that is the refresh discipline #3390's
// ruling made binding rather than a convenience: the only thing that can write
// scripts/census-chrome-baseline.json is the thing that just measured a real
// browser, so the file cannot be refreshed by any route that did not measure. Run
// it normally and it compares; run `npm run gen:census-baseline` and it rewrites.
//
// ── WHAT IT ASSERTS, AND WHAT IT DOES NOT ───────────────────────────────────────
//
// It does NOT assert the app's chrome is good. It asserts the committed file still
// describes the app — a drift here means "these numbers moved, say whether you
// meant it", which is exactly the annotation #1510's acceptance criterion has been
// asking for and could not have.
//
// ── IT IS AN ABSENCE ASSERTION, SO NOTHING BELOW BELIEVES A CLEAN SWEEP ─────────
//
// "No surface drifted" goes green the instant the probe stops finding surfaces: a
// route that 404s, a renamed testid, a `<main>` that never arrived, a viewport loop
// that stopped looping. Three census runs in this repo shipped fail-open in the
// last week. So, in the order the tmp-dir census (#3248) does it:
//
//   1. A CORPUS FLOOR, per viewport and not only in total, asserted BEFORE any
//      verdict — the total clears while one half has silently dropped out.
//   2. A NAMED SUBJECT per surface, proven visible before a single box is read.
//      Waiting for the container instead of the content is how a race resolves
//      toward the empty DOM, and empty is the state that flatters a comparison.
//   3. SYNTHETIC OFFENDERS, planted in a live DOM and required back by a probe
//      that has to go and FIND them — one per drift kind, including the `missing`
//      kind, which is the one that would otherwise let this file stop measuring
//      without saying so. And their benign twins, required to stay silent: a guard
//      that fires on a 1px difference gets deleted within a week and takes the real
//      guard with it (#3325's lesson).
//
// Fixture (#868 hygiene): READ-ONLY. It navigates, measures, and mutates a DOM that
// is about to be discarded. Nothing is written to a database. In refresh mode it
// writes exactly one file, the committed baseline, and says so loudly.

const REFRESH = !!process.env.CENSUS_BASELINE_REFRESH;

interface Surface {
  route: string;
  /**
   * The key the CENSUS harness files this surface under, when it is not the route
   * itself. The census keys a dynamic route by its pattern, because the instance id
   * changes run to run; recording the mapping here is what stops the census's audit
   * reporting this surface as unreached on every run.
   */
  censusRoute?: string;
  /** What this surface is in the baseline FOR — the shell shape it exercises. */
  why: string;
  /**
   * A control that must be VISIBLE before anything is measured. Each is proven
   * visible at both viewports by an already-merged spec, so a red here is this
   * probe's reach failing rather than the surface being missing.
   */
  subject: string;
}

const SURFACES: Surface[] = [
  {
    route: "/",
    why: "The dashboard — the shell's most-visited surface and the one every nav change lands on.",
    subject: '[data-testid="now-strip"]',
  },
  {
    route: "/wellness",
    why: "A plain index page under the default gutters: the shell with nothing overriding it.",
    subject: '[data-testid="practice-create-trigger"]',
  },
  {
    route: "/nutrition?tab=supplements",
    why: "A tabbed hub panel — the census's HUB_VARIANTS shape, where a tab strip sits between the title and the content.",
    subject: '[data-testid="supplement-add-toggle"]',
  },
  {
    route: "/trends/metric/weight",
    censusRoute: "/trends/metric/[kind]",
    why: "A dynamic detail route — the DYNAMIC_ROUTES shape (#1544), reached by id rather than by path.",
    subject: '[data-testid="metric-measurement-toggle"]',
  },
  {
    // THE RECORD (#3958), which took this slot from the event ledger. Same reason
    // the ledger held it and more of it: page content that is one full-width row
    // list rather than a column of cards, and now with the chrome above the first
    // record as an acceptance criterion in its own right (≤ ~140px at 390px). This
    // file is exactly where a header stack that grew back has to be met as a diff of
    // numbers.
    route: "/history",
    why: "The record — a full-width day-grouped row list under one filter row, with a bounded chrome stack above the first row (#3958).",
    subject: '[data-testid="history-filters"]',
  },
  {
    route: "/settings",
    why: "A settings index — a group list rather than a data page, and the densest column of controls in the app.",
    subject: '[data-testid="settings-index"]',
  },
];

type ProbeResult = Awaited<ReturnType<typeof chromeProbe>>;

async function probe(
  page: Page,
  opts: Parameters<typeof chromeProbe>[0] = {}
): Promise<ProbeResult> {
  return page.evaluate(chromeProbe, opts);
}

async function land(page: Page, surface: Surface): Promise<void> {
  await page.goto(surface.route);
  await expect(page.getByRole("main")).toBeVisible();
  // THE CONTENT, NOT THE CONTAINER. A probe run between the shell and its content
  // measures a page that is still arriving, and every landmark it fails to resolve
  // leaves the measured set quietly.
  await expect(page.locator(surface.subject)).toBeVisible();
}

test.describe("the committed chrome baseline still describes the app (#3390)", () => {
  test("every recorded surface measures what the committed file says", async ({
    page,
  }) => {
    test.slow(); // ten navigations, each compiling its route on first hit

    // Read only when comparing. A refresh run must be able to CREATE the file, and
    // a refresh that first demands a readable copy of what it is replacing cannot
    // recover from the one state where the tooling matters most.
    const committed = REFRESH ? null : readCommittedBaseline();
    const recorded = new Map<string, { landmarks: Record<string, number> }>(
      (committed?.surfaces ?? []).map(
        (s: {
          route: string;
          viewport: string;
          landmarks: Record<string, number>;
        }) => [surfaceKey(s), s]
      )
    );

    const measured: Array<{
      route: string;
      censusRoute?: string;
      viewport: string;
      why: string;
      landmarks: Record<string, number>;
    }> = [];
    const reachFailures: string[] = [];

    for (const [viewport, size] of Object.entries(CENSUS_VIEWPORTS)) {
      await page.setViewportSize(size);
      for (const surface of SURFACES) {
        await land(page, surface);
        const r = await probe(page);

        // KEEP THIS, reviewer. It is the whole reading, printed on every run, and
        // it is how the next person re-derives a number without guessing which of
        // ten landmarks moved. A committed file whose measurements appear nowhere
        // in a log is indistinguishable from a file of guesses.
        console.log(
          `[#3390 chrome baseline] ${viewport} ${surface.route} ` +
            `(vw ${r.viewportContentWidth}): ` +
            Object.entries(r.landmarks)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")
        );

        // THE ANCHORS, before the numbers. A surface that resolved no `<main>` or
        // no content container produced landmarks about something else, and the
        // count floor below would not necessarily notice.
        for (const [name, present] of Object.entries(r.anchors))
          if (!present)
            reachFailures.push(
              `${viewport} ${surface.route}: the structural anchor \`${name}\` was not on the page. ` +
                `Its landmarks describe a different document — ${surface.why}`
            );

        const count = Object.keys(r.landmarks).length;
        if (count < MIN_LANDMARKS_PER_SURFACE)
          reachFailures.push(
            `${viewport} ${surface.route}: the probe measured only ${count} landmarks, ` +
              `under the per-surface floor of ${MIN_LANDMARKS_PER_SURFACE}. It is not looking at ` +
              `a rendered shell — ${surface.why}`
          );

        // Landmark names come FROM the rule module, so a landmark added there and
        // never measured, or measured and never declared, is a red rather than a
        // column that quietly stops existing.
        for (const name of Object.keys(r.landmarks))
          if (!CHROME_LANDMARK_NAMES.includes(name))
            reachFailures.push(
              `${viewport} ${surface.route}: the probe returned \`${name}\`, which CHROME_LANDMARKS does not declare.`
            );

        measured.push({
          route: surface.route,
          censusRoute: surface.censusRoute,
          viewport,
          why: surface.why,
          landmarks: r.landmarks,
        });
      }
    }

    // ── THE CORPUS FLOOR, BEFORE ANY VERDICT ─────────────────────────────────────
    expect(
      reachFailures.join("\n"),
      "The probe could not reach a surface it is about to pronounce unchanged."
    ).toBe("");
    expect(
      measured.length,
      `Only ${measured.length} surfaces were measured, under the floor of ${MIN_SURFACES}. ` +
        "The viewport loop or the surface list has collapsed, and a comparison over " +
        "what is left would report clean for the wrong reason."
    ).toBeGreaterThanOrEqual(MIN_SURFACES);
    // Per viewport, because the total clears while one half has silently gone.
    for (const viewport of Object.keys(CENSUS_VIEWPORTS)) {
      expect(
        measured.filter((m) => m.viewport === viewport).length,
        `No ${viewport} surfaces were measured at all. Half this baseline is about ` +
          "geometry nobody looked at on this run."
      ).toBeGreaterThanOrEqual(MIN_SURFACES_PER_VIEWPORT);
    }

    const refreshed = serializeBaseline({ surfaces: measured });

    if (REFRESH) {
      const target = baselinePath();
      fs.writeFileSync(target, refreshed, "utf8");
      console.log(
        `[#3390 chrome baseline] REFRESHED ${target} from ${measured.length} measured surfaces. ` +
          "Commit the diff — that diff IS #1510's annotation."
      );
      return;
    }

    // Every measured surface must be IN the committed file, and every committed
    // surface must have been measured. Either direction going unsaid is how a
    // baseline shrinks to the routes that still pass.
    const measuredKeys = new Set(measured.map((m) => surfaceKey(m)));
    const unrecordedSurfaces = [...measuredKeys].filter(
      (k) => !recorded.has(k)
    );
    const unmeasuredSurfaces = [...recorded.keys()].filter(
      (k) => !measuredKeys.has(k)
    );
    expect(
      { unrecordedSurfaces, unmeasuredSurfaces },
      `The committed baseline and this spec's SURFACES list disagree about which surfaces exist. ` +
        `Run \`${REFRESH_COMMAND}\` and commit the diff.`
    ).toEqual({ unrecordedSurfaces: [], unmeasuredSurfaces: [] });

    const drifted: string[] = [];
    for (const m of measured) {
      const rows = compareChrome(recorded.get(surfaceKey(m)), m);
      for (const d of rows)
        drifted.push(
          d.kind === "moved"
            ? `${surfaceKey(m)} ${d.landmark}: ${d.was} -> ${d.now} (${(d.delta ?? 0) > 0 ? "+" : ""}${d.delta}px)`
            : d.kind === "missing"
              ? `${surfaceKey(m)} ${d.landmark}: recorded as ${d.was} and NOT MEASURABLE now — the element it names is gone from this page`
              : `${surfaceKey(m)} ${d.landmark}: measured ${d.now} and absent from the committed file`
        );
    }

    expect(
      drifted.join("\n"),
      "The app's chrome no longer matches the committed baseline (tolerance " +
        `${CHROME_TOLERANCE_PX}px). If you moved it on purpose, run \`${REFRESH_COMMAND}\` ` +
        "and commit the diff — that diff is the census annotation #1510 asks for, and it is " +
        "what makes the change visible in review. If you did not, something moved the shell " +
        "under you.\n\nThe refreshed file would be:\n\n" +
        refreshed
    ).toBe("");
  });
});

// ── THE FORGERIES ───────────────────────────────────────────────────────────────
//
// Given in PIXELS, never in class names. This is a test of the probe, and borrowing
// the app's own spacing utilities would make it fail the day somebody changes them
// for an unrelated reason — and would put a DECLARATION back in the middle of a
// measurement.
//
// They are handed to the probe rather than applied by a separate `page.evaluate`,
// for the reason recorded on the sibling geometry probe: on a live App Router page
// a re-render between the two calls removed the plant on 1 run in 5. Planting
// inside the measurement makes them one synchronous turn.
test.describe("the chrome probe can see a shell that moved", () => {
  const CONTAINER = '[data-testid="app-content-container"]';

  test("catches a 40px gutter shift, and stays quiet on a 1px one", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize(CENSUS_VIEWPORTS.mobile);
    await land(page, SURFACES[1]);

    const clean = await probe(page);
    expect(
      Object.keys(clean.landmarks).length,
      "the probe measured nothing on a page whose subject is on screen"
    ).toBeGreaterThanOrEqual(MIN_LANDMARKS_PER_SURFACE);

    // ── THE BENIGN TWIN, ON ITS OWN FIRST ──────────────────────────────────────
    // Measured alone so a probe that flags it cannot hide inside the offender's
    // own delta. Exactly AT the tolerance, which is where an inclusive bound has
    // to be pinned or the sentence "1px is silent" is untested.
    const benign = await probe(page, {
      mutations: [{ selector: CONTAINER, style: { "margin-left": "1px" } }],
    });
    expect(
      compareChrome(clean, benign),
      "the probe called a 1px shift a drift — every rounding difference between two " +
        "Chromium builds would then be a red, and this baseline would be refreshed " +
        "until it meant nothing"
    ).toEqual([]);

    // ── THE OFFENDER ───────────────────────────────────────────────────────────
    const shifted = await probe(page, {
      mutations: [{ selector: CONTAINER, style: { "margin-left": "40px" } }],
    });
    const rows = compareChrome(clean, shifted);
    const gutter = rows.find((r) => r.landmark === "contentGutterLeft");
    expect(
      gutter,
      "the probe did not see the content container pushed 40px right of `<main>` — " +
        "it is measuring the wrong pair of boxes, and the gutter this baseline " +
        "exists to pin is not being read at all"
    ).toBeDefined();
    expect(gutter?.kind).toBe("moved");
    expect(gutter?.delta).toBe(40);
    // The reading column narrows by the same 40px, which is the half a reader
    // actually sees. Both landmarks moving is what makes the drift table legible.
    const width = rows.find((r) => r.landmark === "contentWidth");
    expect(width?.delta).toBe(-40);
  });

  test("calls a landmark that stopped rendering MISSING rather than passing over it", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize(CENSUS_VIEWPORTS.mobile);
    await land(page, SURFACES[1]);

    const clean = await probe(page);
    expect(
      clean.landmarks.dockHeight,
      "the phone dock was not measured on a phone viewport, so the forgery below " +
        "would prove nothing"
    ).toBeGreaterThan(0);

    // The fail-open shape this whole file is written against: an element stops
    // rendering, its landmark quietly leaves the measured set, and an absence
    // assertion over what remains goes green.
    const hidden = await probe(page, {
      mutations: [
        { selector: '[data-testid="mobile-dock"]', style: { display: "none" } },
      ],
    });
    const rows = compareChrome(clean, hidden);
    expect(
      rows.map((r) => [r.landmark, r.kind]),
      "the dock stopped rendering and the comparison said nothing. A landmark that " +
        "can disappear silently is a landmark this baseline is not actually watching."
    ).toEqual([["dockHeight", "missing"]]);
  });

  test("calls a landmark that appeared where none was recorded UNRECORDED", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize(CENSUS_VIEWPORTS.mobile);
    await land(page, SURFACES[1]);

    const clean = await probe(page);
    expect(clean.landmarks.sidebarWidth).toBeUndefined();

    // A desktop rail rendered on a phone is a real defect shape, and it is the one
    // direction a "compare what we recorded" loop misses by construction.
    const withRail = await probe(page, {
      inserts: [
        {
          html: '<aside data-testid="forged-rail" style="position:fixed;top:0;left:0;width:99px;height:200px">rail</aside>',
          before: "main",
        },
      ],
    });
    // The forgery is placed where a REAL rail lives — immediately before <main> in
    // the shell's row — and nothing tells the probe its testid. It comes back only
    // if the probe walks from <main> to its own previous sibling and recognises an
    // <aside> there, which is the rule the desktop rail is actually found by.
    // `position: fixed` keeps it out of flow, so the only thing it can move is the
    // reading this test is about.
    const rows = compareChrome(clean, withRail);
    expect(
      rows.map((r) => [r.landmark, r.kind]),
      "a rail rendered beside <main> on a phone produced no row at all — the " +
        "comparison only ever looks at landmarks the file already carries, so a NEW " +
        "piece of chrome could appear on every page and this baseline would stay green"
    ).toEqual([["sidebarWidth", "unrecorded"]]);
    expect(rows[0]?.now).toBe(99);
  });
});

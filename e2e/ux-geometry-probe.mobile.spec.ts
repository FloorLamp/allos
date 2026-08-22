import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  GEOMETRY_THRESHOLDS,
  geometryProbe,
} from "../scripts/ux-geometry-census.mjs";

// THE GUARD FOR THE UX CENSUS'S GEOMETRY PROBES (#3489, deliverable 1).
//
// The probe itself is a seeing tool: it MEASURES and never asserts, and its output
// is two ranked tables in the census run's audit.md that a person reads. Making it
// a CI gate is explicitly out of scope in #3489, and it could not be one anyway —
// the defects it exists to find (#3478's off-viewport select, #3481's two-height
// row) are OPEN on main right now, so a spec demanding zero findings would be red
// on arrival and would get its routes trimmed until it was green, which is how a
// census loses its coverage.
//
// What this file asserts instead is that THE PROBE CAN SEE, which is the half a
// seeing tool cannot check for itself. Three ways, and none of them is an assertion
// about the app's own quality:
//
//   1. A CENSUS FLOOR per surface — how many rendered boxes and how many multi-
//      control rows the probe actually measured. A probe pointed at a shell, a
//      404, or a `<main>` that never arrived comes in an order of magnitude under.
//   2. A NAMED SUBJECT per surface — a specific control that must be among the
//      boxes measured. A count says "something was here"; the subject says "the
//      thing you are making a claim about was here". Each subject below is a
//      control an already-merged spec proves is visible at this exact viewport
//      (e2e/button-height-floor.mobile.spec.ts), so a red here is the probe's
//      reach failing, not the surface being missing.
//   3. SYNTHETIC OFFENDERS of both classes, planted in a live DOM and required
//      back — AND their benign neighbours, planted the same way and required to
//      stay silent. Both halves are the guard. A probe that flags the wide table
//      inside every designed horizontal scroller, or every row where a 40px button
//      sits beside a 41px one, gets deleted within a week and takes the real probe
//      with it (#3325's lesson, where a census had to prove its silence on five
//      shipped `ORDER BY … COLLATE NOCASE` sorts).
//
// EVERY READING IS A RENDERED BOX. A computed-style check measures a DECLARATION;
// the user sees a RENDERED result, and #3466 shipped a 16px seam that rendered at
// 24px with a computed-style guard reading 16 on the very element. So the forged
// offenders below are given HEIGHTS AND POSITIONS, never class names, and what
// comes back is compared as pixels.
//
// Fixture (#868 hygiene): READ-ONLY. Nothing is written; every forgery is a DOM
// node appended to a page that is about to be discarded, never a database row.

const PHONE = { width: 390, height: 844 };

// The probe's real per-visit cap is 12 rows, which is a readability budget for
// metrics.json and not part of the rule. The plant-and-catch tests widen it so a
// forged offender cannot be ranked out of the returned list by a page that already
// has more findings than the cap — the cap's own behaviour is covered purely in
// lib/__tests__/ux-geometry-census.test.ts.
const UNCAPPED = { ...GEOMETRY_THRESHOLDS, maxRowsPerVisit: 500 };

interface Surface {
  path: string;
  /** What this surface is in the guard FOR. */
  why: string;
  /** (2) A control that must be among the boxes the probe measured. */
  subject: string;
  /**
   * (1) Floors on what the probe measured, set from a measured run and rounded
   * DOWN hard. They separate "this page rendered" from "this page did not" — they
   * are NOT layout pins, and the difference matters: /trends/metric/weight measured
   * 140 boxes on one run and 135 on the next, and 4 multi-control rows then 2, so a
   * floor anywhere near a measurement is a flake waiting to happen. Each floor
   * below carries the readings it was cut from.
   */
  minClipCandidates: number;
  minControlRows: number;
}

const SURFACES: Surface[] = [
  {
    path: "/wellness",
    why: "The practices page: the surface whose icon-only add button was #3486's 4px-short control.",
    subject: '[data-testid="practice-create-trigger"]',
    // measured 168, 168
    minClipCandidates: 80,
    // measured 2, 2. This surface is genuinely sparse in rows holding two
    // controls, so its floor can only say "at least one comparison happened
    // here"; the claim that the height probe has real material to work on rests
    // on /nutrition?tab=supplements below, which is why that one is in the list.
    minControlRows: 1,
  },
  {
    path: "/nutrition?tab=supplements",
    why: "A tabbed hub panel — the census's HUB_VARIANTS shape, dense with controls in rows.",
    subject: '[data-testid="supplement-add-toggle"]',
    // measured 227, 227
    minClipCandidates: 110,
    // measured 20, 20
    minControlRows: 8,
  },
  {
    path: "/trends/metric/weight",
    why: "A dynamic detail route — the DYNAMIC_ROUTES shape, where density concentrates (#1544).",
    subject: '[data-testid="metric-measurement-toggle"]',
    // measured 140, 135
    minClipCandidates: 70,
    // measured 4, 2 — the spread is why this floor is 1 and not 2
    minControlRows: 1,
  },
];

// The option shape comes FROM the probe rather than being restated here, so a
// threshold added to the rule cannot be silently absent from the guard's calls.
type ProbeOptions = Parameters<typeof geometryProbe>[0];

async function runProbe(page: Page, opts: ProbeOptions) {
  return page.evaluate(geometryProbe, opts);
}

test.describe("the census geometry probe measures what it claims to (#3489)", () => {
  test.use({ viewport: PHONE });

  for (const surface of SURFACES) {
    test(`reaches ${surface.path}`, async ({ page }) => {
      test.slow(); // next start compiles each route on its first hit
      await page.goto(surface.path);
      await expect(page.getByRole("main")).toBeVisible();
      // WAIT FOR THE CONTENT, NOT THE CONTAINER. A probe run between the shell and
      // its controls measures an empty page and reports a small number that looks
      // like a small page — and a floor is exactly the assertion that direction
      // defeats. So the named subject is proven on screen before anything is read.
      await expect(page.locator(surface.subject)).toBeVisible();

      const r = await runProbe(page, {
        ...GEOMETRY_THRESHOLDS,
        subjectSelector: surface.subject,
      });

      // KEEP THIS, reviewer. It is how the floors below were derived and how the
      // next person re-derives them, and it is what makes a red here say WHICH of
      // the two numbers collapsed instead of only that one did. A floor whose
      // measurement is not printed anywhere is indistinguishable from a guess.
      console.log(
        `[#3489 geometry probe] ${surface.path} @${PHONE.width}px: ` +
          `${r.clipCandidates} boxes, ${r.controlRowsExamined} multi-control rows, ` +
          `${r.clippedTotal} clipped, ${r.heightRowsTotal} mixed-height rows`
      );

      expect(
        r.clipCandidates,
        `${surface.path}: the probe measured only ${r.clipCandidates} rendered boxes ` +
          `inside <main>, under the floor of ${surface.minClipCandidates}. It is not ` +
          `looking at this page — ${surface.why}`
      ).toBeGreaterThanOrEqual(surface.minClipCandidates);

      expect(
        r.controlRowsExamined,
        `${surface.path}: the probe found only ${r.controlRowsExamined} rendered rows ` +
          `holding two or more controls, under the floor of ${surface.minControlRows}. ` +
          `The height probe had almost nothing to compare — ${surface.why}`
      ).toBeGreaterThanOrEqual(surface.minControlRows);

      expect(
        r.subjectExamined,
        `${surface.path}: \`${surface.subject}\` is on screen but was NOT among the ` +
          `boxes the probe measured. The candidate set or the <main> scope no longer ` +
          `reaches it, so this surface's numbers are about something else.`
      ).toBe(true);
    });
  }

  // ── THE FORGERIES ─────────────────────────────────────────────────────────────
  //
  // Given in PIXELS, never in class names. This is a test of the probe, and
  // borrowing the app's own `input` / `btn btn-sm` utilities would make it fail the
  // day somebody changes them for an unrelated reason — and would put a DECLARATION
  // back in the middle of a measurement.
  //
  // They are handed to the probe rather than planted by a separate `page.evaluate`,
  // and that is a fix rather than a convenience: measured 2026-08-22, a node planted
  // in a separate call was gone from `<main>` by probe time on 1 run in 5 of
  // /wellness (`connected: false`, while every surviving run read an identical
  // rect). Planting inside the measurement makes the two one synchronous turn, so
  // there is no window for a re-render to land in. See `forgeries` in
  // scripts/ux-geometry-census.mjs.

  // #3478's shape: a control whose right edge is past the viewport with nothing
  // that scrolls to it. 160px wide, starting 40px before the edge → 120px of it is
  // unreachable.
  const CLIPPED_CONTROL =
    '<button data-testid="forged-clipped-control" ' +
    'style="position:fixed;top:120px;left:calc(100vw - 40px);width:160px;height:40px">' +
    "off the edge</button>";

  // The benign twin: a link parked 820px into a 200px-wide `overflow-x:auto`
  // scroller. Its box is far outside a 390px viewport and the user reaches it by
  // swiping, which is the layout working — a wide table in its wrapper is the
  // commonest shape in this app.
  const REACHABLE_CONTROL =
    '<div data-testid="forged-benign-scroller" style="overflow-x:auto;width:200px">' +
    '<div style="width:900px;display:flex;justify-content:flex-end">' +
    '<a href="#" data-testid="forged-reachable-link" style="width:80px">reachable</a>' +
    "</div></div>";

  // #3481's shape: one `items-end` row, a 40px control beside a 32px one.
  const MIXED_ROW =
    '<div data-testid="forged-mixed-row" style="display:flex;align-items:flex-end;gap:8px">' +
    '<select style="height:40px"><option>x</option></select>' +
    '<button style="height:32px">Add this bottle</button></div>';

  // Its benign twin: 40px beside 41px. Sub-pixel layout and a 1px border are not
  // what anybody means by "one row, two control heights", and a probe that says
  // they are is noise a reader learns to skip past — including past the real rows.
  const EVEN_ROW =
    '<div data-testid="forged-even-row" style="display:flex;align-items:flex-end;gap:8px">' +
    '<button style="height:40px">a</button>' +
    '<button style="height:41px">b</button></div>';

  test("catches a control forged off the right edge, and stays quiet on one a scroller can reach", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/wellness");
    await expect(page.getByTestId("practice-create-trigger")).toBeVisible();

    const clean = await runProbe(page, UNCAPPED);
    expect(clean.clipCandidates).toBeGreaterThan(0);

    // ── THE BENIGN NEIGHBOUR, ON ITS OWN FIRST ─────────────────────────────────
    // Measured alone, so a probe that flags it cannot hide inside the offender's
    // own delta.
    const benign = await runProbe(page, {
      ...UNCAPPED,
      forgeries: [REACHABLE_CONTROL],
    });
    expect(
      benign.clipped.filter((c) => c.el.includes("forged-reachable-link")),
      "the probe flagged a control that a designed horizontal scroller reaches — " +
        "a probe that cries wolf on every wide table gets deleted"
    ).toEqual([]);
    expect(benign.clippedTotal).toBe(clean.clippedTotal);
    // …and it was genuinely measured rather than skipped for some other reason,
    // which is the difference between "not an offender" and "never looked at".
    expect(benign.clipCandidates).toBeGreaterThan(clean.clipCandidates);

    // ── THE OFFENDER, BESIDE IT ────────────────────────────────────────────────
    const dirty = await runProbe(page, {
      ...UNCAPPED,
      forgeries: [REACHABLE_CONTROL, CLIPPED_CONTROL],
    });
    const caught = dirty.clipped.filter((c) =>
      c.el.includes("forged-clipped-control")
    );
    expect(
      caught,
      "the probe did not see a control planted 120px past the right edge of the " +
        "viewport — it is reading the wrong root, or the candidate set stopped " +
        "including buttons"
    ).toHaveLength(1);
    expect(caught[0].side).toBe("right");
    expect(caught[0].overflowPx).toBe(120);
    // Partially visible — the edge is cut off, which is exactly #3478's shape and
    // reads differently from a box parked entirely off-screen.
    expect(caught[0].visiblePart).toBe("partial");
    // Exactly one new finding: the offender, and not the scroller beside it.
    expect(dirty.clippedTotal).toBe(clean.clippedTotal + 1);
  });

  test("catches two control heights in one forged row, and stays quiet on a 1px difference", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/wellness");
    await expect(page.getByTestId("practice-create-trigger")).toBeVisible();

    const clean = await runProbe(page, UNCAPPED);
    expect(clean.controlRowsExamined).toBeGreaterThan(0);

    const benign = await runProbe(page, { ...UNCAPPED, forgeries: [EVEN_ROW] });
    expect(
      benign.heightRows.filter((h) => h.row.includes("forged-even-row")),
      "the probe flagged a 1px difference as two control heights"
    ).toEqual([]);
    expect(benign.heightRowsTotal).toBe(clean.heightRowsTotal);
    expect(benign.controlRowsExamined).toBe(clean.controlRowsExamined + 1);

    const dirty = await runProbe(page, {
      ...UNCAPPED,
      forgeries: [EVEN_ROW, MIXED_ROW],
    });
    const caught = dirty.heightRows.filter((h) =>
      h.row.includes("forged-mixed-row")
    );
    expect(
      caught,
      "the probe did not see a 40px control beside a 32px one in a single flex row"
    ).toHaveLength(1);
    expect(caught[0].spread).toBe(8);
    expect(caught[0].controls.join(" ")).toContain("40px");
    expect(caught[0].controls.join(" ")).toContain("32px");
    expect(dirty.heightRowsTotal).toBe(clean.heightRowsTotal + 1);
  });
});

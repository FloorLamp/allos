import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GEOMETRY_THRESHOLDS,
  geometryAuditSections,
} from "../../scripts/ux-geometry-census.mjs";

// The PURE half of the #3489 geometry probe's guard.
//
// The probe itself measures rendered boxes and can only be exercised in a real
// browser — e2e/ux-geometry-probe.mobile.spec.ts plants offenders of both classes
// in a live DOM and requires them back, and requires the probe's silence on the
// benign neighbours. jsdom cannot host that test: `getBoundingClientRect()` returns
// zeros there, so every element would read as un-rendered and the whole suite would
// be green by measuring nothing — the exact fail-open shape this issue exists to
// close.
//
// What IS pure is everything downstream of the measurement: the thresholds, the
// ranking, and the truncation notice. Those are what turn a probe's output into the
// audit.md tables the acceptance criteria name, and they are worth a fast test
// because a ranking that silently sorts the wrong way hides the worst offender in
// the middle of a list nobody reads to the end of.

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..", "..");

describe("geometry census thresholds", () => {
  // THE NUMBERS ARE PINNED HERE, not because they are sacred, but because the
  // harness and the guard must be talking about the same tolerance. #3489 names
  // 2px; #3481's defect MEASURED 6px when it was fixed (2026-08-23 — this comment
  // used to say 8px, taken from the issue's prose rather than a reading) and
  // #3486's was 4px, so both clear the floor with room — which is what a threshold
  // has to be able to say about itself.
  it("tolerates sub-pixel noise and nothing the review actually found", () => {
    expect(GEOMETRY_THRESHOLDS.controlHeightTolerancePx).toBe(2);
    expect(GEOMETRY_THRESHOLDS.clipEpsilonPx).toBe(1);
    expect(GEOMETRY_THRESHOLDS.controlHeightTolerancePx).toBeLessThan(4);
    // #3814: the collision tolerance absorbs sub-pixel rounding and a shared
    // border, and nothing more. Data -> Trash's correctly stacked pair clears it by
    // a 4px GAP rather than by the tolerance, so the number is not what decides it.
    expect(GEOMETRY_THRESHOLDS.overlapEpsilonPx).toBe(1);
  });
});

describe("geometryAuditSections", () => {
  const rows = [
    {
      route: "/history?kind=dose",
      viewport: "mobile",
      clipCandidates: 210,
      clippedTotal: 1,
      clipped: [
        {
          el: 'select[data-testid="dose-ledger-item"] (select of 46 options)',
          side: "right",
          overflowPx: 84,
          visiblePart: "partial",
          width: 402,
          viewportWidth: 390,
        },
      ],
      controlRowsExamined: 12,
      heightRowsTotal: 0,
      heightRows: [],
      textBoxesExamined: 40,
      overlapsTotal: 0,
      overlaps: [],
    },
    // FABRICATED INPUT, not a recording. These rows exist to exercise the RENDERER
    // — the thresholds, the ranking, the truncation notice — so they stay exactly as
    // they are now that #3481 is fixed and /supplies produces this finding no more.
    // A table that can only be tested against live findings can only be tested while
    // the app is broken.
    {
      route: "/supplies",
      viewport: "mobile",
      clipCandidates: 180,
      clippedTotal: 0,
      clipped: [],
      controlRowsExamined: 9,
      heightRowsTotal: 1,
      heightRows: [
        {
          row: 'form[data-testid="shared-supply-add-for"]',
          spread: 8,
          controls: ["select 40px", 'button "Add this bottle" 32px'],
        },
      ],
      textBoxesExamined: 60,
      // FABRICATED like the row above it, and for the same reason: the renderer has
      // to be testable on a tree where nothing is broken. This is the shape #3716
      // would have had to produce to be believable — two rects, not one string.
      overlapsTotal: 1,
      overlaps: [
        {
          container: 'div[data-testid="data-trash"]',
          a: 'h2 "Recently deleted"',
          b: 'p "Deleted rows are kept here for 30 days"',
          overlapX: 358,
          overlapY: 18,
          aRect: [16, 128, 374, 152],
          bRect: [16, 134, 374, 276],
        },
      ],
    },
    {
      route: "/trends",
      viewport: "desktop",
      clipCandidates: 300,
      clippedTotal: 0,
      clipped: [],
      controlRowsExamined: 20,
      heightRowsTotal: 0,
      heightRows: [],
    },
  ];

  it("renders one ranked table per class, naming the element it found", () => {
    const md = geometryAuditSections(rows).join("\n");
    expect(md).toContain("## Clipped elements");
    expect(md).toContain("dose-ledger-item");
    expect(md).toContain("84 (right)");
    expect(md).toContain("## Mixed control heights in one rendered row (>2px)");
    expect(md).toContain("shared-supply-add-for");
    // #3814: the collision table's evidence is the two RECTS. A row that named only
    // the concatenated text would be the finding this class was filed against.
    expect(md).toContain("## Colliding text");
    expect(md).toContain("16, 128, 374, 152");
    expect(md).toContain("358/18");
    // Both viewports reach the tables: a control can run off a 1280px desktop too,
    // and the pre-existing audit.md rankings are mobile-only.
    expect(geometryAuditSections([...rows, ...rows]).join("\n")).toContain(
      "/supplies"
    );
  });

  it("ranks by the size of the offence, worst first", () => {
    const many = [
      {
        ...rows[0],
        route: "/small",
        clipped: [{ ...rows[0].clipped[0], overflowPx: 3 }],
      },
      {
        ...rows[0],
        route: "/huge",
        clipped: [{ ...rows[0].clipped[0], overflowPx: 300 }],
      },
      {
        ...rows[0],
        route: "/mid",
        clipped: [{ ...rows[0].clipped[0], overflowPx: 40 }],
      },
    ];
    const body = geometryAuditSections(many).filter((l) => l.startsWith("| /"));
    expect(body.map((l) => l.split(" | ")[0])).toEqual([
      "| /huge",
      "| /mid",
      "| /small",
    ]);
  });

  it("says so when a per-visit list was truncated, rather than truncating silently", () => {
    const truncated = [
      { ...rows[0], clippedTotal: 40, clipped: rows[0].clipped },
    ];
    expect(geometryAuditSections(truncated).join("\n")).toContain(
      "Truncated per-visit lists: /history?kind=dose (mobile) 40"
    );
  });

  it("emits nothing at all when a run found none of the three classes", () => {
    expect(geometryAuditSections([rows[2]])).toEqual([]);
  });

  it("never emits a collision row from concatenated text alone (#3814)", () => {
    // THE CONVERSE OF THE TABLE ABOVE, and the one that matters: a visit whose
    // probe found the two boxes stacked reports NOTHING, however the strings read
    // when `textContent` runs them together. This is the exact input #3716 was
    // filed from, minus the geometry it never had.
    const stacked = [
      {
        ...rows[2],
        route: "/data?section=trash",
        textBoxesExamined: 10,
        overlapsTotal: 0,
        overlaps: [],
      },
    ];
    expect(geometryAuditSections(stacked)).toEqual([]);
  });
});

describe("the harness reads the shared rule rather than a second copy of it", () => {
  // The whole reason the rule is a module (#3489, and the same reason
  // lib/machine-date-census.ts is one) is that a probe in the harness plus a
  // separate copy in the guard is the arrangement where one drifts and the other
  // stays green. So: the harness imports it, and does not re-spell the thresholds.
  //
  // COMMENTS ARE BLANKED FIRST. A source scan reads prose as code — an e2e-hygiene
  // census once counted a `.first()` written in an English sentence — and this file
  // is one where the numbers appear in prose on purpose.
  const codeOf = (...rel: string[]) =>
    fs
      .readFileSync(path.join(REPO, ...rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const harness = codeOf("scripts", "ux-walkthrough.mjs");

  it("imports the probe and its thresholds", () => {
    expect(harness).toMatch(/from "\.\/ux-geometry-census\.mjs"/);
    expect(harness).toContain("geometryProbe");
    expect(harness).toContain("GEOMETRY_THRESHOLDS");
    expect(harness).toContain("geometryAuditSections");
  });

  it("writes no threshold of its own", () => {
    expect(harness).not.toMatch(/controlHeightTolerancePx\s*[:=]\s*\d/);
    expect(harness).not.toMatch(/clipEpsilonPx\s*[:=]\s*\d/);
    expect(harness).not.toMatch(/overlapEpsilonPx\s*[:=]\s*\d/);
  });

  it("the e2e guard runs the probe rather than re-spelling its rules (#3814)", () => {
    // #3814 asks whether the sweep and the e2e probe SHARE the `.truncate`
    // exemption (`insideEllipsisTruncation`) or each carry their own reach — two
    // instruments answering one question is how they drift apart. They share it,
    // and this is the checkable form of that: the guard imports `geometryProbe` and
    // hands it to `page.evaluate`, so the exemption it exercises is the one the
    // census runs, character for character. What would break that is the guard
    // growing a computed-style read of the mechanism or a threshold of its own.
    const guard = codeOf("e2e", "ux-geometry-probe.mobile.spec.ts");
    expect(guard).toMatch(/from "\.\.\/scripts\/ux-geometry-census\.mjs"/);
    expect(guard).toContain("geometryProbe");
    expect(guard).not.toContain("textOverflow");
    expect(guard).not.toMatch(/clipEpsilonPx\s*[:=]\s*\d/);
    expect(guard).not.toMatch(/overlapEpsilonPx\s*[:=]\s*\d/);
    expect(guard).not.toMatch(/controlHeightTolerancePx\s*[:=]\s*\d/);
  });

  it("derives the ellipsis exemption from paintedRect (#3977)", () => {
    const probe = codeOf("scripts", "ux-geometry-census.mjs");
    const start = probe.indexOf("const insideEllipsisTruncation");
    const end = probe.indexOf("const clipped =", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const exemption = probe.slice(start, end);
    expect(exemption).toContain("paintedRect(el)");
    expect(exemption).not.toContain("getBoundingClientRect");
    expect(exemption).not.toContain("overflowX");
  });
});

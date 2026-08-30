import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  BASELINE_FILE,
  CENSUS_VIEWPORTS,
  CHROME_LANDMARKS,
  CHROME_LANDMARK_NAMES,
  CHROME_TOLERANCE_PX,
  MIN_LANDMARKS_PER_SURFACE,
  MIN_SURFACES,
  MIN_SURFACES_PER_VIEWPORT,
  appRoutePatterns,
  baselinePath,
  chromeBaselineAuditSection,
  chromeProbe,
  compareChrome,
  matchesRoutePattern,
  readCommittedBaseline,
  routePathOf,
  serializeBaseline,
  surfaceKey,
  unresolvedBaselineRoutes,
} from "../../scripts/census-chrome-baseline.mjs";
import { makeTmpDir } from "./tmp-dir";

// THE PURE HALF OF THE COMMITTED CHROME BASELINE (#3390's ruling, folded into #3489).
//
// Its sibling e2e/census-chrome-baseline.spec.ts measures a real browser and is
// the only thing that may WRITE the file. This half asks the questions that need
// no browser and therefore run on every push:
//
//   - is the committed file still in the ONE writer's canonical form, or has
//     somebody hand-edited it (the failure mode #3369 paid for: a baseline retyped
//     until review went quiet);
//   - does it still describe enough surfaces to be worth comparing at all, per
//     viewport as well as in total;
//   - do the routes it names still EXIST in `app/(app)` — checked by walking the
//     tree, with an offender planted in a temp corpus so the walk has to find it;
//   - can `compareChrome` see each of the three drift kinds, and does it stay
//     silent on the neighbours that would get it deleted.
//
// The last two are the ones that matter. A comparison is an ABSENCE assertion —
// "nothing drifted" — and three censuses in this repo shipped fail-open in the
// same week this was written. A guard that reports nothing reads exactly like a
// guard that is not looking.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const APP_DIR = path.join(REPO, "app", "(app)");

/**
 * The floor on the ROUTE WALK, asserted before it is used to pronounce any
 * baseline route resolvable.
 *
 * Measured 2026-08-23 at this head: 90 `page.tsx` routes under `app/(app)`. The
 * floor is deliberately slack — deleting a section of the app is a legitimate
 * thing to do — but a walk that has stopped reaching the tree returns few or none
 * and would then agree that every recorded route is fine, which is the reassuring
 * direction and the expensive one.
 */
const APP_ROUTE_FLOOR = 60;

describe("the committed chrome baseline file", () => {
  const raw = fs.readFileSync(baselinePath(REPO), "utf8");
  const baseline = readCommittedBaseline(baselinePath(REPO));

  it("is exactly what the only writer produces, byte for byte", () => {
    // A hand edit that RETYPES a number survives this check and is caught by the
    // e2e recorder instead, which re-measures and disagrees. What this catches is
    // the other half — a surface or a landmark added, dropped or reordered by
    // hand, which no re-measurement would flag as long as the numbers happen to
    // agree, and which is how a baseline quietly stops covering something.
    expect(
      raw,
      `${BASELINE_FILE} is not in the canonical form \`serializeBaseline\` writes. ` +
        "Do not hand-edit it: run `npm run gen:census-baseline` and commit the diff."
    ).toBe(serializeBaseline(baseline));
  });

  it("has no tracked guidance still claiming the committed baseline is impossible", () => {
    const stale = execFileSync("git", ["ls-files", "-z"], { cwd: REPO })
      .toString("utf8")
      .split("\0")
      .filter(
        (rel) =>
          /\.(?:md|mjs|ts|tsx)$/.test(rel) &&
          !/(?:__tests__|\.test\.|\.spec\.)/.test(rel)
      )
      .flatMap((rel) =>
        fs
          .readFileSync(path.join(REPO, rel), "utf8")
          .split("\n")
          .map((line, index) => ({ rel, line, number: index + 1 }))
          .filter(({ line }) =>
            /(?:census baseline["`]? names a file that does not exist in this tree|the census baseline cannot carry an annotation in-repo)/i.test(
              line
            )
          )
      )
      .map(({ rel, line, number }) => `${rel}:${number}: ${line.trim()}`);

    expect(stale).toEqual([]);
  });

  it("records enough surfaces to be worth comparing, in both viewports", () => {
    expect(
      baseline.surfaces.length,
      `The baseline carries ${baseline.surfaces.length} surfaces, under the floor of ` +
        `${MIN_SURFACES}. A file this short compares clean because there is almost ` +
        "nothing in it to disagree with."
    ).toBeGreaterThanOrEqual(MIN_SURFACES);

    // Per viewport, because the total clears the floor while one half has silently
    // dropped out — five desktop surfaces carry a floor of 8 between them and
    // every phone reading could be gone.
    for (const viewport of Object.keys(CENSUS_VIEWPORTS)) {
      expect(
        baseline.surfaces.filter(
          (s: { viewport: string }) => s.viewport === viewport
        ).length,
        `No ${viewport} surfaces in the baseline. Half the chrome this file claims ` +
          "to describe is unrecorded, and the comparison over the other half will " +
          "still report clean."
      ).toBeGreaterThanOrEqual(MIN_SURFACES_PER_VIEWPORT);
    }
  });

  it("gives every surface a real viewport, a reason, and a full set of landmarks", () => {
    for (const s of baseline.surfaces as Array<{
      route: string;
      viewport: string;
      why: string;
      landmarks: Record<string, number>;
    }>) {
      expect(Object.keys(CENSUS_VIEWPORTS)).toContain(s.viewport);
      // The `why` is not decoration: it is what a reader of a red has to decide
      // "did I mean to move this" against.
      expect(
        s.why.length,
        `${surfaceKey(s)} has no reason recorded`
      ).toBeGreaterThan(20);
      expect(
        Object.keys(s.landmarks).length,
        `${surfaceKey(s)} carries only ${Object.keys(s.landmarks).length} landmarks, ` +
          `under the per-surface floor of ${MIN_LANDMARKS_PER_SURFACE}. It was recorded ` +
          "from a page that had not finished rendering."
      ).toBeGreaterThanOrEqual(MIN_LANDMARKS_PER_SURFACE);
      for (const [name, value] of Object.entries(s.landmarks)) {
        expect(
          CHROME_LANDMARK_NAMES,
          `${surfaceKey(s)} records ${name}`
        ).toContain(name);
        expect(
          Number.isInteger(value),
          `${surfaceKey(s)} ${name} = ${value}`
        ).toBe(true);
      }
    }
  });

  it("keeps every declared landmark in the probe that is supposed to measure it", () => {
    // CHROME_LANDMARKS is a data table and `chromeProbe` is a self-contained
    // function that cannot read it (page.evaluate serializes the source). The
    // coupling is therefore not enforced by the language, and a landmark declared
    // here and never measured would leave a column that simply stops existing.
    const source = chromeProbe.toString();
    for (const landmark of CHROME_LANDMARKS)
      expect(
        source.includes(`"${landmark.name}"`),
        `CHROME_LANDMARKS declares \`${landmark.name}\` and chromeProbe never sets it.`
      ).toBe(true);
    // And nothing is recorded that the table does not declare.
    const recorded = new Set(
      baseline.surfaces.flatMap((s: { landmarks: Record<string, number> }) =>
        Object.keys(s.landmarks)
      )
    );
    for (const name of recorded) expect(CHROME_LANDMARK_NAMES).toContain(name);
  });
});

describe("the routes the baseline names still exist", () => {
  const baseline = readCommittedBaseline(baselinePath(REPO));

  it("walks a tree that is actually there before believing any route resolves", () => {
    const patterns = appRoutePatterns(APP_DIR);
    expect(
      patterns.length,
      `The route walk found ${patterns.length} pages under app/(app), below the floor ` +
        `of ${APP_ROUTE_FLOOR}. It is not reading the app, and every recorded route ` +
        "would then look unresolvable — or, with the check inverted, fine."
    ).toBeGreaterThanOrEqual(APP_ROUTE_FLOOR);
  });

  it("resolves every recorded route to a page.tsx", () => {
    expect(
      unresolvedBaselineRoutes(baseline.surfaces, APP_DIR),
      "A recorded surface names a route app/(app) no longer serves. The e2e recorder " +
        "would navigate there, land on the in-shell 404, measure a perfectly real " +
        "shell and agree with the committed numbers."
    ).toEqual([]);
  });

  it("matches a dynamic pattern by segment, and refuses a near miss", () => {
    expect(
      matchesRoutePattern("/trends/metric/weight", "/trends/metric/[kind]")
    ).toBe(true);
    expect(matchesRoutePattern("/trends/metric", "/trends/metric/[kind]")).toBe(
      false
    );
    expect(
      matchesRoutePattern("/trends/metric/weight/x", "/trends/metric/[kind]")
    ).toBe(false);
    expect(matchesRoutePattern("/wellness", "/wellnessy")).toBe(false);
    expect(routePathOf("/nutrition?tab=supplements")).toBe("/nutrition");
  });
});

// Everything above proves the CHECK can read a file. None of it proves the WALK
// can find a bad route: `unresolvedBaselineRoutes` is only ever called with a
// baseline that already resolves, so a walk short-circuited to `[]` would make
// every route unresolvable — and a `patterns.some(...)` inverted by one keystroke
// would make every route fine. One offender is written to disk and the whole walk
// is re-run over it, so it is the walk that has to go and find it.
//
// A CORPUS OF ITS OWN, never the live tree. Vitest runs test files concurrently and
// several other guards walk `app/(app)` and read it a moment later; planting a
// directory there lands a create-then-unlink inside that window and kills unrelated
// tests with ENOENT (measured on #3557's tap-floor census). The temp corpus is the
// same walk over a root nobody else can see, via lib/__tests__/tmp-dir.ts so this
// file is not itself an offender against the temp-dir census (#3248).
describe("the route walk reaches a planted offender", () => {
  const base = makeTmpDir("chrome-baseline-corpus");
  const appDir = path.join(base, "app", "(app)");

  // A corpus with a SHAPE, so the readings below are not two empties agreeing: a
  // root page, a nested static page, and a dynamic segment, which is the only one
  // of the three that needs the pattern matcher to do anything.
  const SEEDS = [
    "page.tsx",
    "wellness/page.tsx",
    "trends/metric/[kind]/page.tsx",
    // Not a page. A directory with components in it is not a route, and a walk
    // that thinks it is would resolve routes that 404.
    "wellness/PracticeCard.tsx",
  ];
  for (const rel of SEEDS) {
    const full = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(
      full,
      "export default function P() { return null; }\n",
      "utf8"
    );
  }

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("reads back the corpus it wrote, and nothing it did not", () => {
    expect(
      appRoutePatterns(appDir).sort(),
      "The walk did not read back the tree this test wrote to disk. Every reading " +
        "below would then be empty and they would all agree, which is the shape of a " +
        "walk that has stopped walking — not of a passing test."
    ).toEqual(["/", "/trends/metric/[kind]", "/wellness"]);
  });

  it("finds nothing wrong with routes the corpus really serves", () => {
    expect(
      unresolvedBaselineRoutes(
        [
          { route: "/" },
          { route: "/wellness" },
          { route: "/trends/metric/weight" },
        ],
        appDir
      )
    ).toEqual([]);
  });

  it("flags a recorded route the tree does not serve", () => {
    expect(
      unresolvedBaselineRoutes(
        [
          { route: "/wellness" },
          // Renamed out from under the baseline — the commonest way this goes
          // wrong, and it is silent everywhere else.
          { route: "/wellbeing" },
          // A directory that holds a component but no page.tsx.
          { route: "/wellness/PracticeCard" },
          // A dynamic route whose segment count does not match.
          { route: "/trends/metric" },
        ],
        appDir
      ).sort()
    ).toEqual(["/trends/metric", "/wellbeing", "/wellness/PracticeCard"]);
  });
});

describe("compareChrome can see each way a shell moves", () => {
  const at = (landmarks: Record<string, number>) => ({ landmarks });

  it("flags a landmark that moved past the tolerance", () => {
    const rows = compareChrome(
      at({ contentWidth: 358 }),
      at({ contentWidth: 342 })
    );
    expect(rows).toEqual([
      {
        landmark: "contentWidth",
        kind: "moved",
        was: 358,
        now: 342,
        delta: -16,
      },
    ]);
  });

  it("stays silent at exactly the tolerance, and speaks one pixel past it", () => {
    // The bound is INCLUSIVE, and this is the assertion that says so — a sentence
    // in a comment is not a bound. A guard that fired on a rounding difference
    // between two Chromium builds would be refreshed until it meant nothing.
    const was = at({ contentWidth: 358 });
    expect(
      compareChrome(was, at({ contentWidth: 358 + CHROME_TOLERANCE_PX }))
    ).toEqual([]);
    expect(
      compareChrome(was, at({ contentWidth: 358 - CHROME_TOLERANCE_PX }))
    ).toEqual([]);
    expect(
      compareChrome(was, at({ contentWidth: 358 + CHROME_TOLERANCE_PX + 1 }))
    ).toHaveLength(1);
  });

  it("calls a recorded landmark that could not be measured MISSING", () => {
    // The fail-open direction. Without this row the dock stops rendering, its
    // reading leaves the measured set, and the comparison over what is left says
    // nothing at all.
    expect(compareChrome(at({ dockHeight: 57 }), at({}))).toEqual([
      {
        landmark: "dockHeight",
        kind: "missing",
        was: 57,
        now: null,
        delta: null,
      },
    ]);
  });

  it("calls a landmark that appeared where none was recorded UNRECORDED", () => {
    expect(compareChrome(at({}), at({ sidebarWidth: 240 }))).toEqual([
      {
        landmark: "sidebarWidth",
        kind: "unrecorded",
        was: null,
        now: 240,
        delta: null,
      },
    ]);
  });

  it("says nothing about a surface that did not move", () => {
    const landmarks = {
      contentWidth: 358,
      contentGutterLeft: 16,
      dockHeight: 57,
    };
    expect(compareChrome(at(landmarks), at({ ...landmarks }))).toEqual([]);
  });
});

describe("serializeBaseline is the one canonical writer", () => {
  const surfaces = [
    {
      route: "/wellness",
      viewport: "mobile",
      why: "later by key",
      // Deliberately out of CHROME_LANDMARKS order.
      landmarks: { contentWidth: 358, mainInsetLeft: 0 },
    },
    {
      route: "/",
      viewport: "desktop",
      why: "earlier by key",
      landmarks: { mainInsetLeft: 240, contentWidth: 1000 },
    },
  ];

  it("sorts surfaces by key and landmarks by the declared order", () => {
    const text = serializeBaseline({ surfaces });
    const parsed = JSON.parse(text);
    expect(parsed.surfaces.map(surfaceKey)).toEqual([
      "desktop /",
      "mobile /wellness",
    ]);
    for (const s of parsed.surfaces)
      expect(Object.keys(s.landmarks)).toEqual(
        CHROME_LANDMARK_NAMES.filter((n: string) => n in s.landmarks)
      );
  });

  it("is idempotent, so a re-serialize is never a spurious diff", () => {
    const once = serializeBaseline({ surfaces });
    expect(serializeBaseline(JSON.parse(once))).toBe(once);
    expect(once.endsWith("\n")).toBe(true);
  });
});

describe("the census audit section", () => {
  it("says how many surfaces it compared even when nothing drifted", () => {
    // "Nothing drifted" and "the comparison never ran" are the two readings a
    // reader must be able to tell apart, and a section that disappears when it is
    // happy reads exactly like one that was never wired up.
    const lines = chromeBaselineAuditSection([
      { route: "/", viewport: "mobile", drift: [] },
      { route: "/wellness", viewport: "mobile", drift: [] },
    ]).join("\n");
    expect(lines).toContain("Compared 2 surface(s)");
    expect(lines).toContain("None drifted");
  });

  it("names the route, the landmark and the refresh command when one drifted", () => {
    const lines = chromeBaselineAuditSection([
      {
        route: "/wellness",
        viewport: "mobile",
        drift: [
          {
            landmark: "contentWidth",
            kind: "moved",
            was: 358,
            now: 342,
            delta: -16,
          },
        ],
      },
    ]).join("\n");
    expect(lines).toContain("/wellness");
    expect(lines).toContain("contentWidth");
    expect(lines).toContain("-16");
    expect(lines).toContain("npm run gen:census-baseline");
  });

  it("says so out loud when it compared nothing at all", () => {
    expect(chromeBaselineAuditSection([]).join("\n")).toContain(
      "nothing was compared"
    );
  });
});

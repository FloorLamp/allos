import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static boundary guard for the trailing-average helper (issue #1909, the #221
// rule), in the shape lib/__tests__/observation-substrate.test.ts established: read
// the repo's own source as TEXT (no DB, no network — pure vitest tier) and fail the
// build if a surface re-implements a computation instead of calling the one that
// owns it.
//
// The class of drift this prevents is exactly what shipped before #1909: the
// dashboard's Steps-today card and the metric detail page's Rolling summary each
// averaged "the last 7 days" their own way — one over data-bearing days excluding
// today, one over calendar days including a half-finished today — and both printed
// the answer as "7-day average". Neither was wrong in isolation; there was simply
// no place where the choice was made once and named.
//
// Two assertions, one sweep:
//   1. the helper exists and both former implementers call it;
//   2. neither of them still carries the window/mean it handed over;
//   3. no OTHER module grows a today-anchored trailing mean of its own without an
//      allowlist entry saying why it is a different question.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The module that owns trailing-window selection and the mean over it.
const HELPER = "lib/trailing-average.ts";
// The two surfaces #1909 unified. Both are pure aggregations their components
// format; both must reach the window through the helper.
const CALLERS = ["lib/steps-today.ts", "lib/trends-body-metrics.ts"];

const SCAN_DIRS = ["lib", "app", "components", "scripts"];

// A today-anchored trailing mean, as text: a backwards date shift (the window's
// cutoff) plus a sum-over-length (the mean). Coarse on purpose — it is meant to
// catch a NEW hand-rolled window, and anything it catches that is a different
// question earns an allowlist entry rather than a silent pass.
const CUTOFF = /shiftDateStr\([^,)]+,\s*-/;
const MEAN = /\/\s*[A-Za-z_$][\w$.]*\.length/;

// Computations that legitimately match the shape without being a trailing average
// of a daily series anchored on today. Each entry says why.
const ALLOW: { file: string; why: string }[] = [
  {
    file: "lib/sleep-summary.ts",
    why: "the baseline for ONE night: the mean is anchored on the latest recorded night rather than on today (a night logged four days ago still compares against the 30 nights before IT), so a today-anchored window would silently change which nights it covers. Already excludes its anchor day, i.e. it agrees with this helper's default.",
  },
  {
    file: "lib/sleep-regularity.ts",
    why: "midpoint/variability over a window — a median and a spread, not a mean of a value series; the window is anchored on the last recorded night, not today.",
  },
  {
    file: "lib/protocol-compare.ts",
    why: "paired before/after windows around a protocol run: both windows are anchored on the RUN's start and end dates, and the whole point is comparing two spans of history to each other rather than summarising a trailing one.",
  },
  {
    file: "lib/illness-episode-format.ts",
    why: "early-half vs late-half fever means WITHIN one episode — the split is the episode's own midpoint, so there is no trailing window and no today.",
  },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// Strip line + block comments and string literals so PROSE describing a window (a
// doc comment naming shiftDateStr, a SQL string) can never trip the scanners —
// only real code tokens count.
function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function sourceFiles(): { rel: string; code: string }[] {
  const files: { rel: string; code: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (/__tests__|__db_tests__|__action_tests__|\.test\.tsx?$/.test(rel)) {
        continue;
      }
      files.push({ rel, code: stripCommentsAndStrings(read(rel)) });
    }
  }
  return files;
}

// The source of ONE exported function, from its signature to the closing brace in
// column 0 — so a scan can target `bodyMetricPeriodStats` inside a module that
// legitimately does plenty of other windowing.
function functionBody(rel: string, name: string): string {
  const code = stripCommentsAndStrings(read(rel));
  const start = code.indexOf(`export function ${name}(`);
  expect(start, `${rel} should export ${name}`).toBeGreaterThanOrEqual(0);
  const end = code.indexOf("\n}", start);
  return code.slice(start, end);
}

describe("the trailing-average boundary (issue #1909 / #221)", () => {
  it("one module owns the window and the mean, and both surfaces call it", () => {
    const helper = read(HELPER);
    expect(/export function trailingAverage\b/.test(helper)).toBe(true);
    // The declared option surface is the point: a caller states its basis and its
    // today-inclusion instead of encoding them in a private filter.
    expect(/export type TrailingWindowBasis\b/.test(helper)).toBe(true);
    expect(helper.includes('"data-bearing"')).toBe(true);
    expect(helper.includes('"calendar"')).toBe(true);
    // Today-excluded is the DEFAULT, not something every caller must remember.
    expect(/includeToday\s*=\s*false/.test(helper)).toBe(true);
    // The DAY-ONE rule is the helper's too (#1909's follow-up ruling): one place
    // decides that a profile with no complete-day history at all falls back to
    // today's reading, so four surfaces cannot grow four versions of "day one".
    expect(/dayOneFallback/.test(helper)).toBe(true);

    for (const rel of CALLERS) {
      const code = stripCommentsAndStrings(read(rel));
      expect(code, `${rel} should call the shared helper`).toContain(
        "trailingAverage("
      );
      // The import path lives in a string literal, so it is read unstripped.
      expect(read(rel), `${rel} should import it`).toMatch(
        /import \{ trailingAverage \} from "\.\/trailing-average"/
      );
      // …and must HANDLE the day-one window rather than passing it through as an
      // average. Qualify it ("today's reading") or decline it — silence is the one
      // option that mislabels a number.
      expect(
        code,
        `${rel} should read dayOneFallback and either qualify or decline it`
      ).toContain("dayOneFallback");
    }
  });

  it("neither surface still carries the window it handed over", () => {
    // summarizeStepsToday sorted the series and sliced its own N most recent prior
    // days; bodyMetricPeriodStats built its own cutoff and filtered on it. Both
    // shapes are now the helper's, and a reappearance here is a second average.
    const steps = functionBody("lib/steps-today.ts", "summarizeStepsToday");
    expect(steps).not.toMatch(/\.slice\(/);
    expect(steps).not.toMatch(/\.sort\(/);
    expect(steps).not.toMatch(MEAN);

    const period = functionBody(
      "lib/trends-body-metrics.ts",
      "bodyMetricPeriodStats"
    );
    expect(period).not.toMatch(CUTOFF);
    expect(period).not.toMatch(MEAN);
  });

  it("no other module grows a today-anchored trailing mean without a reason", () => {
    const offenders: string[] = [];
    for (const { rel, code } of sourceFiles()) {
      if (rel === HELPER) continue;
      if (ALLOW.some((a) => a.file === rel)) continue;
      if (CUTOFF.test(code) && MEAN.test(code)) offenders.push(rel);
    }
    expect(
      offenders,
      `A trailing average over a dated series belongs in ${HELPER} (issue #1909/#221). ` +
        `Call trailingAverage() with the basis and today-inclusion this surface wants, ` +
        `or add an ALLOW entry explaining why this is a different question:\n${offenders.join(
          "\n"
        )}`
    ).toEqual([]);
  });

  it("every allowlisted exception is real and still carries the shape", () => {
    for (const entry of ALLOW) {
      const code = stripCommentsAndStrings(read(entry.file));
      // A stale entry — the file no longer matches — would quietly widen the
      // allowlist for whatever is written there next.
      expect(
        CUTOFF.test(code) && MEAN.test(code),
        `${entry.file} no longer matches the guarded shape; drop its ALLOW entry`
      ).toBe(true);
      expect(entry.why.length).toBeGreaterThan(40);
    }
  });
});

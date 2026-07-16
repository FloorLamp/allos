import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the temperature-display convention (issue #857). Body temperature is
// stored canonically in °F, but the DISPLAY unit is a login preference (F | C). Every
// surface that renders a body-temperature reading must route it through `fmtTemp`
// (lib/units.ts) so a °C login sees °C everywhere and no surface forks the °F→°C math.
//
// The banned signature is a numeric value glued to a HARDCODED degree unit — the exact
// pattern the household chip / episode summary / timeline peak-temp used before this
// change: a JSX/template expression close (`}`) immediately followed by `°F` or `°C`
// (e.g. `${t.degF.toFixed(1)}°F`). Legit uses don't match: the `<option>°F</option>`
// unit-choice labels (`>°F<`), `fmtTemp`'s own template (which interpolates
// `tempUnitLabel(unit)`, never a literal), and `tempUnitLabel`'s `"°F"` string returns
// (preceded by `"`). A small allowlist covers the formatter itself and the AMBIENT
// weather temperature (`avg_temp_c`) that activity imports store in Celsius — that's not
// body temperature and has no fever-tracking pref.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components", "lib"];

// A value expression (`}`) directly followed by a hardcoded degree unit.
const HARDCODED_TEMP = /\}°[FC]/;

// Files/paths allowed to glue a value to a hardcoded degree unit.
//  - lib/units.ts: not a match anyway, listed for clarity as the formatter home.
//  - The ambient (weather) activity-metric temperature is canonical °C, unrelated to
//    the body-temperature fever pref; it renders its stored °C directly.
const ALLOW_SUBSTR = ["avg_temp_c"];
// MergeConflictDialog renders the AMBIENT activity weather temperature (the `avg_temp_c`
// metric, canonical °C) across two lines (`case`/`return`), so the substring guard can't
// see it on the return line — its only degree-unit render is that ambient metric.
const ALLOW_FILES = new Set<string>([
  "lib/units.ts",
  "components/MergeConflictDialog.tsx",
]);

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

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (
        rel.includes("__tests__") ||
        rel.includes("__db_tests__") ||
        rel.includes("__action_tests__") ||
        rel.endsWith(".test.ts") ||
        rel.endsWith(".test.tsx")
      )
        continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("temperature display convention (issue #857)", () => {
  it("no surface renders a body temperature with a hardcoded degree unit — all go through fmtTemp", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOW_FILES.has(rel)) continue;
      text.split("\n").forEach((line, i) => {
        if (!HARDCODED_TEMP.test(line)) return;
        if (ALLOW_SUBSTR.some((s) => line.includes(s))) return;
        offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `These glue a value to a hardcoded °F/°C. Route body-temperature displays ` +
        `through fmtTemp(degF, temperatureUnit) (lib/units.ts) so a °C login sees ` +
        `°C everywhere:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the fmtTemp formatter exists and converts at the display boundary", () => {
    const src = fs.readFileSync(path.join(REPO, "lib/units.ts"), "utf8");
    expect(/export function fmtTemp\b/.test(src)).toBe(true);
    expect(/export function degFTo\b/.test(src)).toBe(true);
  });
});

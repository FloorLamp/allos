import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { FIXTURE_TIMEZONE_OVERRIDES } from "../../e2e/fixture-timezones";

// Fixture time is resolved against a clock AND a zone. A string built for one and
// read through another can fail only in a recurring UTC-hour band (#2287). These
// guards make both sources of divergence declared:
//
//  1. every profile that opts out of the rotating instance timezone goes through
//     setFixtureTimezone and names a registry entry with a reason;
//  2. interpolated date-time strings are frozen at their current per-file count.
//     New files/sites must use zonedWallTimeToUtc/utcInstant (or make an existing
//     ledger entry grow, which fails). Counts may only shrink.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const E2E = path.join(REPO, "e2e");

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(full) : [full];
    })
    .filter((file) => file.endsWith(".ts"));
}

const ALL_E2E_FILES = filesUnder(E2E);
const TIMEZONE_SCAN_FILES = ALL_E2E_FILES.filter(
  (file) => relative(file) !== "e2e/fixture-timezones.ts"
);
const DATETIME_SCAN_FILES = ALL_E2E_FILES.filter(
  (file) =>
    file.startsWith(`${path.join(E2E, "seed")}${path.sep}`) ||
    file.endsWith(".spec.ts")
);

function relative(file: string): string {
  return path.relative(REPO, file).replaceAll(path.sep, "/");
}

function source(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function callName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

const INTERPOLATED_DATETIME_ALLOW: Record<
  string,
  { count: number; why: string }
> = {
  "e2e/dose-history.spec.ts": {
    count: 1,
    why: "Parses an explicit-Z midnight solely for UTC day arithmetic; it is not written as a fixture timestamp.",
  },
  "e2e/food-drug-ledger.spec.ts": {
    count: 1,
    why: "Parses an explicit-Z midnight solely to shift a date in UTC; no profile-owned instant is stored from it.",
  },
  "e2e/measurements-form-layout.spec.ts": {
    count: 1,
    why: "Expected-value assertion for the profile-local zoneless shape the form deliberately stores, not a fixture instant constructor.",
  },
  "e2e/medications-followups.spec.ts": {
    count: 1,
    why: "Parses an explicit-Z midnight solely for UTC date arithmetic; the result is reduced back to a date.",
  },
  "e2e/records-recency.spec.ts": {
    count: 2,
    why: "The Fitbit score fixture is day-grained; metric_samples explicitly permits zoneless day-bound windows in its mixed-convention start/end columns.",
  },
  "e2e/seed/dashboard.ts": {
    count: 2,
    why: "Synthetic imported daily step windows carry explicit Z endpoints and are keyed by their separately supplied date.",
  },
  "e2e/seed/findings.ts": {
    count: 5,
    why: "One Open-Meteo hour_ts is deliberately a provider-local zoneless cache key; the other four are explicit-Z Date inputs used only for UTC date arithmetic.",
  },
  "e2e/seed/metrics.ts": {
    count: 7,
    why: "Explicit-Z imported HRV/skin-temperature instants plus the day-grained vitals step window allowed by metric_samples' documented mixed convention.",
  },
  "e2e/seed/nutrition.ts": {
    count: 2,
    why: "Food-slot and usual-food events are explicit-Z instants on profiles declared UTC in the fixture-timezone registry.",
  },
  "e2e/seed/situations.ts": {
    count: 2,
    why: "BBT samples state only a day, so both endpoints intentionally use metric_samples' documented zoneless day-midnight shape.",
  },
  "e2e/seed/sleep.ts": {
    count: 5,
    why: "Legacy SRI/import rows are explicit-Z synthetic provider instants; newer profile-local sleep fixtures below already use zonedWallTimeToUtc.",
  },
  "e2e/seed/trends.ts": {
    count: 26,
    why: "Historical synthetic streams are either explicit-Z imported instants or deliberate zoneless day-grain metric_samples endpoints; the HR-minute failure class already routes through zonedWallTimeToUtc.",
  },
  "e2e/sleep-page.spec.ts": {
    count: 5,
    why: "Spec-owned mixed-convention sleep rows include day-grain zoneless endpoints and one explicit-Z value used only for date arithmetic.",
  },
};

const SAFE_DATETIME_BUILDERS = new Set(["utcInstant", "zonedWallTimeToUtc"]);

function isInsideSafeBuilder(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent)) {
      const name = callName(parent);
      if (name && SAFE_DATETIME_BUILDERS.has(name)) return true;
    }
    if (ts.isStatement(parent)) return false;
  }
  return false;
}

describe("e2e fixture time declarations", () => {
  it("routes every per-profile timezone override through the declared registry", () => {
    const raw: string[] = [];
    const used = new Set<string>();

    for (const file of TIMEZONE_SCAN_FILES) {
      const sf = source(file);
      const rawTimezoneSetters = new Set(["setTimezone"]);
      for (const statement of sf.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.moduleSpecifier.text.endsWith("lib/settings") ||
          !statement.importClause?.namedBindings ||
          !ts.isNamedImports(statement.importClause.namedBindings)
        ) {
          continue;
        }
        for (const imported of statement.importClause.namedBindings.elements) {
          if ((imported.propertyName ?? imported.name).text === "setTimezone") {
            rawTimezoneSetters.add(imported.name.text);
          }
        }
      }
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const name = callName(node);
          if (name === "setFixtureTimezone") {
            const declaration = node.arguments[2];
            if (!declaration || !ts.isStringLiteral(declaration)) {
              raw.push(
                `${relative(file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} dynamic declaration`
              );
            } else {
              used.add(declaration.text);
            }
          } else if (
            (name && rawTimezoneSetters.has(name)) ||
            node.arguments.some(
              (arg) => ts.isStringLiteral(arg) && arg.text === "timezone"
            )
          ) {
            raw.push(
              `${relative(file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} raw timezone call`
            );
          }
        }
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateExpression(node)) &&
          /\b(?:INSERT\s+INTO|UPDATE)\s+profile_settings\b[\s\S]*['"]timezone['"]/i.test(
            node.getText(sf)
          )
        ) {
          raw.push(
            `${relative(file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} raw timezone SQL`
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(raw).toEqual([]);
    const declared = Object.entries(FIXTURE_TIMEZONE_OVERRIDES);
    expect(declared.every(([, entry]) => entry.why.trim().length > 0)).toBe(
      true
    );
    expect([...used].sort()).toEqual(declared.map(([key]) => key).sort());
  });

  it("adds no undeclared interpolated date-time fixture strings", () => {
    const counts = new Map<string, number>();
    for (const file of DATETIME_SCAN_FILES) {
      const sf = source(file);
      const visit = (node: ts.Node): void => {
        if (
          ts.isTemplateExpression(node) &&
          node.templateSpans.some((span) =>
            /^T(?:\d|$)/.test(span.literal.text)
          ) &&
          !isInsideSafeBuilder(node)
        ) {
          const key = relative(file);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    const actual = Object.fromEntries([...counts].sort());
    const allowed = Object.fromEntries(
      Object.entries(INTERPOLATED_DATETIME_ALLOW)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, entry]) => [file, entry.count])
    );
    expect(
      Object.values(INTERPOLATED_DATETIME_ALLOW).every(
        (entry) => entry.count > 0 && entry.why.trim().length > 0
      )
    ).toBe(true);
    expect(actual).toEqual(allowed);
  });
});

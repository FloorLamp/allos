// The age-as-of-date scan (issue #2090).
//
// THE RULE, in one sentence: a person's age for a JUDGMENT is evaluated as of the
// reading's date, never today (#150 — a lab drawn at 8 must not be judged by the
// bands of the 12-year-old reading the page; restated in
// lib/queries/metric-judgment.ts, which resolves age on the reading's date).
//
// The four helpers in lib/date.ts already take an `on` argument, so the failure
// mode is not a missing parameter — it is a caller passing TODAY where the
// reading's own date belongs. A text scan cannot judge intent, but it can force
// the decision into the open: every call whose as-of argument is today-shaped
// must be registered here with the reason it is a genuine current-age question
// (a form showing the person's age now, an age gate on an affordance, a schedule
// asking where the person is today). Same idiom as page-width-scan.test.ts:
// source read as TEXT, an allowlist that must not go stale.
//
// WHAT THIS DOES NOT CATCH, stated plainly: hand-rolled age arithmetic that never
// calls the helpers (none exists today — the 365.25 family in lib/ is elapsed-
// duration math, not a person's age), and a today-shaped value laundered through
// an intermediate variable whose name says nothing. The scan shrinks the hole;
// review owns the rest.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The lib/date.ts age helpers and which argument is the as-of date (1-based). */
const AGE_HELPERS: Record<string, number> = {
  ageFromBirthdate: 2,
  ageInMonthsFromBirthdate: 2,
  ageInMonthsExact: 2,
  ageMonthsFrom: 3,
};

/** An as-of argument that is (or resolves) "today". */
const TODAY_SHAPED = /\b(?:today|todayStr|now)\b|dateStrInTz\s*\(/;

/**
 * Files whose today-anchored age calls are genuine current-age questions.
 * Keyed by repo-relative file, with the reason — the same contract as
 * PAGE_WIDTH_EXCEPTIONS: an entry with nothing left to excuse must be deleted.
 */
const CURRENT_AGE_FILES = new Map<string, string>([
  [
    "app/(app)/settings/profile/ProfileForm.tsx",
    "the profile form shows the person's age NOW beside the birthdate field",
  ],
  [
    "app/(app)/records/ImmunizationsSection.tsx",
    "the immunization schedule asks where the person is today (#310)",
  ],
  [
    "app/(app)/trends/BodySection.tsx",
    "planBodyCharts gates the growth cards on whether the profile is a child NOW",
  ],
  [
    "app/(app)/trends/metric/[kind]/page.tsx",
    "entry affordances (body fat, growth quick-add) are gated on current age; " +
      "the JUDGMENT half resolves age on the reading's date in " +
      "lib/queries/metric-judgment.ts",
  ],
  [
    "lib/queries/intake/warnings.ts",
    "age-gated intake warnings describe the person as they are now",
  ],
  [
    "lib/settings/profile-attrs.ts",
    "getUserAge/profileAgeMonths ARE the current-age wrappers other surfaces call",
  ],
  [
    "lib/queries/immunization-options.ts",
    "the vaccine picker ranks by the schedule position the person holds today",
  ],
  [
    "lib/profile-summary-load.ts",
    "the passport summary states the person's current age",
  ],
  [
    "lib/growth-series.ts",
    "buildGrowthProfile bounds the chart domain at the profile's age now; every " +
      "measurement point still resolves age on its own date (r.date)",
  ],
  [
    "lib/ttc.ts",
    "elapsed months trying to conceive — the month-math helper reused on a cycle " +
      "anchor, not a person's age at all",
  ],
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("__") || entry.name === "node_modules")
        continue;
      out.push(...walk(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function rel(full: string): string {
  return path.relative(REPO, full).split(path.sep).join("/");
}

function sourceFiles(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const d of ["lib", "app", "scripts"]) {
    for (const full of walk(path.join(REPO, d))) {
      const r = rel(full);
      if (r === "lib/date.ts") continue; // the helpers' own home
      out.push({ rel: r, text: fs.readFileSync(full, "utf8") });
    }
  }
  return out;
}

/** Top-level comma split of a balanced argument list, string-literal aware. */
export function splitArgs(argList: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let current = "";
  for (let i = 0; i < argList.length; i++) {
    const c = argList[i];
    if (quote) {
      current += c;
      if (c === "\\") {
        current += argList[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/** Every age-helper call in a file, with its as-of argument's text. */
export function ageCalls(
  text: string
): { helper: string; asOf: string; line: number }[] {
  const out: { helper: string; asOf: string; line: number }[] = [];
  const re = new RegExp(`\\b(${Object.keys(AGE_HELPERS).join("|")})\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const helper = m[1];
    // Walk to the call's balanced closing paren so multi-line calls read whole.
    let depth = 1;
    let end = re.lastIndex;
    for (let i = re.lastIndex; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      end = i;
    }
    const args = splitArgs(text.slice(re.lastIndex, end));
    const asOf = args[AGE_HELPERS[helper] - 1] ?? "";
    out.push({
      helper,
      asOf,
      line: text.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

describe("age is evaluated as of the reading's date (issue #2090, #150)", () => {
  it("splits argument lists at the top level only", () => {
    expect(splitArgs('a, f(b, c), "d,e"')).toEqual(["a", "f(b, c)", '"d,e"']);
    expect(splitArgs("birthdate,\n  r.date")).toEqual(["birthdate", "r.date"]);
  });

  it("finds a call's as-of argument across lines and helpers", () => {
    const calls = ageCalls(
      "const a = ageFromBirthdate(bd, r.date);\n" +
        "const b = ageMonthsFrom(\n  bd,\n  stored,\n  now\n);"
    );
    expect(calls.map((c) => [c.helper, c.asOf])).toEqual([
      ["ageFromBirthdate", "r.date"],
      ["ageMonthsFrom", "now"],
    ]);
  });

  it("classifies today-shaped as-of arguments", () => {
    for (const good of ["r.date", "reading.date", "h.date", "on", "date"]) {
      expect(TODAY_SHAPED.test(good), good).toBe(false);
    }
    for (const bad of [
      "todayStr",
      "now",
      "today(profileId)",
      "dateStrInTz(tz)",
    ]) {
      expect(TODAY_SHAPED.test(bad), bad).toBe(true);
    }
  });

  it("every today-anchored age call is a registered current-age question", () => {
    const offenders: string[] = [];
    for (const { rel: r, text } of sourceFiles()) {
      for (const { helper, asOf, line } of ageCalls(text)) {
        if (!TODAY_SHAPED.test(asOf)) continue;
        if (CURRENT_AGE_FILES.has(r)) continue;
        offenders.push(`${r}:${line} — ${helper}(…, ${asOf})`);
      }
    }
    expect(
      offenders,
      "These pass a today-shaped date where a person's age is being computed. If " +
        "the age judges a READING, pass the reading's own date (#150). If it is a " +
        "genuine current-age question, register the file in CURRENT_AGE_FILES " +
        "with the reason:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("every registered file still holds a today-anchored age call", () => {
    const byFile = new Map(sourceFiles().map((f) => [f.rel, f.text]));
    const stale: string[] = [];
    for (const r of CURRENT_AGE_FILES.keys()) {
      const text = byFile.get(r);
      const held =
        text != null && ageCalls(text).some((c) => TODAY_SHAPED.test(c.asOf));
      if (!held) stale.push(r);
    }
    expect(
      stale,
      `CURRENT_AGE_FILES entries with nothing left to excuse — delete them so ` +
        `the allowlist keeps meaning what it says:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("the scan is not vacuous — both shapes exist in the tree", () => {
    const files = sourceFiles();
    const all = files.flatMap(({ text }) => ageCalls(text));
    expect(all.length).toBeGreaterThan(5);
    expect(all.some((c) => TODAY_SHAPED.test(c.asOf))).toBe(true);
    expect(all.some((c) => !TODAY_SHAPED.test(c.asOf))).toBe(true);
  });
});

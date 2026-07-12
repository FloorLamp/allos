import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static boundary guard for flag NOTABILITY decisions (issue #544/#551). A stored
// medical-record `flag` partitions into display tiers via the canonical helpers in
// lib/reference-range.ts: isOutOfRange (high/low/abnormal → "bad"), isNonOptimal
// (amber "warn"), and everything else — including "normal" AND the neutral "immune"
// flag added in #551 — which is NOT notable. Any surface deciding "is this result
// notable / out of range?" (sort it first, alert on it, badge it as attention) MUST
// route through isOutOfRange / isNonOptimal, never an ad-hoc `flag !== "normal"` /
// `flag === "normal"` string compare.
//
// The motivating bug: recent-labs sorted "notable" results to the top with a loose
// `flag !== "normal"` test, so the good durable-immunity "immune" titer (#544 wanted
// to STOP a good immunity result reading as needs-attention) sorted to the top as if
// abnormal. A loose compare silently miscategorizes every future neutral flag value
// the moment it's added; the canonical predicate does not. This test reads the repo's
// own source as TEXT (no DB, no network, so it stays "pure" in the vitest sense) and
// fails the build if any production module compares a `flag`-named value to the string
// literal "normal"/'normal' outside a small, justified allowlist.
//
// Scope note: this targets the concrete, detectable antipattern — a flag-suffixed
// identifier compared with ==/===/!=/!== to a `normal` string literal. It deliberately
// does NOT flag specific-value logic (`flag === "low"` / `=== "high"`), display
// interpolation (`flag ?? "?"`), or SQL `flag IN (...)` / `flag NOT IN ('normal',
// 'immune')` lists — those are intentional and already handle "immune" explicitly.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Directories scanned for production source.
const SCAN_DIRS = ["lib", "app", "components"];

// Files permitted to compare a flag to "normal" directly, each with a justification.
// PREFER fixing a call site (route it through isOutOfRange/isNonOptimal) over adding it
// here — the allowlist is for comparisons that genuinely aren't notability decisions.
const ALLOWLIST: { path: string; reason: string }[] = [
  {
    path: "lib/reference-range.ts",
    reason:
      "Defines the canonical notability helpers (isOutOfRange/isNonOptimal/flagTone/" +
      "flagLabel) plus specific-value flag logic (e.g. the immune-positive classifier " +
      "checking an in-range standard flag). This is the source of truth the rule " +
      "routes everyone toward, not an ad-hoc consumer.",
  },
  {
    path: "components/dashboard/RecentLabsWidget.tsx",
    reason:
      "Badge-PRESENCE decision: renders a labeled chip for any non-normal flag, " +
      "including a NEUTRAL slate 'Immune' chip (its color is chosen by flagTone, " +
      "which tiers immune as default). This is a display-label decision, not a " +
      "notability/out-of-range SORT — the sort itself lives in lib/recent-labs.ts and " +
      "routes through the canonical helpers.",
  },
];

const ALLOWED = new Set(ALLOWLIST.map((a) => a.path));

function isExcluded(rel: string): boolean {
  return (
    rel.includes("__tests__") ||
    rel.includes("__db_tests__") ||
    rel.includes("__action_tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx")
  );
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

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// Strip line and block comments so a mention of `flag !== "normal"` in prose (a doc
// comment, or the SQL-in-a-comment in migration 020) can't trip the scanner — only
// real code counts.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// An equality/inequality comparison between a value and a "normal"/'normal' string
// literal, in EITHER order. The captured identifier is checked for a `flag` suffix
// separately so we only flag genuine flag comparisons (`flag`, `r.flag`, `a.flag`,
// `currentFlag`) and skip lookalikes (`f === "normal"`, `mode === "normal"`).
const OP = "(?:===|!==|==|!=)";
const LITERAL = `["']normal["']`;
const IDENT = "[A-Za-z_$][\\w$.]*";
const ID_LEFT = new RegExp(`(${IDENT})\\s*${OP}\\s*${LITERAL}`, "g");
const ID_RIGHT = new RegExp(`${LITERAL}\\s*${OP}\\s*(${IDENT})`, "g");

// True when the compared identifier's final segment is `flag` (case-insensitive):
// `flag`, `r.flag`, `record.flag`, `currentFlag`, `a.flag` — but not `f` or `mode`.
function isFlagIdentifier(id: string): boolean {
  return /(^|[.])[A-Za-z_$]*flag$/i.test(id);
}

function flagNormalComparisons(text: string): string[] {
  const src = stripComments(text);
  const hits: string[] = [];
  for (const re of [ID_LEFT, ID_RIGHT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const id = m[1];
      if (isFlagIdentifier(id)) hits.push(m[0].trim());
    }
  }
  return hits;
}

describe("flag notability boundary (issue #544/#551)", () => {
  it('no production module decides notability with a loose flag-vs-"normal" compare', () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOWED.has(rel)) continue;
      const hits = flagNormalComparisons(text);
      if (hits.length > 0) offenders.push(`${rel}: ${hits.join(" ; ")}`);
    }
    expect(
      offenders,
      `These modules compare a flag to the string "normal" to decide notability. ` +
        `Route the decision through isOutOfRange / isNonOptimal from ` +
        `@/lib/reference-range so a neutral flag value like "immune" (#544/#551) isn't ` +
        `miscategorized. If a comparison genuinely isn't a notability decision, add it ` +
        `to the allowlist in this test with a justification:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the canonical notability helpers exist in lib/reference-range.ts", () => {
    const src = fs.readFileSync(
      path.join(REPO, "lib/reference-range.ts"),
      "utf8"
    );
    expect(/export function isOutOfRange\b/.test(src)).toBe(true);
    expect(/export function isNonOptimal\b/.test(src)).toBe(true);
  });

  it("self-check: the scanner detects the antipattern it forbids", () => {
    expect(flagNormalComparisons(`const x = flag !== "normal";`)).toHaveLength(
      1
    );
    expect(
      flagNormalComparisons(`const x = r.flag === 'normal';`)
    ).toHaveLength(1);
    expect(
      flagNormalComparisons(`if ("normal" !== currentFlag) {}`)
    ).toHaveLength(1);
    // Not notability decisions → must NOT trip:
    expect(flagNormalComparisons(`const x = f === "normal";`)).toHaveLength(0);
    expect(flagNormalComparisons(`const x = mode === "normal";`)).toHaveLength(
      0
    );
    expect(flagNormalComparisons(`const x = flag === "low";`)).toHaveLength(0);
    expect(
      flagNormalComparisons(`const s = "flag NOT IN ('normal', 'immune')";`)
    ).toHaveLength(0);
    // In a comment → stripped:
    expect(flagNormalComparisons(`// flag !== "normal"`)).toHaveLength(0);
  });
});

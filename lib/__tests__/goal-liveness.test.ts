import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static boundary guard for goal LIVENESS decisions (goal-liveness audit). A goal is
// "live" iff it is being actively pursued: status must be "active" AND its independent
// `archived` column must be falsy. This is DUAL-AXIS on purpose — GOAL_STATUSES is
// ["active", "achieved"], so status alone doesn't imply live, and `archived` is a
// separate 0/1 column, so a raw `g.status === "active"` check that forgets `archived`
// silently treats a filed-away goal as live (the classic bug this audit found repeated
// across 8 sites). The canonical predicate is isGoalLive(g) in lib/goals.ts; every
// surface that filters to live goals routes through it.
//
// This test reads the repo's own source as TEXT (no DB, no network, so it stays "pure"
// in the vitest sense) and fails the build if any production module tests a GOAL
// identifier's status against the string literal "active" — i.e. `g.status ===
// "active"` / `goal.status !== "active"` — outside lib/goals.ts (the helper's home)
// and the allowlist below. The identifier is restricted to `g` / `goal` so we only
// flag goal-liveness compares and skip the many other `.status === "active"` checks on
// conditions (`c.status`/`condition.status`), allergies (`a.status`), etc., which are
// their own (single-axis) lifecycle tests and NOT goal liveness.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Directories scanned for production source.
const SCAN_DIRS = ["lib", "app", "components"];

// Files permitted to test a goal's status against "active" directly, each with a
// justification. PREFER routing a call site through isGoalLive over adding it here.
//  - lib/goals.ts is the helper's home: isGoalLive itself IS the `g.status ===
//    "active" && !g.archived` compare everyone else routes through.
const ALLOWLIST: { path: string; reason: string }[] = [
  {
    path: "lib/goals.ts",
    reason:
      'Defines the canonical isGoalLive predicate — the `g.status === "active" && ' +
      "!g.archived` compare is the source of truth this rule routes everyone toward.",
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

// Strip line and block comments so a mention of `g.status === "active"` in prose (a
// doc comment explaining the dual-axis rule) can't trip the scanner — only code counts.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// A goal identifier (`g` or `goal`) whose `.status` is compared, in EITHER order, with
// ==/===/!=/!== to the string literal "active"/'active'. The `\b(g|goal)` restriction
// is the precision boundary: it catches the goal-liveness antipattern while leaving the
// many `c.status`/`condition.status`/`a.status === "active"` lifecycle checks on other
// domains (conditions, allergies) untouched — those are single-axis and correct.
const OP = "(?:===|!==|==|!=)";
const LITERAL = `["']active["']`;
const GOAL_LEFT = new RegExp(
  `\\b(?:g|goal)\\.status\\s*${OP}\\s*${LITERAL}`,
  "g"
);
const GOAL_RIGHT = new RegExp(
  `${LITERAL}\\s*${OP}\\s*\\b(?:g|goal)\\.status\\b`,
  "g"
);

function goalActiveComparisons(text: string): string[] {
  const src = stripComments(text);
  const hits: string[] = [];
  for (const re of [GOAL_LEFT, GOAL_RIGHT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      hits.push(m[0].trim());
    }
  }
  return hits;
}

describe("goal liveness boundary (goal-liveness audit)", () => {
  it('no production module tests a goal status against "active" — liveness routes through isGoalLive', () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOWED.has(rel)) continue;
      const hits = goalActiveComparisons(text);
      if (hits.length > 0) offenders.push(`${rel}: ${hits.join(" ; ")}`);
    }
    expect(
      offenders,
      `These modules test a goal's status against "active" directly. Goal liveness is ` +
        `DUAL-AXIS (status === "active" AND !archived) — route it through isGoalLive(g) ` +
        `from @/lib/goals so the archived half can't be forgotten. If a comparison ` +
        `genuinely isn't a liveness decision, add it to the allowlist with a ` +
        `justification:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the canonical isGoalLive predicate exists in lib/goals.ts", () => {
    const src = fs.readFileSync(path.join(REPO, "lib/goals.ts"), "utf8");
    expect(/export function isGoalLive\b/.test(src)).toBe(true);
  });

  it("self-check: the scanner detects the antipattern it forbids", () => {
    expect(
      goalActiveComparisons(
        `const live = g.status === "active" && !g.archived;`
      )
    ).toHaveLength(1);
    expect(
      goalActiveComparisons(`if (goal.status !== 'active') continue;`)
    ).toHaveLength(1);
    expect(
      goalActiveComparisons(`const live = "active" === g.status;`)
    ).toHaveLength(1);
    // Not goal-liveness decisions → must NOT trip:
    expect(
      goalActiveComparisons(`const x = c.status === "active";`)
    ).toHaveLength(0);
    expect(
      goalActiveComparisons(`const x = condition.status === "active";`)
    ).toHaveLength(0);
    expect(
      goalActiveComparisons(`const x = a.status === "active";`)
    ).toHaveLength(0);
    expect(
      goalActiveComparisons(`const x = g.status === "achieved";`)
    ).toHaveLength(0);
    expect(goalActiveComparisons(`const live = isGoalLive(g);`)).toHaveLength(
      0
    );
  });
});

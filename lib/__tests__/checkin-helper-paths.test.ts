import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE CHECK-IN'S HELPER PATHS ARE ASSEMBLED AT RUN TIME, SO NO GREP CAN SEE THEM.
//
// #5158 renamed scripts/work/ to scripts/orchestration/ and five calls in
// scripts/orchestrator-checkin.sh went on naming the old directory. Nothing
// caught it and nothing there could have: not one of those calls contains the
// string `scripts/work` — the prefix comes from `$(dirname "$0")` when the
// script runs — so a rename sweep over the tree came back clean, and so did
// runbook-citation-scan.test.ts, which already checks every rooted path this
// same file cites but skips anything holding a `$`. Every call was `2>/dev/null`
// with a fallback, so all five failures arrived as ANSWERS: `?`, `ABSENT`,
// "queue snapshot FAILED (needs a read token)", and a ROSTER/LEDGER DIVERGENCE
// naming every live lane under a paragraph saying to fix the roster by hand
// (#5241).
//
// So this resolves the paths the way the shell does instead of matching them as
// text: expand `$(dirname "$0")` and the script's own assignments, then ask the
// filesystem. A grep for `work/` would pass the next rename; this will not.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = "scripts/orchestrator-checkin.sh";
const SOURCE = readFileSync(path.join(REPO, SCRIPT), "utf8");

/** A path the script names, with the line it is named on. */
type NamedPath = { line: number; token: string; resolved: string | null };

/**
 * Top-level `VAR=value` assignments — the only ones a helper path here is
 * built from. Indented assignments are inside branches and conditional, so
 * they are deliberately not treated as facts about the path.
 */
function assignments(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of source.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm)) {
    found.set(m[1], m[2].replace(/^"(.*)"$/, "$1"));
  }
  return found;
}

/**
 * The shell's expansion, as far as it goes statically: `$(dirname "$0")` is the
 * script's own directory and `$VAR` is its assignment. Returns null when
 * anything is left unexpanded — an unresolvable path is not a passing one,
 * because nothing can then check where it points.
 */
function expand(token: string, vars: Map<string, string>): string | null {
  const dir = path.posix.dirname(SCRIPT);
  let out = token;
  for (let pass = 0; pass < 5 && out.includes("$"); pass += 1) {
    out = out
      .replace(/\$\(dirname "\$0"\)/g, dir)
      .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) =>
        vars.has(name) ? (vars.get(name) as string) : whole
      );
  }
  return out.includes("$") ? null : out;
}

const LINE_OF = (source: string, index: number) =>
  source.slice(0, index).split("\n").length;

/**
 * Every token in the script that names a script FILE at run time — the `node`
 * arguments and the `runnable` guards alike, since a guard pointed at nothing
 * would answer "cannot ask" forever and read as honest while saying nothing.
 * Keyed on the extension, so `$STATE_DIR/.roster` and the other data paths
 * (which no static reading could resolve) are correctly not this test's claim.
 */
function namedScriptPaths(source: string): NamedPath[] {
  const vars = assignments(source);
  const pattern =
    /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\(dirname "\$0"\))(?:\/[A-Za-z0-9._@-]+)+\.(?:mjs|cjs|js|ts|sh)\b/g;
  return [...source.matchAll(pattern)].map((m) => ({
    line: LINE_OF(source, m.index),
    token: m[0],
    resolved: expand(m[0], vars),
  }));
}

/**
 * Every `node …` invocation, taken at a COMMAND position — after a line start,
 * a pipe, a `$(`, a `!` or a separator. Prose is full of the word ("no node on
 * PATH", "install the .nvmrc major"), and `command -v node` is a lookup rather
 * than a run; neither sits at a command position, which is what tells them
 * apart without an allowlist of sentences.
 */
function nodeInvocations(source: string): NamedPath[] {
  const vars = assignments(source);
  // The argument is a double-quoted string or a bare token, and the quoted form
  // may CONTAIN quotes — `"$(dirname "$0")/host.mjs"` is the spelling all five
  // #5241 sites used. A `[^"]+` argument pattern stops at that inner quote and
  // silently drops the very invocations this test is named for, so the
  // substitution is matched as a unit.
  const pattern =
    /(?:^|[;|&(]|!)[ \t]*node[ \t]+(?:"((?:\$\([^)]*\)|[^"])*)"|(\S+))/gm;
  return [...source.matchAll(pattern)]
    .map((m) => ({ index: m.index, token: m[1] ?? m[2] }))
    .filter(({ token }) => token.includes("/"))
    .map(({ index, token }) => ({
      line: LINE_OF(source, index),
      token,
      resolved: expand(token, vars),
    }));
}

const NAMED = namedScriptPaths(SOURCE);
const INVOCATIONS = nodeInvocations(SOURCE);

describe(`${SCRIPT} names only helpers that exist`, () => {
  // Non-vacuity: the enumerator finding nothing would pass every assertion
  // below while checking no path at all, which is the shape this file exists
  // to forbid elsewhere. Five call sites is what #5241 measured.
  it("enumerates the invocations it is about to check", () => {
    expect(INVOCATIONS.length).toBeGreaterThanOrEqual(5);
    expect(NAMED.length).toBeGreaterThanOrEqual(INVOCATIONS.length);
  });

  it.each(NAMED)("line $line: $token exists", ({ token, resolved }) => {
    // A path built from something this cannot expand is a FAILURE, not a skip:
    // it is exactly the path nobody can check, which is how five of them went
    // four hours pointing at a directory that had been renamed.
    expect(resolved, `${token} cannot be resolved statically`).not.toBeNull();
    expect(
      existsSync(path.join(REPO, resolved as string)),
      `${token} resolves to ${resolved}, which does not exist`
    ).toBe(true);
  });

  // Every `node` call must go through a path shape the check above can see, or
  // the next call site escapes it simply by being spelled differently.
  it.each(INVOCATIONS)("line $line: node $token is checked", ({ token }) => {
    expect(NAMED.map((n) => n.token)).toContain(token);
  });
});

// PROVE THE READER CAN SEE. A green sweep over a complying script says nothing
// about what the sweep is able to notice, so these run it over sources written
// to break it — including the exact pre-fix spelling, which is the one case we
// know it has to catch.
describe("the reader reports a helper path that is not there", () => {
  const broken = [
    ["the #5241 spelling", 'node "$(dirname "$0")/work/host.mjs" state-dir'],
    [
      "a renamed helper",
      'HELPERS="$(dirname "$0")/orchestration"\nnode "$HELPERS/gone.mjs"',
    ],
    [
      "a guard with no run",
      'HELPERS="$(dirname "$0")/orchestration"\nrunnable "$HELPERS/gone.mjs"',
    ],
  ] as const;

  it.each(broken)("%s", (_name, source) => {
    const named = namedScriptPaths(source);
    expect(named.length).toBeGreaterThan(0);
    expect(
      named.every((n) => n.resolved && existsSync(path.join(REPO, n.resolved)))
    ).toBe(false);
  });

  it("refuses a path it cannot expand rather than passing it", () => {
    const [only] = nodeInvocations('node "$SOMEWHERE/host.mjs"');
    expect(only.resolved).toBeNull();
  });

  // And it stays quiet on the shapes that are correct, because a reader that
  // cried wolf on the script's data paths would be widened until it saw
  // nothing. `$STATE_DIR/.roster` is not a script and is not its business.
  it("says nothing about the data paths", () => {
    expect(
      namedScriptPaths('LEDGER="$STATE_DIR/allos-dispatch-ledger.jsonl"')
    ).toEqual([]);
    expect(nodeInvocations("command -v node >/dev/null 2>&1")).toEqual([]);
  });
});

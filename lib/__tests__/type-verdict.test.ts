import ts from "typescript-api";
import { describe, expect, it } from "vitest";

// VITEST PASSING IS NOT A TYPE VERDICT, and #5150 is the receipt: `main` was red on
// `check`, `seed` and `build` for two merges while `test-unit` and `test-db` were
// green the whole time, on a type error sitting inside a file the DB tier runs.
//
// Vitest transpiles; it never asks the checker anything. So the tier that OWNS a
// test file cannot see a type break in it, and no amount of running that tier
// harder will change the answer. `npm run typecheck` is the only thing in this
// repo that gives a type verdict, and it is a gate (agent-gates.sh runs it before
// every push; CI's `check` job runs it on every PR) rather than a tier.
//
// Two shapes are pinned here because both were argued about on #5150 and both are
// claims about the TOOLCHAIN, not about our code — so they are checked over tiny
// synthetic programs rather than over the tree. Neither reads a repo source file:
// this is a proof, not a scanner.
//
//   1. The DEPENDENT case. The break lives in a file the change never touched, so
//      a check scoped to changed files reports nothing. That is why #5150's scope
//      rules out a changed-files-only command.
//   2. The COMBINED-TREE case. Each branch typechecks clean on its own base and
//      only their merge is invalid — which is exactly what happened between #5129
//      and #5138 — so no per-branch check of any kind, tier-side or gate-side,
//      could have caught it. Only a check of the merged tree can.
//
// The measured cost of moving (1) into `npm test` / `npm run test:db`, and why it
// was not done, is in docs/internals/verification-failure-modes.md.

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  // No lib.d.ts: these programs use only intrinsic types, so the checker starts in
  // milliseconds instead of parsing the standard library on every case.
  noLib: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

function typeErrors(files: Record<string, string>): string[] {
  const host: ts.CompilerHost = {
    fileExists: (name) => name in files,
    readFile: (name) => files[name],
    getSourceFile: (name) =>
      name in files
        ? ts.createSourceFile(name, files[name], ts.ScriptTarget.ES2020, true)
        : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(Object.keys(files), OPTIONS, host);
  return program
    .getSemanticDiagnostics()
    .map(
      (d) =>
        `${d.file?.fileName ?? "?"}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`
    );
}

// #5129's shape, reduced: an exported type gains a required member.
const SWITCH_BASE = `export interface TimezoneSwitch { at: string; from: string; to: string; }`;
const SWITCH_WITH_KIND = `export interface TimezoneSwitch { at: string; from: string; to: string; kind: string; }`;
// #5138's shape, reduced: a fixture in ANOTHER file writes the literal without it.
const FIXTURE = `import type { TimezoneSwitch } from "./travel";
export const sw: TimezoneSwitch = { at: "a", from: "b", to: "c" };`;

describe("a type error in a test file", () => {
  it("is invisible to a transpile, which is all a vitest run does", () => {
    const source = `const n: string = 1;`;
    // esbuild is not tsc, but it is the same contract: syntax in, JavaScript out,
    // no checker consulted. `transpileModule` is the checker-free path in the
    // compiler we already depend on, so the claim is checkable here.
    const emitted = ts.transpileModule(source, { compilerOptions: OPTIONS });
    expect(emitted.diagnostics ?? []).toEqual([]);
    expect(emitted.outputText).toContain("const n = 1");

    // The same source, asked properly, is an error. Nothing about the file changed.
    expect(typeErrors({ "/x.ts": source })).toHaveLength(1);
  });

  it.each<{ case: string; files: Record<string, string>; errors: number }>([
    // The change alone — what a changed-files-only check would be given.
    {
      case: "only the changed file",
      files: { "/travel.ts": SWITCH_WITH_KIND },
      errors: 0,
    },
    // The dependent alone, against the OLD type — what #5138's own CI checked.
    {
      case: "only the dependent, on its own base",
      files: { "/travel.ts": SWITCH_BASE, "/fixture.test.ts": FIXTURE },
      errors: 0,
    },
    // Both, which is the tree that reaches `main`.
    {
      case: "the combined tree",
      files: { "/travel.ts": SWITCH_WITH_KIND, "/fixture.test.ts": FIXTURE },
      errors: 1,
    },
  ])("$case reports $errors error(s)", ({ files, errors }) => {
    expect(typeErrors(files)).toHaveLength(errors);
  });

  it("is reported in the DEPENDENT file, not in the file that changed", () => {
    const [message] = typeErrors({
      "/travel.ts": SWITCH_WITH_KIND,
      "/fixture.test.ts": FIXTURE,
    });
    expect(message).toContain("/fixture.test.ts");
    expect(message).toContain("kind");
  });
});

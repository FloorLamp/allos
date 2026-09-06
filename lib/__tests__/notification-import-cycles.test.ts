// PURE TIER — no module in `lib/notifications` may import itself back at RUNTIME
// (issue #2961, AC 3).
//
// The cycle this guard was written for was real and shipped: `callback-data.ts` imported
// `INTAKE_SEND_SLOTS` from `intake-format.ts`, which imported `callbackDataFits` and
// `MED_STOP_PREFIX` back. #5169 recorded that the callback registry had removed it; it
// had not, and nothing could tell, because no test in the repo looked.
//
// WHY A CYCLE HERE COSTS SOMETHING, rather than being untidy. A module in a cycle cannot
// be split without its partner coming with it, so every later step of #2961 — per-family
// token modules, then per-family handler modules — sits behind this edge being cut. And
// at runtime an import cycle means one of the two modules evaluates against a partially
// initialised partner: a `const` read at module scope during that window is `undefined`,
// which in this directory would be a callback prefix or a byte budget.
//
// ── VALUE IMPORTS ONLY, AND THAT IS THE WHOLE JUDGEMENT ──────────────────────
// `import type` is erased before anything runs, so a type-only edge cannot produce the
// initialisation-order failure above and is not a cycle in the sense that matters. Three
// such edges exist in this directory today and this guard deliberately does not count
// them:
//
//   callback-data.ts -> reconcile-registry.ts -> callback-data.ts
//   callback-data.ts -> telegram.ts -> compose.ts -> usual-routine-attach.ts -> …
//   callback-data.ts -> telegram.ts -> compose.ts -> usual-routine-plan.ts -> …
//
// They are named here so a reader who runs a general-purpose cycle finder and sees three
// answers does not conclude this guard is broken. If a later step of #2961 wants them
// gone as well, that is a separate argument about layering, not about correctness.
//
// ── THE FIRST VERSION OF THIS DETECTOR ANSWERED "NO CYCLE" ON A TREE THAT HAD ONE ──
// Its import pattern was `import\s+(type\s+)?([\s\S]*?)from\s+"\./…"`, and `[\s\S]*?`
// happily spans intervening statements — so a plain `import { … }` twelve lines below an
// `import type { … }` was read as type-only and dropped. It reported zero cycles on the
// exact tree the issue documents one on. `[^;]*?` with a line anchor is what keeps one
// import statement from borrowing another's keyword, and `detects a cycle it is shown`
// below is what keeps this file from ever again being a guard that cannot fail.
//
// ── AND THE COMMENT STRIPPER IS THE SHARED ONE ───────────────────────────────
// The second draft hand-rolled the ordered pair of regexes that #3087 exists to stop:
// block comments first, so a `/*` inside an ordinary `//` sentence swallows everything
// up to the next unrelated `*/`. `strip-comments.test.ts` caught it by census, which is
// the guard working — and it would have mattered here, because this file's own header
// contains both a `/*` and a `\/\/` inside prose.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments";

const DIR = join(process.cwd(), "lib/notifications");

/**
 * The sibling modules `source` imports for their VALUES.
 *
 * Skips `import type …` and an import whose every specifier is individually `type`-
 * marked; keeps a mixed one, because a single value specifier is a real edge.
 */
export function valueImports(source: string): string[] {
  const out = new Set<string>();
  const text = stripComments(source);
  for (const m of text.matchAll(
    /^import\s+(type\s+)?([^;]*?)\bfrom\s+"\.\/([A-Za-z0-9._-]+)"/gm
  )) {
    if (m[1]) continue;
    const body = m[2].trim();
    const inner = body.startsWith("{")
      ? body.slice(1, body.lastIndexOf("}"))
      : "";
    if (inner.trim()) {
      const parts = inner
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (parts.length > 0 && parts.every((x) => /^type\s/.test(x))) continue;
    }
    out.add(m[3].endsWith(".ts") ? m[3] : `${m[3]}.ts`);
  }
  // A side-effect import runs the module, so it is a value edge with no specifiers.
  for (const m of text.matchAll(/^import\s+"\.\/([A-Za-z0-9._-]+)"/gm))
    out.add(m[1].endsWith(".ts") ? m[1] : `${m[1]}.ts`);
  return [...out];
}

/** Every cycle in a module graph, each printed as the path that closes it. */
export function cyclesIn(graph: Map<string, readonly string[]>): string[] {
  const found = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const walk = (node: string, stack: string[]): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1)
        found.add([...stack.slice(stack.indexOf(next)), next].join(" -> "));
      else if (!state.has(next)) walk(next, stack);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of [...graph.keys()].sort())
    if (!state.has(node)) walk(node, []);
  return [...found];
}

function notificationGraph(): Map<string, string[]> {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(join(DIR, file), "utf8");
    graph.set(
      file,
      valueImports(source).filter((t) => files.includes(t) && t !== file)
    );
  }
  return graph;
}

describe("lib/notifications has no runtime import cycle (#2961)", () => {
  it("finds none", () => {
    expect(cyclesIn(notificationGraph())).toEqual([]);
  });

  it("detects a cycle it is shown", () => {
    // The guard above is only worth its line count if it can fail, and its first draft
    // could not — see the header. This is that property, asserted directly.
    expect(
      cyclesIn(
        new Map([
          ["a.ts", ["b.ts"]],
          ["b.ts", ["a.ts"]],
        ])
      )
    ).toEqual(["a.ts -> b.ts -> a.ts"]);
  });

  it("reads a mixed import as a value edge and a type-only one as no edge", () => {
    // The distinction the whole guard rests on, and the shape that broke the first
    // detector: a value import sitting below a type import in the same file.
    const source = [
      'import type { Foo } from "./types";',
      'import { INTAKE_SEND_SLOTS, type IntakeSendSlot } from "./intake-format";',
      'import { type OnlyAType, type AlsoAType } from "./formats";',
      'import "./side-effect";',
    ].join("\n");
    expect(valueImports(source).sort()).toEqual([
      "intake-format.ts",
      "side-effect.ts",
    ]);
  });

  it("does not read a path named in a comment as an import", () => {
    const source = [
      '// see `import { x } from "./callback-data"` for the token shape',
      '/* import { y } from "./telegram"; */',
      'import { real } from "./compose";',
    ].join("\n");
    expect(valueImports(source)).toEqual(["compose.ts"]);
  });
});

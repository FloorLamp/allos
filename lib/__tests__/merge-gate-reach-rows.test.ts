import { describe, expect, it } from "vitest";
import {
  changedDerivations,
  reachVerdict,
  tallyLine,
} from "../../scripts/orchestration/merge-gate-core.mjs";

// WHICH DECLARATIONS THE REACH ROW WALKS, AND WHAT A DECLINE SAYS (#5710).
//
// The merge gate's reach row selects symbols from the PR's patches. Its first
// live uses found two ways a correct walker prints a misleading row: a pure
// move (#5714 split one file into six with every declaration verbatim, and
// each removed declaration counted as a change — twenty rows, capped from 74),
// and a symbol the PR itself introduces, walked from a tree that predates it
// (#5715), which read as if the author had named a symbol that does not
// exist. The fixtures here are the patch shapes of those two PRs, reduced.

const patch = (header: string, lines: string[]) =>
  [header, ...lines].join("\n");

const F_BODY = [
  "export function f(a: number) {",
  "  const b = a + 1;",
  "  return b;",
  "}",
];
const OLD_FILE = "lib/queries/metrics.ts";
const NEW_FILE = "lib/queries/metrics/body.ts";

const removedFrom = (file: string, body = F_BODY) => ({
  filename: file,
  status: "modified",
  patch: patch("@@ -1,6 +1,2 @@", [
    ' import { x } from "./x";',
    ...body.map((l) => `-${l}`),
    "-",
    " export const h = 2;",
  ]),
});
const addedTo = (file: string, body = F_BODY) => ({
  filename: file,
  status: "added",
  patch: patch("@@ -0,0 +1,5 @@", [
    ...body.map((l) => `+${l}`),
    "+",
    "+export const g = 1;",
  ]),
});

const declinedAs = (message: string) => () => {
  throw new Error(message);
};

describe("changedDerivations", () => {
  it("skips a declaration moved verbatim to another file (#5714)", () => {
    expect(
      changedDerivations([removedFrom(OLD_FILE), addedTo(NEW_FILE)])
    ).toEqual([{ file: NEW_FILE, symbol: "g", added: true }]);
  });

  it("treats a whitespace-only difference as the same declaration", () => {
    const reflowed = F_BODY.map((l) => l.replace("a + 1", "a  +  1"));
    expect(
      changedDerivations([removedFrom(OLD_FILE), addedTo(NEW_FILE, reflowed)])
    ).toEqual([{ file: NEW_FILE, symbol: "g", added: true }]);
  });

  it("keeps a moved declaration whose body changed on the way", () => {
    const edited = F_BODY.map((l) => l.replace("a + 1", "a + 2"));
    expect(
      changedDerivations([removedFrom(OLD_FILE), addedTo(NEW_FILE, edited)])
    ).toEqual([
      { file: OLD_FILE, symbol: "f", added: false },
      { file: NEW_FILE, symbol: "f", added: true },
      { file: NEW_FILE, symbol: "g", added: true },
    ]);
  });

  it("keeps an edit in place, and knows it is not an addition", () => {
    const inPlace = {
      filename: OLD_FILE,
      status: "modified",
      patch: patch("@@ -1,4 +1,4 @@", [
        "-export function f(a: number) {",
        "+export function f(a: number, c = 0) {",
        "   const b = a + 1;",
        "-  return b;",
        "+  return b + c;",
        " }",
      ]),
    };
    expect(changedDerivations([inPlace])).toEqual([
      { file: OLD_FILE, symbol: "f", added: false },
    ]);
  });

  it("selects nothing from a barrel re-export alone", () => {
    const barrel = {
      filename: OLD_FILE,
      status: "modified",
      patch: patch("@@ -1,2 +1,3 @@", [
        ' export * from "./metrics/samples";',
        '+export * from "./metrics/body";',
        ' export * from "./metrics/hr";',
      ]),
    };
    expect(changedDerivations([barrel])).toEqual([]);
  });
});

describe("reachVerdict declines", () => {
  const walkedOn = "7c0104fa2100b36380c734da6ff29dc8da04eb15";
  const decline = `${NEW_FILE} declares no top-level \`g\`; it has: f`;

  it("names the walked tree and says when the PR itself adds the symbol (#5715)", () => {
    expect(
      reachVerdict({
        files: [removedFrom(OLD_FILE), addedTo(NEW_FILE)],
        body: "",
        reachFn: declinedAs(decline),
        walkedOn,
      })
    ).toEqual([
      `reach — could not answer for g (walked on 7c0104fa): ${decline}; ` +
        "g is added by this PR and is not on the walked tree; resolve on the PR head or merge tree",
    ]);
  });

  it("names only the tree for a symbol the base already has", () => {
    const edited = F_BODY.map((l) => l.replace("a + 1", "a + 2"));
    const rows = reachVerdict({
      files: [removedFrom(OLD_FILE, edited)],
      body: "",
      reachFn: declinedAs(decline),
      walkedOn,
    });
    expect(rows).toEqual([
      `reach — could not answer for f (walked on 7c0104fa): ${decline}`,
    ]);
  });
});

// THE TALLY LINE THE GATE PASTES FOR THE PERSON (#5710).
//
// The promotion bar counts one-line tallies a landing session posts on #5710.
// In the 43 merges after the count was declared to start, 27 fed the walker
// 198 symbols and zero tallies were recorded, because the step asked a person
// to notice an advisory NOTE and then post on another issue at the moment they
// were about to merge. The gate writes the line now; the blank at the end —
// was the row right — is the part that stays human. The rows here come from
// `reachVerdict` itself rather than hand-written strings, so a reworded row
// cannot leave the tally reading the old shape.

const edited = (file: string, symbol: string) => ({
  filename: file,
  status: "modified",
  patch: patch("@@ -1,3 +1,3 @@", [
    `-export function ${symbol}(a: number) {`,
    `+export function ${symbol}(a: number, c = 0) {`,
    "   return a;",
    " }",
  ]),
});

const TABLE = [
  "| consumer | via |",
  "| --- | --- |",
  "| app/page.tsx | direct |",
  "| app/log/page.tsx | direct |",
].join("\n");

const reaches = (terminals: Record<string, string[]>) => (file: string) => ({
  terminals: terminals[file] ?? [],
});

describe("the tally line (#5710)", () => {
  it("names the PR and every row, and is one pasteable line", () => {
    const rows = reachVerdict({
      files: [edited("lib/a.ts", "alpha"), edited("lib/b.ts", "beta")],
      body: `Body.\n\n${TABLE}`,
      reachFn: reaches({
        "lib/a.ts": ["page app/page.tsx alpha", "page app/log/page.tsx alpha"],
        "lib/b.ts": ["page app/hidden/page.tsx beta"],
      }),
    });
    expect(rows).toHaveLength(2);
    const line = tallyLine({ prNumber: "5821", rows });
    expect(line).toBe(
      "TALLY #5710 — PR #5821: 2 reach row(s); " +
        "lib/a.ts#alpha → 2 terminal(s), all named; " +
        "lib/b.ts#beta → 1 terminal(s), 1 not named — right/wrong?"
    );
    expect(line).not.toContain("\n");
  });

  it("prints NOTHING when no reach row printed", () => {
    // The control the ruling names. Reached through the state where the line
    // could appear: a real `lib/` derivation changed and walked — the walk
    // just found no terminal, so `reachVerdict` prints no row and there is
    // nothing to tally. A line here would land on nearly every merge and be
    // ignored exactly the way the NOTE was.
    const rows = reachVerdict({
      files: [edited("lib/a.ts", "alpha")],
      body: "",
      reachFn: reaches({}),
    });
    expect(rows).toEqual([]);
    expect(tallyLine({ prNumber: "5821", rows })).toBeNull();
    expect(tallyLine({ prNumber: "5821", rows: [] })).toBeNull();
  });

  it("keeps a decline apart from an answer", () => {
    // A tally of declines is not a tally of clean rows, and the bar counts
    // clean rows. The header splits the count so the distinction survives the
    // truncation below.
    const rows = reachVerdict({
      files: [edited("lib/a.ts", "alpha"), edited("lib/b.ts", "beta")],
      body: "",
      reachFn: (file: string) => {
        if (file === "lib/b.ts") throw new Error("lib/b.ts declares no `beta`");
        return { terminals: ["page app/page.tsx alpha"] };
      },
      walkedOn: "7c0104fa2100b36380c734da6ff29dc8da04eb15",
    });
    expect(tallyLine({ prNumber: "5821", rows })).toBe(
      "TALLY #5710 — PR #5821: 2 reach row(s) (1 answer(s), 1 decline(s)); " +
        "lib/a.ts#alpha → 1 terminal(s), no consumer table; " +
        "beta → could not answer — right/wrong?"
    );
  });

  it("does not count the cap row, which names no symbol", () => {
    // The cap row says the walk was truncated at 20; it makes no claim about
    // what any symbol reaches, so there is no "was it right" for a person to
    // answer about it. Counting it would inflate the denominator with rows
    // that can never be clean rows, and a diff that produces ONLY the cap row
    // — 21 candidates, none with a terminal — gets no line at all.
    const sweep = {
      filename: "lib/wide.ts",
      status: "modified",
      patch: patch(
        "@@ -1,0 +1,21 @@",
        Array.from({ length: 21 }, (_, i) => `+export const s${i + 1} = ${i};`)
      ),
    };
    const capOnly = reachVerdict({
      files: [sweep],
      body: "",
      reachFn: reaches({}),
    });
    expect(capOnly).toHaveLength(1);
    expect(capOnly[0]).toContain("only the first 20");
    expect(tallyLine({ prNumber: "5821", rows: capOnly })).toBeNull();

    const withRows = reachVerdict({
      files: [sweep],
      body: "",
      reachFn: () => ({ terminals: ["page app/page.tsx s"] }),
    });
    expect(withRows).toHaveLength(21);
    const line = tallyLine({ prNumber: "5821", rows: withRows });
    expect(line).toContain("PR #5821: 20 reach row(s); ");
    expect(line).toContain("lib/wide.ts#s1 → 1 terminal(s), no consumer table");
    expect(line).toContain("; +16 more — right/wrong?");
    expect(line).not.toContain("only the first");
  });
});

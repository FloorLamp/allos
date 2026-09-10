import { describe, expect, it } from "vitest";
import {
  changedDerivations,
  reachVerdict,
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

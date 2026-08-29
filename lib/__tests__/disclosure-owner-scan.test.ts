import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";

// ONE DISCLOSURE (#3677), in the repo's source-scan idiom.
//
// Before this, 47 files each wrote their own `<details>` and every one of them snapped
// open. They now all render `components/Disclosure.tsx`, which carries the continuity
// motion (#3676), the marker suppression and the `group` its adopters' chevrons read. A
// raw `<details>` anywhere else is a fold that silently opts out of all three, and it is
// the only way that can happen — so the boundary is here.
//
// IT IS A MODULE IDENTITY, NOT AN ALLOWLIST. The expectation is set EQUALITY against
// one name: the module that IS the disclosure. There is no path exception, no
// occurrence count, and no "this one is fine because" — and the equality fails in
// BOTH directions, so the owner quietly ceasing to render the element fails here too,
// rather than leaving a boundary guarding nothing.
//
// AND IT IS SHALLOW ON PURPOSE. It reads text, it does not reconstruct flow: a file
// that builds a `<details>` through `React.createElement` is not something this can see,
// and pretending otherwise by growing a parser is how a guard becomes the thing that
// needs maintaining. What it does catch is the way this repo actually writes the
// construct, which is JSX — the spelling all 47 of them used, and the only one the
// census over `origin/main` found.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

/** The module that IS the disclosure. */
const DISCLOSURE_OWNER = "components/Disclosure.tsx";

/** Whether this source RENDERS a raw `<details>`, as opposed to talking about one. */
export function rendersRawDetails(src: string): boolean {
  // Through the SHARED stripper, not a hand-rolled pair of regexes — several of these
  // files explain in prose why the element was chosen, and a guard that reads its own
  // documentation as evidence cries wolf until somebody deletes it. `stripComments`
  // already knows about JSX children, template literals and regex literals, which is
  // more than a boundary this shallow would ever get right on its own (#3595).
  return /<details[\s>/]/.test(stripComments(src));
}

function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) found.push(rel);
    }
  };
  for (const dir of SCAN_DIRS) walk(dir);
  return found.sort();
}

describe("the app has one disclosure", () => {
  it("renders a raw <details> in exactly the module that is the disclosure", () => {
    const rendering = sources().filter((rel) =>
      rendersRawDetails(fs.readFileSync(path.join(REPO, rel), "utf8"))
    );
    expect(rendering).toEqual([DISCLOSURE_OWNER]);
  });

  it.each([
    ['<details className="card">', true, "the ordinary one-line opening tag"],
    ["<details>\n  <summary>x</summary>\n</details>", true, "no attributes"],
    ["  <details\n    open\n  >", true, "attributes wrapped over lines"],
    ["{cond ? <details>a</details> : null}", true, "inline in an expression"],
    ["// a native <details>, so it works with JS off", false, "a line comment"],
    ["/* the old <details> version */", false, "a block comment"],
    ["{/* an empty <details> never renders */}", false, "a JSX comment"],
    [
      'const html = "<details>";',
      true,
      "a string literal — the shared stripper keeps strings, and a fold emitted as raw HTML is still a fold outside the owner",
    ],
    ["<Disclosure>y</Disclosure>", false, "the owner's own element"],
    [
      "<detailsPanel />",
      false,
      "a component whose name merely starts the same",
    ],
  ])("sees %s → %s (%s)", (source: string, expected: boolean) => {
    // A green sweep over a COMPLYING tree says nothing about what the sweep can
    // see (#3325), so the cases that must FAIL it are run through the same
    // function the census above uses — and so are the benign neighbours it must
    // stay silent on, which in this repo are load-bearing prose.
    expect(rendersRawDetails(source)).toBe(expected);
  });
});

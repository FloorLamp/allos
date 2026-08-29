import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ONE DISCLOSURE (#3677), in the repo's source-scan idiom.
//
// Before this, ~50 files each wrote their own `<details>` and every one of them
// snapped open. They now all render `components/Disclosure.tsx`, which carries the
// continuity motion (#3676), the marker suppression and the `group` its adopters'
// chevrons read. A raw `<details>` anywhere else is a fold that silently opts out of
// all three, and it is the only way that can happen — so the boundary is here.
//
// IT IS A MODULE IDENTITY, NOT AN ALLOWLIST. The expectation is set EQUALITY against
// one name: the module that IS the disclosure. There is no path exception, no
// occurrence count, and no "this one is fine because" — and the equality fails in
// BOTH directions, so the owner quietly ceasing to render the element fails here too,
// rather than leaving a boundary guarding nothing.
//
// AND IT IS SHALLOW ON PURPOSE. It reads text, it does not reconstruct flow: a file
// that builds a `<details>` through `React.createElement` or a string of HTML is not
// something this can see, and pretending otherwise by growing a parser is how a guard
// becomes the thing that needs maintaining. What it does catch is the way this repo
// actually writes the construct, which is JSX, in all ~50 places it was written.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

/** The module that IS the disclosure. */
const DISCLOSURE_OWNER = "components/Disclosure.tsx";

/**
 * Blank out comments and string/template literals, preserving offsets, so a
 * `<details>` MENTIONED in prose — and several files explain why the element was
 * chosen — is never read as one being rendered. A guard that cried wolf on those
 * would be deleted inside a week, taking the real guard with it.
 */
function withoutProse(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Whether this source RENDERS a raw `<details>`, as opposed to talking about one. */
export function rendersRawDetails(src: string): boolean {
  return /<details[\s>/]/.test(withoutProse(src));
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
    ['const html = "<details>";', false, "a string literal"],
    [
      '<Disclosure summary="x">y</Disclosure>',
      false,
      "the owner's own element",
    ],
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

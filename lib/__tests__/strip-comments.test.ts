import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";

// THE SCANNER THE REPOSITORY CENSUSES READ SOURCE THROUGH (#3087).
//
// There was no direct test of it, which is why a defect in it survived three rounds
// of review on the PR that shipped it: every census that used it stayed green,
// because a comment stripper that deletes too much makes findings DISAPPEAR. A guard
// reading through a broken stripper reports a pass it never took, and its own suite
// agrees. So the stripper is pinned here, on its own, with the real shapes this tree
// contains rather than with toy input.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const lineOf = (src: string, n: number) => src.split("\n")[n - 1];

describe("what it strips and what it must not", () => {
  it("does not let a `/*` inside a LINE comment open a block comment", () => {
    // THE DEFECT THIS FILE EXISTS FOR. Stripping block comments first made the `/*`
    // in an ordinary English sentence swallow everything up to the next unrelated
    // `*/` in the file.
    const src = [
      "// presentational sections → components/activity-form/*: Header,",
      "const stamp = useLoggedViaStamp();",
      "const re = /x/; /* a real block comment */",
      "const after = 1;",
    ].join("\n");
    const out = stripComments(src);
    expect(lineOf(out, 2)).toBe("const stamp = useLoggedViaStamp();");
    expect(lineOf(out, 4)).toBe("const after = 1;");
    expect(out).not.toContain("activity-form");
    expect(out).not.toContain("a real block comment");
  });

  it("does not let a `//` inside a STRING start a line comment", () => {
    const src = [
      'const url = "https://example.com/a";',
      "const q = 'x // not a comment';",
      "const kept = 1;",
    ].join("\n");
    const out = stripComments(src);
    expect(out).toBe(src);
  });

  it("does not let a `//` inside a REGEX start a line comment", () => {
    // Verbatim the shape the old two-regex stripper was written as: the escaped
    // slash immediately before the closing slash reads as `//` to a scanner that
    // does not know it is inside a regex, and the rest of the line disappears.
    const src = "const block = /\\/\\*[\\s\\S]*?\\*\\//g; const kept = 1;";
    expect(stripComments(src)).toBe(src);
  });

  it("does not let a `/*` inside a REGEX open a block comment", () => {
    const src = [
      "const cls = /[/*]/;",
      "const kept = 1;",
      "const later = 2; /* real */",
    ].join("\n");
    const out = stripComments(src);
    expect(lineOf(out, 1)).toBe("const cls = /[/*]/;");
    expect(lineOf(out, 2)).toBe("const kept = 1;");
    expect(out).not.toContain("real");
  });

  it("does not let a `//` or a `/*` inside a TEMPLATE become a comment", () => {
    const src = [
      "const t = `see https://example.com/${id} /* not a comment`;",
      "const kept = 1;",
    ].join("\n");
    expect(stripComments(src)).toBe(src);
  });

  it("scans code inside a template's `${…}` interpolation", () => {
    const src = "const t = `a${/* gone */ b}c`; const kept = 1;";
    const out = stripComments(src);
    expect(out).not.toContain("gone");
    expect(out).toContain("const kept = 1;");
    expect(out).toHaveLength(src.length);
  });

  it("strips a block comment that CONTAINS a `//`", () => {
    const src = [
      "/*",
      " * see https://example.com/x // and a line comment inside",
      " */",
      "const kept = 1;",
    ].join("\n");
    const out = stripComments(src);
    expect(out.trim()).toBe("const kept = 1;");
  });

  it("leaves a JSX closing tag and a JSX block comment alone", () => {
    // `</div>` puts a `/` after `<`, and a self-closing tag followed by `{/* … */}`
    // puts one after `}`. Reading either as a regex opener would run to the next `/`
    // on the line and step over the real comment behind it.
    const src = [
      "const a = (",
      "  <div>",
      "    <Foo bar={1} /> {/* gone */}",
      "  </div>",
      "); // also gone",
      "const kept = 1;",
    ].join("\n");
    const out = stripComments(src);
    expect(lineOf(out, 3)).toBe("    <Foo bar={1} /> {          }");
    expect(lineOf(out, 4)).toBe("  </div>");
    expect(lineOf(out, 5)).toBe(");             ");
    expect(lineOf(out, 6)).toBe("const kept = 1;");
  });

  it("still reads a regex where one genuinely follows an operator or a keyword", () => {
    const src = [
      "const m = s.replace(/a\\/\\/b/, x);",
      "if (typeof s === 'string') return /a\\/\\/b/.test(s);",
      "const f = () => /a\\/\\/b/.test(s);",
      "const kept = 1;",
    ].join("\n");
    expect(stripComments(src)).toBe(src);
  });

  it("keeps every byte offset and every line number", () => {
    // Byte-for-byte length is what lets a census report `file:line` from the
    // stripped source and mean the line in the real file.
    for (const rel of [
      "components/ActivityForm.tsx",
      "lib/notify-log-format.ts",
      "lib/migrations/snapshot-policy.ts",
      "lib/card-meta-value-census.ts",
    ]) {
      const src = read(rel);
      const out = stripComments(src);
      expect(out, rel).toHaveLength(src.length);
      expect(out.split("\n"), rel).toHaveLength(src.split("\n").length);
    }
  });
});

describe("the four spans the old stripper deleted", () => {
  // Every `/*` in the census universe (app/**, components/**, lib/**, minus the test
  // tiers) that sits inside an ordinary `//` sentence. Under the pair of ordered
  // regexes this replaced, each one opened a block comment that ran to the next
  // unrelated `*/` in the file. Re-derived by diffing the two strippers over the
  // tracked tree; the lines below are the first real code inside each deleted span:
  //
  //   components/ActivityForm.tsx:108      deleted through :1352 — 843 lines
  //   lib/notify-log-format.ts:76          deleted through :180  —  60 lines
  //   lib/migrations/snapshot-policy.ts:30 deleted through :97   —  10 lines
  //   lib/card-meta-value-census.ts:139    closed on its own line —  0 lines
  //
  // The fourth is here because it is the same defect and would swallow the file the
  // day someone deletes the `*/` later on that line; it is listed with its measured
  // zero so the count is not inflated.
  const SURVIVORS: [string, number, string][] = [
    ["components/ActivityForm.tsx", 220, "useLoggedViaStamp"],
    ["lib/notify-log-format.ts", 82, "NOTIFY_DECLINE_MESSAGES"],
    ["lib/migrations/snapshot-policy.ts", 64, "MIGRATION_SNAPSHOT_KEEP"],
    ["lib/card-meta-value-census.ts", 144, "test(container)"],
  ];

  it.each(SURVIVORS)("keeps %s:%d as code", (rel, line, needle) => {
    const out = stripComments(read(rel));
    expect(lineOf(out, line)).toContain(needle);
    // …and the line is byte-identical to the real file: nothing on it was a comment.
    expect(lineOf(out, line)).toBe(lineOf(read(rel), line));
  });

  it("finds NO phantom block comment anywhere in the tree", () => {
    // The general form, so a fifth one cannot be written tomorrow: a `/*` that the
    // scanner says is inside a line comment must never be treated as an opener. Read
    // as an assertion about the SCANNER — every `/*` the naive regex would match is
    // either real, or the scanner has already blanked the `//` that precedes it on
    // its own line and blanks only to the end of that line.
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".next") continue;
          out.push(...walk(p));
        } else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
      }
      return out;
    };
    const bad: string[] = [];
    for (const sub of ["app", "components", "lib"]) {
      for (const abs of walk(path.join(REPO, sub))) {
        const src = fs.readFileSync(abs, "utf8");
        const clean = stripComments(src);
        for (const m of src.matchAll(/\/\*/g)) {
          const at = m.index;
          const ls = src.lastIndexOf("\n", at) + 1;
          if (!src.slice(ls, at).includes("//")) continue;
          if (clean.slice(ls, at).includes("//")) continue;
          // A `/*` inside a line comment. The scanner must have blanked it, and
          // must have stopped at the end of that line.
          const eol = src.indexOf("\n", at);
          const rel = path.relative(REPO, abs).split(path.sep).join("/");
          if (clean.slice(at, at + 2).trim() !== "")
            bad.push(`${rel}: not blanked at offset ${at}`);
          else if (eol >= 0 && clean[eol] !== "\n")
            bad.push(`${rel}: blanking ran past the end of its line`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

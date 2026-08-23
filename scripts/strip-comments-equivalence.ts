// IS CONVERTING THIS SCANNER TO `stripComments` VERDICT-PRESERVING? (#3621)
//
//   npx tsx scripts/strip-comments-equivalence.ts <pathspec…>
//   npx tsx scripts/strip-comments-equivalence.ts --narrow <pathspec…>
//
// The work queue in `lib/__tests__/strip-comments.test.ts` freezes the guards that
// still hand-roll a comment deleter. Converting one changes what it SEES, so each
// conversion needs its own re-measurement — that is why the list is a ratchet and
// not a sweep. This is the instrument that measurement uses, committed so the next
// conversion re-runs it rather than re-inventing it.
//
// THE COMPARISON IS NOT "IS THE OUTPUT THE SAME". It never is: the hand-rolled pair
// DELETES the comment, `lib/__tests__/strip-comments.ts` BLANKS it in place, so
// lengths and line numbers differ by construction (that difference is the point —
// the blanked form keeps every reported line number true). The question is whether
// the two removed the same CHARACTERS, and that is decidable: compare the
// NON-WHITESPACE projections of both outputs.
//
//   0 files differ  ⇒ the conversion is verdict-preserving BY PROOF. Any matcher
//                     over code text finds exactly what it found before.
//   N files differ  ⇒ the guard will read those N differently. Run its test and
//                     read the result as a re-measurement, not as a formality.
//
// THE DIFFERENCE HAS A DIRECTION, and it is the reassuring one. The hand-rolled line
// regex is unanchored, so it deletes from any `//` — the one inside `"https://…"`
// included — and takes the rest of that line with it. The old strippers therefore saw
// LESS code than the file contains; converting makes a guard see MORE. A guard that
// was going to fire on something newly visible goes red at conversion time, which is
// the finding, not the failure.
//
// `--narrow` compares against the OTHER hand-roll in the tree — `^\s*//.*$`, whole-
// line comments only, which let a trailing `// …` survive untouched. Two of the
// conversions in #3621 used that spelling and their numbers are measured against it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { stripComments } from "../lib/__tests__/strip-comments";

/** The ordered pair this repo's guards overwhelmingly wrote. */
const common = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The narrower spelling: whole-LINE comments only. */
const narrow = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const dense = (s: string): string => s.replace(/\s+/g, "");

const argv = process.argv.slice(2);
const useNarrow = argv.includes("--narrow");
const pathspec = argv.filter((a) => !a.startsWith("--"));
if (pathspec.length === 0) {
  console.error(
    "usage: strip-comments-equivalence.ts [--narrow] <pathspec…>\n" +
      "  pathspec is passed straight to `git ls-files` — give the corpus the\n" +
      "  scanner actually walks, not the whole tree."
  );
  process.exit(2);
}

const before = useNarrow ? narrow : common;
const files = execFileSync("git", ["ls-files", "-z", "--", ...pathspec], {
  maxBuffer: 128 * 1024 * 1024,
})
  .toString("utf8")
  .split("\0")
  .filter((f) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f));

const differ = files.filter((f) => {
  const src = fs.readFileSync(f, "utf8");
  return dense(before(src)) !== dense(stripComments(src));
});

console.log(
  `${useNarrow ? "narrow" : "common"} hand-roll vs stripComments over ${pathspec.join(" ")}`
);
console.log(`  ${files.length} files read, ${differ.length} read differently`);
for (const f of differ) console.log(`    ${f}`);
if (differ.length === 0) {
  console.log(
    "  ⇒ verdict-preserving by proof: both strippers removed the same characters."
  );
} else {
  console.log(
    "  ⇒ the guard will see these differently. Run its test and report the result."
  );
}

// WHERE DOES `stripComments` DISAGREE WITH A REAL PARSER? (#3581)
//
//   npx tsx lib/__tests__/strip-comments-oracle.ts <pathspec…>
//
// `lib/__tests__/strip-comments.ts` decides whether a `/` opens a regex literal from
// the token before it, which is a HEURISTIC and not a decision procedure. Sixteen
// modules read source through it, so a wrong call silently changes what a guard sees.
// A claim that it "might" get something wrong is worth nothing; this measures it.
//
// THE ORACLE IS A REAL PARSE — `ts.createSourceFile`, whose comment trivia ranges are
// the compiler's own answer, arrived at with regexes, templates and JSX resolved
// properly. Comparing the two per character answers the only question that matters
// about the heuristic: does it blank a different set of characters than a compiler
// would.
//
//   UNDER-BLANK  a comment character the oracle names and this scanner left as code.
//                A guard then matches inside a comment: a false FINDING. Noise
//                somebody investigates.
//   OVER-BLANK   a code character this scanner blanked and the oracle did not. A
//                guard then cannot see real code: a false PASS, and it is silent.
//
// The two directions are not equally bad and the report keeps them apart for that
// reason. Over-blanking is the direction that hides a defect.
//
// IT IS NOT A TEST AND IT DOES NOT REPLACE THE DEFAULT SCANNER. Depending on
// `typescript` at scan time would make every census in `lib/__tests__` pay for a full
// parse. The dialog census opts into the parser-backed projection exported below
// because over-blanking there can hide the exact ModalShell it guards (#3532); the
// other consumers retain the lightweight scanner and this instrument says how far
// that heuristic is from the real answer, run by hand and pinned by the cases in
// `lib/__tests__/strip-comments.test.ts`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { stripComments } from "./strip-comments";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Every comment range in the file, from a real PARSE.
 *
 * `ts.createScanner` alone is not enough and the difference is instructive: a raw
 * scanner has no parser context, so it cannot re-scan `${` back into a template
 * continuation and the first interpolated template desynchronises the rest of the
 * file. Only a parse resolves the same ambiguities this scanner is guessing at, which
 * is exactly why the parse is the oracle.
 *
 * Every comment in a file is trivia of some token — the trailing ones included,
 * since they attach to the NEXT token — and the tail of the file attaches to
 * `EndOfFileToken`.
 */
export function oracleCommentRanges(
  rel: string,
  src: string
): [number, number][] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  return commentRanges(sf, src);
}

function commentRanges(sf: ts.SourceFile, src: string): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Set<number>();
  const visit = (node: ts.Node): void => {
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      const at = node.getFullStart();
      // BOTH halves, and the reason is a real trap: `getLeadingCommentRanges` starts
      // collecting only after a line break (unless `pos` is 0), so a comment sitting
      // immediately at the token's full start — every `{/* … */}` in JSX, every
      // trailing `// …` — is invisible to it. `getTrailingCommentRanges` collects
      // from `pos` and stops at the first line break. The union is the file's trivia.
      for (const r of [
        ...(ts.getTrailingCommentRanges(src, at) ?? []),
        ...(ts.getLeadingCommentRanges(src, at) ?? []),
      ])
        if (!seen.has(r.pos)) {
          seen.add(r.pos);
          out.push([r.pos, r.end]);
        }
      return;
    }
    for (const k of kids) visit(k);
  };
  visit(sf);
  return out;
}

/**
 * Blank comments from a source file using the parser's trivia boundaries.
 *
 * Unlike a raw scanner, the parser has enough grammar context to know that the `/`
 * after `)` or `}` may open a regular expression. That distinction is load-bearing
 * for a guard: `/[/*]/` must remain code, not become a block comment that hides the
 * rest of the file. Invalid source fails closed with an explicit scanner error:
 * returning raw text would let comments authenticate imports and JSX, while deleting
 * text would be a silent false pass.
 */
export function stripCommentsParsed(rel: string, src: string): string {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  const diagnostics = (
    sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics?.length) {
    const first = diagnostics[0]!;
    const at = sf.getLineAndCharacterOfPosition(first.start ?? 0);
    throw new Error(
      `Comment scan could not parse ${rel}:${at.line + 1}:${at.character + 1}: ` +
        ts.flattenDiagnosticMessageText(first.messageText, "\n")
    );
  }

  const out = src.split("");
  for (const [from, to] of commentRanges(sf, src))
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  return out.join("");
}

export interface Disagreement {
  /** Comment characters left as code — a false FINDING. */
  underBlanked: number[];
  /** Code characters blanked away — a false PASS, the silent direction. */
  overBlanked: number[];
}

/** Where `stripComments` and the TypeScript scanner blank different characters. */
export function disagreements(rel: string, src: string): Disagreement {
  const want = new Uint8Array(src.length);
  for (const [a, b] of oracleCommentRanges(rel, src))
    for (let k = a; k < b; k++) if (src[k] !== "\n") want[k] = 1;
  const got = stripComments(src);
  const underBlanked: number[] = [];
  const overBlanked: number[] = [];
  for (let k = 0; k < src.length; k++) {
    if (src[k] === "\n" || src[k] === " ") continue;
    const blanked = got[k] === " ";
    if (want[k] && !blanked) underBlanked.push(k);
    if (!want[k] && blanked) overBlanked.push(k);
  }
  return { underBlanked, overBlanked };
}

const lineOf = (src: string, at: number): number =>
  src.slice(0, at).split("\n").length;

function main(): void {
  const pathspec = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (pathspec.length === 0) {
    console.error(
      "usage: strip-comments-oracle.ts <pathspec…>\n" +
        "  pathspec is passed straight to `git ls-files`."
    );
    process.exit(2);
  }
  const files = execFileSync("git", ["ls-files", "-z", "--", ...pathspec], {
    cwd: REPO,
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((f) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f));

  let under = 0;
  let over = 0;
  const rows: string[] = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(REPO, rel), "utf8");
    const d = disagreements(rel, src);
    if (d.underBlanked.length === 0 && d.overBlanked.length === 0) continue;
    if (d.underBlanked.length) under++;
    if (d.overBlanked.length) over++;
    const at = (xs: number[]): string =>
      xs.length ? `${xs.length} chars from :${lineOf(src, xs[0])}` : "—";
    rows.push(
      `    ${rel}\n      under-blanked (false finding): ${at(d.underBlanked)}` +
        `\n      over-blanked (SILENT): ${at(d.overBlanked)}`
    );
  }
  console.log(
    `stripComments vs the TypeScript parser over ${pathspec.join(" ")}`
  );
  console.log(
    `  ${files.length} files read, ${rows.length} disagree ` +
      `(${under} under-blank, ${over} OVER-blank)`
  );
  for (const r of rows) console.log(r);
  if (rows.length === 0)
    console.log("  ⇒ the heuristic agrees with a real parse everywhere here.");
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  main();

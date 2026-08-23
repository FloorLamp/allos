// THE SOURCE-LITERAL TOKENIZER, shared by the chokepoint scans that read string
// content out of real repository files — the message-line separator scan (#2391) and the
// glyph-vocabulary scan (#2392). Both ask the identical question ("what are the string
// literals in this file, ignoring comments?") and two answers to it would drift, so it
// lives here rather than in either test.
//
// Not a parser. It walks code and collects every quoted string and template chunk with
// the line it started on. That is exactly as much as a text scan can honestly claim.
//
// IT NO LONGER SKIPS COMMENTS ITSELF (#3581). It used to, with a `//` and a `/*` branch
// of its own — the second hand-rolled comment scanner in this directory, beside
// `lib/__tests__/strip-comments.ts`, and carrying the same blindness the shared one was
// written to end: no regex state, so `/\*\//g` put a `//` in front of the scanner and
// the rest of that line stopped being read. Two scanners over one language with one
// blind spot is the shape that gets fixed in one and not the other, so the comment half
// is now the shared module's and this file keeps only the projection that is genuinely
// its own — EXTRACTING literal content, where the shared scanner DISCARDS it.
//
// Comments arrive here already blanked to spaces, in place. That is why the retirement
// costs nothing: byte offsets and line numbers are unchanged, so `line` still names the
// line in the real file, and a literal that only ever existed inside a comment is a run
// of spaces by the time this walker reaches it.

import { stripComments } from "./strip-comments";

export interface Literal {
  text: string;
  line: number;
  // A TEMPLATE chunk is composition — its neighbours are interpolated values. A QUOTED
  // string is content unless it is nothing but a separator, which is what a
  // `.join(" · ")` argument looks like.
  kind: "template" | "quoted";
}

interface Cursor {
  i: number;
  line: number;
}

// Read a single- or double-quoted string. A quote that never closes on its own line is
// not a string literal (most often the inside of a regex, e.g. /["']/) — the cursor is
// rewound and the character treated as ordinary code, so one regex cannot swallow the
// rest of the file.
function readQuoted(src: string, cur: Cursor, quote: string, out: Literal[]) {
  const start = cur.i;
  const startLine = cur.line;
  let i = cur.i + 1;
  let buf = "";
  while (i < src.length && src[i] !== quote) {
    if (src[i] === "\n") {
      cur.i = start + 1;
      return;
    }
    if (src[i] === "\\") {
      buf += src[i + 1] ?? "";
      i += 2;
      continue;
    }
    buf += src[i];
    i++;
  }
  cur.i = i + 1;
  out.push({ text: buf, line: startLine, kind: "quoted" });
}

function readTemplate(src: string, cur: Cursor, out: Literal[]) {
  let buf = "";
  let startLine = cur.line;
  while (cur.i < src.length && src[cur.i] !== "`") {
    if (src[cur.i] === "\\") {
      buf += src[cur.i + 1] ?? "";
      cur.i += 2;
      continue;
    }
    if (src[cur.i] === "$" && src[cur.i + 1] === "{") {
      if (buf) out.push({ text: buf, line: startLine, kind: "template" });
      buf = "";
      cur.i += 2;
      readCode(src, cur, out, true);
      startLine = cur.line;
      continue;
    }
    if (src[cur.i] === "\n") cur.line++;
    buf += src[cur.i];
    cur.i++;
  }
  cur.i++;
  if (buf) out.push({ text: buf, line: startLine, kind: "template" });
}

// Walk code, collecting every string and template chunk. `untilBrace` stops at the `}`
// closing a `${…}` interpolation, so a nested template — `${verdict ? ` — ${verdict}` : ""}`
// — is scanned rather than skipped.
function readCode(
  src: string,
  cur: Cursor,
  out: Literal[],
  untilBrace: boolean
) {
  let depth = 0;
  while (cur.i < src.length) {
    const c = src[cur.i];
    if (c === "\n") {
      cur.line++;
      cur.i++;
      continue;
    }
    if (c === '"' || c === "'") {
      readQuoted(src, cur, c, out);
      continue;
    }
    if (c === "`") {
      cur.i++;
      readTemplate(src, cur, out);
      continue;
    }
    if (untilBrace) {
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) {
          cur.i++;
          return;
        }
        depth--;
      }
    }
    cur.i++;
  }
}

/**
 * Every string and template chunk in the file, comments excluded.
 *
 * The blanking is `lib/__tests__/strip-comments.ts`'s, so this module has one
 * comment scanner rather than a second one (#3581) — and inherits its regex, string
 * and template tracking, which this walker never had.
 */
export function stringLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  readCode(stripComments(src), { i: 0, line: 1 }, out, false);
  return out;
}

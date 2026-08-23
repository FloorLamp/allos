// STRIP COMMENTS FROM TYPESCRIPT SOURCE, without being fooled by the code around
// them. Shared by the repository censuses that read real source files as text and
// must not count a sentence of prose as a call, a literal or a JSX mounting:
// lib/__tests__/logged-via-surface-wiring.test.ts (#3087) and
// lib/__tests__/chat-origin.test.ts (#3087).
//
// WHY IT IS A SCANNER AND NOT TWO REGEXES. Both censuses previously carried their
// own copy of
//
//   src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
//
// which strips BLOCK comments first. A `/*` sequence written inside a `//` line
// comment therefore opened a block comment that no `*/` was meant to close, and
// everything up to the next unrelated `*/` in the file was deleted as "a comment".
// components/ActivityForm.tsx:108 is an ordinary English line —
// `//   • presentational sections → components/activity-form/*: …` — and that `/*`
// swallowed lines 108-1352 of the file, `useLoggedViaStamp()` at :220 included. The
// guard whose whole job is to watch that stamper could not see it, and deleting the
// region it depends on left every tier green. Reordering the two regexes only moves
// the hole (a `//` inside a block comment would then end it early), so the answer is
// to read the file once, in order, tracking what it is inside.
//
// WHAT IT TRACKS: line comments, block comments, single- and double-quoted strings,
// template literals including nested `${…}` interpolations, and regular-expression
// literals. Regexes are not decoration here — `/\/\*[\s\S]*?\*\//g` (the very line
// above) contains an escaped slash immediately before its closing slash, so a scanner
// blind to regexes reads `//` there and blanks the rest of the line.
//
// WHAT IT RETURNS: the SAME STRING with every comment character replaced by a space
// and every newline kept. Byte offsets and line numbers are therefore identical to
// the original file, so a census can report `file:line` truthfully and `^`-anchored
// patterns still see real line starts. Strings and template contents are preserved
// verbatim — a census looking for `"quick-log"` is looking for a string literal.
//
// NOT A PARSER, and it does not need to be: nothing downstream evaluates the result,
// it is only searched. Where the code is genuinely ambiguous to a scanner it fails
// toward "this is ordinary code" rather than toward deleting text (see the regex
// rule below), because deleting text is the failure mode that hides a defect.
//
// SEPARATE FROM lib/__tests__/source-literals.ts on purpose: that one EXTRACTS the
// content of string literals and discards the code, which is the opposite projection
// and cannot answer this question without a second pass.

/**
 * Characters after which a `/` starts a REGULAR EXPRESSION rather than a division.
 *
 * Deliberately excludes `<`, `>` and `}`, which the JS grammar would allow and TSX
 * makes dangerous: `</div>`, `<Foo />`, and a self-closing tag followed on the same
 * line by a JSX block comment, all put a `/` after one of them. Treating that `/` as a
 * regex opener would swallow the real comment further along the line. `=>` is restored explicitly below, since an arrow
 * body genuinely may be a regex.
 */
const REGEX_PRECEDERS = new Set("(,=:[!&|?;{+-*%^~".split(""));

/** Keywords after which a `/` starts a regex (`return /x/.test(s)`). */
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/** Is the `/` at `i` a regex opener, judged by the code already emitted? */
function opensRegex(out: string[], i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(out[j])) j--;
  if (j < 0) return true;
  const c = out[j];
  // `=>` — an arrow body may be a regex, though a bare `>` may not.
  if (c === ">" && j > 0 && out[j - 1] === "=") return true;
  if (REGEX_PRECEDERS.has(c)) return true;
  if (/[A-Za-z_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) k--;
    return REGEX_KEYWORDS.has(out.slice(k + 1, j + 1).join(""));
  }
  return false;
}

/**
 * Consume a regex literal starting at `src[i] === "/"`. Returns the index just past
 * the closing `/`, or -1 if the literal does not close on its own line — which a real
 * regex literal always does, so -1 means "this was not a regex" and the caller treats
 * the `/` as an ordinary character.
 */
function endOfRegex(src: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\n") return -1;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1;
    j++;
  }
  return -1;
}

/**
 * The source with every comment blanked, byte-for-byte otherwise.
 *
 * Line and block comments become runs of spaces (newlines preserved); strings,
 * templates and regexes are copied through untouched.
 */
export function stripComments(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++)
      if (out[k] !== "\n") out[k] = " ";
  };

  // Depth of `${…}` interpolations we are inside, so a `}` knows whether it returns
  // to a template or is ordinary code. Each entry counts the plain `{` braces opened
  // within that interpolation.
  const interp: number[] = [];
  let i = 0;
  let inTemplate = false;

  while (i < src.length) {
    const c = src[i];

    if (inTemplate) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        inTemplate = false;
        i++;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        interp.push(0);
        inTemplate = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // Comments first: neither `//` nor `/*` can ever open a regex literal, so this
    // ordering removes the whole regex-vs-comment ambiguity for those two shapes.
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
      const end = Math.min(j + 2, src.length);
      blank(i, end);
      i = end;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        // A quote that does not close on its own line is not a string — most often a
        // quote character inside a regex or JSX text. Treat it as ordinary and move
        // on, so one stray apostrophe cannot swallow the rest of the file.
        if (src[j] === "\n") break;
        if (src[j] === c) {
          closed = true;
          break;
        }
        j++;
      }
      i = closed ? j + 1 : i + 1;
      continue;
    }

    if (c === "`") {
      inTemplate = true;
      i++;
      continue;
    }

    if (c === "{" && interp.length) {
      interp[interp.length - 1]++;
      i++;
      continue;
    }
    if (c === "}" && interp.length) {
      if (interp[interp.length - 1] === 0) {
        interp.pop();
        inTemplate = true;
      } else {
        interp[interp.length - 1]--;
      }
      i++;
      continue;
    }

    if (c === "/") {
      if (opensRegex(out, i)) {
        const end = endOfRegex(src, i);
        if (end > 0) {
          i = end;
          continue;
        }
      }
      i++;
      continue;
    }

    i++;
  }

  return out.join("");
}

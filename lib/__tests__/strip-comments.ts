// STRIP COMMENTS FROM TYPESCRIPT SOURCE, without being fooled by the code around
// them. Shared by the repository censuses that read real source files as text and
// must not count a sentence of prose as a call, a literal or a JSX mounting —
// lib/__tests__/chat-origin.test.ts (#3087) among them.
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
// ── WHAT IT GETS WRONG, MEASURED RATHER THAN CONCEDED (#3581) ───────────────────
//
// Sixteen modules read source through this scanner, so "it is a heuristic" is not a
// useful thing to know on its own — the useful thing is WHICH INPUTS, and in WHICH
// DIRECTION. `lib/__tests__/strip-comments-oracle.ts` answers that by diffing this
// scanner against a real TypeScript parse, per character, over the tracked tree, and
// `lib/__tests__/strip-comments.test.ts` pins both the inputs and the tree-wide count.
//
// The two directions are not symmetric and that is the whole reason the answer is
// "document and pin" rather than "widen the preceder set":
//
//   UNDER-BLANK — a comment left as code. A guard matches inside a sentence: a false
//   FINDING, which somebody investigates. Noise.
//
//   OVER-BLANK — code blanked away. A guard cannot see real source: a false PASS, and
//   it is SILENT. This is the direction that hid 1,244 lines of ActivityForm.tsx.
//
// ONE INPUT IS STILL WRONG, over-blanking, authored in the test file:
//
//   A REGEX LITERAL OPENING AFTER `}` OR `)`, whose body carries `//` or `/*`
//   inside a character class — `function f() {}` then `/[//]/.test(s)`, or
//   `if (x) /[/*]/.test(s)`. Neither `}` nor `)` may join REGEX_PRECEDERS: `}`
//   because `<Foo a={1} />` puts a `/` right after one (the JSX rule below), and
//   `)` because `(a + b) / c; // note` is ordinary division whose trailing comment
//   would then be walked into. So this one is a genuine trade, and the resolution
//   is that the shape does not occur: a statement-initial regex and a braceless
//   `if` body carrying a regex are both absent from this tree, and the oracle test
//   holds that at zero.
//
// JSX TEXT USED TO BE A THIRD, AND IT WAS THE ONE THAT MATTERED (#3641). With no
// JSX-children state, `<p>otpauth:// URI</p>` read as a line comment and 37
// characters of rendered copy vanished from every guard's reading of
// app/(app)/settings/TwoFactorSettings.tsx. That is the over-blank direction — the
// silent one — and it falsified the argument (#3581) that this scanner's only failure
// mode produces noise. The scanner now tracks JSX: opening tags, children text,
// closing tags, and `{…}` expression containers, which are the same thing to a
// scanner as a template's `${…}`. Text is text; only a container's contents are code.
// Measured over the same 5,102 tracked files, in both directions: the tree went from
// 1 over-blanking file and 0 under-blanking to ZERO of each, so the fix cost nothing
// in the noisy direction either. What it cannot decide without a parser is a JSX
// element whose children begin with `(` — see `isTypeParameterList`, which resolves
// that one toward the behaviour this replaced rather than toward a new failure.
//
// TWO INPUTS WERE FIXED rather than recorded, because neither needed a guess:
// `i++ / 2` and `obj.in / 2` are division by the grammar, not by preference. Both
// are decided in `opensRegex` below. Measured over the tracked tree at the time:
// ZERO files' blanked text changed, so every reader saw exactly what it saw before.
//
// SEPARATE FROM lib/__tests__/source-literals.ts on purpose, but no longer a second
// COMMENT SCANNER: that module EXTRACTS the content of string literals and discards
// the code, which is the opposite projection and cannot answer this question without
// a second pass — so the projection stays its own, and the comment half is now this
// module's (#3581). It used to hand-roll `//` and `/*` branches with no regex state
// at all, so `[/\bEdge\//i, "Edge"]` put a `//` in front of it and the rest of that
// line stopped being read: eleven real string literals invisible in one file.

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
  // A POSTFIX `++` / `--` ENDS AN EXPRESSION, so the `/` after it is division and
  // nothing else. Not a heuristic and not a preference: `i++ /re/` is not a program.
  // Without this the `+` reads as the operator it usually is and `i++ / 2; // ratio`
  // has the trailing comment walked into as regex, which surfaces the sentence to
  // every guard as code (#3581).
  if ((c === "+" || c === "-") && j > 0 && out[j - 1] === c) return false;
  if (REGEX_PRECEDERS.has(c)) return true;
  if (/[A-Za-z_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) k--;
    // A PROPERTY NAMED AFTER A KEYWORD IS NOT THE KEYWORD. `obj.in / 2` ends in a
    // value, so the `/` divides; only a bare `in` can be followed by a regex. Same
    // shape as the postfix rule — a decision, not a guess (#3581).
    if (out[k] === ".") return false;
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
 * Is the `<` at `i` a TYPE PARAMETER LIST rather than a JSX element? Both sit in the
 * same expression position and this tree writes both — `const asArray = <T>(x) => …`
 * and `const byDate = <T extends { date: string }>(a, b) => …` in .ts, `= <p>…</p>` in
 * .tsx. What separates them is content and what follows: a type parameter list holds
 * only identifiers, commas and constraints, and is always applied to a parameter list,
 * so the character after its `>` is `(`. Anything a type parameter list cannot contain
 * — an `=`, a quote, a `/` — settles it as JSX before the scan gets that far.
 *
 * It answers "no" for a JSX element whose children begin with `(` (`<p>(optional)</p>`),
 * which is genuinely ambiguous without a parser. That direction leaves the old
 * behaviour in place rather than introducing a new one, so it fails toward the
 * scanner this replaced.
 */
function isTypeParameterList(src: string, i: number): boolean {
  const limit = Math.min(src.length, i + 200);
  let j = i + 1;
  let depth = 0;
  while (j < limit) {
    const c = src[j];
    if (c === "<" || c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === ">") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && !/[A-Za-z0-9_$,.|&\s]/.test(c)) return false;
    j++;
  }
  if (src[j] !== ">") return false;
  let k = j + 1;
  while (k < src.length && /\s/.test(src[k])) k++;
  return src[k] === "(";
}

/** Is the `<` at `i` opening a JSX element? */
function opensJsx(out: string[], src: string, i: number): boolean {
  // A tag name or a fragment. `a < b` and `Foo<Bar>` both fail the position test
  // below, because a value or an identifier precedes them.
  if (!/[A-Za-z_$>]/.test(src[i + 1] ?? "")) return false;
  return opensRegex(out, i) && !isTypeParameterList(src, i);
}

/**
 * What the scanner is currently inside, innermost last; empty means ordinary code.
 *
 * `code` is any `{…}` that returns to whatever encloses it, because a `${…}`
 * interpolation in a template and a `{…}` expression container in JSX are the same
 * thing to a scanner — the frame beneath records which one it returns to, so neither
 * needs its own kind.
 */
type Frame =
  | { kind: "template" }
  | { kind: "code"; braces: number }
  | { kind: "tag"; angle: number }
  | { kind: "children" };

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

  const stack: Frame[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    const frame = stack[stack.length - 1];

    if (frame?.kind === "template") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        i++;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        stack.push({ kind: "code", braces: 0 });
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // JSX CHILDREN ARE TEXT, NOT CODE. Nothing here opens a comment, a string or a
    // regex — `otpauth:// URI` is rendered copy, and reading it as a line comment
    // blanked it out from under sixteen guards (#3641). Only a nested element, a
    // closing tag and a `{…}` container mean anything.
    if (frame?.kind === "children") {
      if (c === "<" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== ">") i++;
        stack.pop();
        i++;
        continue;
      }
      if (c === "<" && /[A-Za-z_$>]/.test(src[i + 1] ?? "")) {
        stack.push({ kind: "tag", angle: 0 });
        i++;
        continue;
      }
      if (c === "{") {
        stack.push({ kind: "code", braces: 0 });
        i++;
        continue;
      }
      i++;
      continue;
    }

    // Inside `<tag …>`: only the ways a tag ends are special. Attribute strings,
    // `{…}` values and the comments TypeScript allows between attributes all fall
    // through to the ordinary code handling below. `angle` counts the TYPE ARGUMENTS
    // a generic component carries — `<SegmentedControl<ViewMode> …>` writes a `>` that
    // does not end the tag, and reading it as one hands the whole rest of the file to
    // the children state.
    if (frame?.kind === "tag") {
      if (c === "<") {
        frame.angle++;
        i++;
        continue;
      }
      if (c === ">") {
        if (frame.angle > 0) frame.angle--;
        else stack[stack.length - 1] = { kind: "children" };
        i++;
        continue;
      }
      if (c === "/" && src[i + 1] === ">" && frame.angle === 0) {
        stack.pop();
        i += 2;
        continue;
      }
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
      stack.push({ kind: "template" });
      i++;
      continue;
    }

    if (c === "{") {
      if (frame?.kind === "code") frame.braces++;
      else if (frame?.kind === "tag") stack.push({ kind: "code", braces: 0 });
      i++;
      continue;
    }
    if (c === "}" && frame?.kind === "code") {
      if (frame.braces === 0) stack.pop();
      else frame.braces--;
      i++;
      continue;
    }

    if (c === "<" && opensJsx(out, src, i)) {
      stack.push({ kind: "tag", angle: 0 });
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

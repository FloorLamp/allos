// EVERY `act()` WHOSE RESULT THE RUNNER NEVER SEES (#3578).
//
// WHAT WENT WRONG. `components/__tests__/imported-name-offer.test.tsx` had one
// case written `return act(…).then(…)` where its twelve siblings wrote
// `await act(…)`. Stubbed so the component rendered nothing, the `getByTestId`
// inside the callback threw — and the case reported GREEN. The mutation that
// should have killed all thirteen killed twelve.
//
// WHY, MEASURED. React's `act()` does not return a Promise. It returns a bare
// thenable — a plain object with a `then` method — and that method returns
// `undefined`:
//
//     const r = act(async () => {});
//     r.constructor.name        // "Object"
//     r instanceof Promise      // false
//     r.then(() => {})          // undefined
//
// So `return act(…).then(cb)` returns `undefined`. The runner has nothing to
// await, the case finishes before the callback runs, and anything the callback
// throws lands outside the test — at best as an unhandled error attributed to
// whichever case happened to be running, at worst as nothing at all. No care in
// writing the assertion can survive this: the defect is in the plumbing AROUND
// the assertion, which is what made it worth a guard rather than a fix.
//
// THE DISCRIMINATOR IS THE CALLBACK, NOT THE `await` (#3635 R2). The first
// version of this guard was absolute — any `act(` from the React import without a
// preceding `await`. That is a wider claim than the defect above, and the tree
// disagrees with it: main gained ten sites over 24–25 Aug 2026 written
// `act(() => vi.advanceTimersByTime(500))`, the synchronous idiom, where there is
// no thenable anyone could await and nothing to wait for.
//
// The two cases are not alike, and the difference is observable. Four cases, one
// file, run under this repo's own component tier (probe reproduced in the census's
// `a throw inside act() only escapes an ASYNC callback` case):
//
//     SYNC callback, act() NOT awaited     -> the case FAILS  (throw propagates)
//     ASYNC callback, act() NOT awaited    -> the case PASSES (throw swallowed)
//     ASYNC callback, `.then()` chained    -> the case PASSES (throw swallowed)
//     ASYNC callback, awaited              -> the case FAILS  (throw propagates)
//
// A synchronous callback runs to completion INSIDE the `act()` call, so whatever it
// throws comes straight back out of that call on the same stack and the runner sees
// it. There is no window in which an assertion can be lost. An asynchronous one
// returns a promise that `act` hands back inside its thenable, and dropping that
// thenable drops every rejection with it. So the guard asks what it can actually
// prove: it stays quiet ONLY on a call whose callback is a SYNTACTICALLY
// synchronous function literal AND whose result is discarded, and it fires on
// everything else.
//
// THIS IS AN ALLOWANCE FOR A PROVEN-SAFE SHAPE, NOT A ROSTER. It names no file and
// no occurrence; the eleventh synchronous `act(() => …)` written tomorrow is silent
// for the same reason the first ten are, and `act(someHelper)` — where the guard
// cannot see whether `someHelper` is async — is a FINDING, which the absolute rule
// and this one both give. What the narrowing gives up is a call the guard could
// never justify flagging; what it buys is a guard that survives, because a guard
// that reds main on a correct idiom is a guard with a `// eslint-disable`-shaped
// hole cut in it inside a week.
//
// WHY THIS AND NOT "no `.then()` in a test". Measured 2026-08-23 across the whole
// test tree: 21 `.then()` call sites in 16 files, a thrown error planted in each
// callback. 19 of 21 red the run. The 2 that did not are promises the tests
// deliberately NEVER SETTLE ("holds the navigation open … and never rejects it",
// "leaves a superseded navigation's held fetch parked forever") — their callbacks
// never run at all, which those tests assert themselves. `.then()` on a REAL
// promise propagates fine, and a guard that banned it would fire on ten correct
// sites and be deleted within a week. What is not fine is `.then()` on a thenable
// that is not a promise, and `act` is the one this repo has.
//
// AND NO LINT RULE IN THIS REPO COVERS IT. Measured 2026-08-23: the effective
// config for a test file carries 67 rules, none promise- or test-related, and no
// `parserOptions.project`, so the type-aware family cannot run at all. Enabling
// `@typescript-eslint/no-floating-promises` does not reach the shape either — it
// inspects EXPRESSION STATEMENTS, so a bare `work();` is flagged and both
// `return work().then(…)` and `return actLike(…).then(…)` are silent.

/** A source file as the census reads it. */
export interface ScannedSource {
  readonly file: string;
  readonly source: string;
}

export interface ActFinding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

// THE IMPORT IS WHAT CONSTITUTES MEMBERSHIP, not the identifier. Two shipped test
// files (`lib/__tests__/activity-validate.test.ts`, `lib/__tests__/import-review.test.ts`)
// define their own local `act()` — a fixture builder that returns an Activity — and
// call it 72 times between them, never awaited and correctly so. A guard keyed on
// the spelling `act(` would fire on all 72 and be gone by the end of the week,
// taking the real guard with it.
const ACT_MODULES = ["@testing-library/react", "react", "react-dom/test-utils"];

/**
 * The local name React's `act` is bound to in this file, or null if the file does
 * not import it. Handles `{ act }` and `{ act as somethingElse }`.
 */
export function reactActLocalName(source: string): string | null {
  for (const mod of ACT_MODULES) {
    const importRe = new RegExp(
      `import\\s*\\{([^}]*)\\}\\s*from\\s*["']${mod.replace("/", "\\/")}["']`,
      "g"
    );
    for (const m of source.matchAll(importRe)) {
      for (const spec of m[1].split(",")) {
        const named = /^\s*act\s*(?:as\s+(\w+))?\s*$/.exec(spec);
        if (named) return named[1] ?? "act";
      }
    }
  }
  return null;
}

// Comment-only lines are prose about the construct — this module's own header
// names it repeatedly, and so does the fixed case in imported-name-offer. A guard
// that reads them cries wolf on the sentence explaining why it exists.
const isCommentLine = (line: string): boolean =>
  /^\s*(\/\/|\*|\/\*)/.test(line);

/**
 * The argument text of a call whose `(` is at `open`, and the offset just past its
 * matching `)`.
 *
 * Balanced across LINES rather than read off the one the call starts on. The
 * previous version looked only at the rest of that line, which meant the commonest
 * chained spelling in this repo — the callback body on its own lines and `}).then(`
 * three lines down — was invisible to the `.then()` half of the guard.
 *
 * Depth counting only: it is not a parser, and a `(` inside a string or a comment
 * inside the callback would skew it. Both failure directions are safe here. Too
 * short a span reads the wrong text and the call falls through to "cannot prove it
 * is synchronous", which is a FINDING; too long a span cannot invent a `.then(`
 * that is not there, because the text it lands on is checked literally.
 */
function balancedArgs(
  source: string,
  open: number
): { args: string; after: number } {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { args: source.slice(open + 1, i), after: i + 1 };
    }
  }
  return { args: source.slice(open + 1), after: source.length };
}

// A SYNTACTICALLY SYNCHRONOUS FUNCTION LITERAL, and nothing else counts.
//
// `() => …`, `(a, b) => …`, `x => …`, `function () {…}` — the four spellings a
// callback is written in here — each with NO leading `async`. An identifier
// (`act(flushEverything)`), a call, a conditional, or a literal that starts on the
// next line are all "cannot prove", and cannot-prove is a finding: the guard is
// only allowed to be quiet about a shape whose throw it has watched propagate.
const SYNC_CALLBACK_RE =
  /^\s*(?!async\b)(\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|function\s*\*?\s*[\w$]*\s*\()/;

/** `.then(` hung directly off the call's closing paren, on any line. */
const CHAINED_THEN_RE = /^\s*\)?\s*\.then\s*\(/;

/**
 * Nothing on the left consumes the call's value: it is a statement, not an
 * expression being returned, stored, `void`ed or passed on. `await` is handled
 * separately — this asks about the OTHER consumers.
 */
const BARE_STATEMENT_RE = /(^|[;{}(,])\s*$/;

/**
 * Every use of React's `act` whose result the runner will never see.
 *
 * Three findings, and the header says why each is one:
 *   1. `.then()` chained onto `act(…)` — `then` returns `undefined`, so the
 *      callback's assertions run after the case is over. Awaited or not.
 *   2. an unawaited call whose callback is not PROVABLY a synchronous function
 *      literal — the `act(async …)` defect, plus every shape the guard cannot
 *      read (`act(helper)`, a callback starting on the next line).
 *   3. an unawaited call whose value is consumed — returned, stored, `void`ed,
 *      passed as an argument. `act()`'s value is useless for all of those: it
 *      cannot be stored and awaited later (the thenable resolves when React's
 *      queue flushes, not when you ask), and it cannot go to `Promise.all`.
 *
 * A bare `act(() => { … })` with a synchronous literal is SILENT, because a throw
 * inside it comes back out of the call on the same stack — measured, see header.
 */
export function findUnawaitedActSites(
  sources: readonly ScannedSource[]
): ActFinding[] {
  const findings: ActFinding[] = [];
  for (const { file, source } of sources) {
    const local = reactActLocalName(source);
    if (local === null) continue;
    const callRe = new RegExp(`(^|[^\\w.])${local}\\s*\\(`, "g");
    const lines = source.split("\n");
    // Offset of the first character of each line, so a match found over the whole
    // source can name its line without re-scanning.
    const lineStart: number[] = [];
    let at = 0;
    for (const line of lines) {
      lineStart.push(at);
      at += line.length + 1;
    }
    const lineOf = (offset: number): number => {
      let lo = 0;
      let hi = lineStart.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStart[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };

    for (const m of source.matchAll(callRe)) {
      const callAt = m.index + m[1].length;
      const i = lineOf(callAt);
      const line = lines[i];
      if (isCommentLine(line)) continue;
      // The import line itself names the symbol without calling it; the regex
      // needs a `(` so `import { act, render }` cannot match, but `act(` inside
      // a string in an import-ish line could — cheap and exact to exclude.
      if (/^\s*import\b/.test(line)) continue;

      const before = line.slice(0, callAt - lineStart[i]);
      const open = source.indexOf("(", callAt);
      const { args, after } = balancedArgs(source, open);
      const awaited = /\bawait\s+$/.test(before);
      const text = line.trim();

      if (CHAINED_THEN_RE.test(source.slice(after))) {
        findings.push({
          file,
          line: i + 1,
          text,
          why: awaited
            ? "chains `.then()` onto `act()`, whose `then` returns undefined"
            : "`.then()` on `act()` — its `then` returns undefined, so nothing is awaited (#3578)",
        });
        continue;
      }
      if (awaited) continue;

      if (!SYNC_CALLBACK_RE.test(args)) {
        findings.push({
          file,
          line: i + 1,
          text,
          why: /^\s*async\b/.test(args)
            ? "`act(async …)` is not awaited — the callback's rejections are dropped with the thenable"
            : "`act()` is not awaited and its callback is not visibly synchronous — nothing here can prove a rejection would reach the runner",
        });
        continue;
      }
      if (!BARE_STATEMENT_RE.test(before)) {
        findings.push({
          file,
          line: i + 1,
          text,
          why: "the result of `act()` is used — it is a thenable, not a promise, so it cannot be returned, stored, voided or passed on",
        });
      }
    }
  }
  return findings;
}

/** One line per finding, in the shape a failing expectation prints. */
export function describeActFindings(findings: readonly ActFinding[]): string[] {
  return findings.map(
    (f) =>
      `${f.file}:${f.line} — ${f.text}\n    ${f.why}. Write \`await act(async () => { … })\` ` +
      `and put the assertions AFTER it, the way every other case in this repo does. ` +
      `A callback that does only synchronous work may stay \`act(() => { … })\` with ` +
      `no await — that shape is not what this guard is about.`
  );
}

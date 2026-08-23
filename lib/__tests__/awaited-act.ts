// EVERY `act()` IS AWAITED (#3578).
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
 * Every use of React's `act` that is not `await act(`.
 *
 * The rule is deliberately absolute rather than "await it somehow": `act()`'s
 * return value is useless for anything else. It cannot be stored and awaited later
 * (the thenable resolves when React's queue flushes, not when you ask), it cannot
 * be chained, and it cannot be handed to `Promise.all`. There is exactly one
 * correct spelling, so the guard requires exactly one.
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
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const m of line.matchAll(callRe)) {
        const at = m.index + m[1].length;
        const before = line.slice(0, at);
        // The import line itself names the symbol without calling it; the regex
        // needs a `(` so `import { act, render }` cannot match, but `act(` inside
        // a string in an import-ish line could — cheap and exact to exclude.
        if (/^\s*import\b/.test(line)) continue;
        if (/\bawait\s+$/.test(before)) {
          // `await act(…)`. The only correct spelling — but a `.then()` hung off
          // an awaited act is still a chain onto a value that is not a promise.
          const after = line.slice(at);
          if (/\)\s*\.then\s*\(/.test(after)) {
            findings.push({
              file,
              line: i + 1,
              text: line.trim(),
              why: "chains `.then()` onto `act()`, whose `then` returns undefined",
            });
          }
          continue;
        }
        findings.push({
          file,
          line: i + 1,
          text: line.trim(),
          why: /\.then\s*\(/.test(line)
            ? "`.then()` on `act()` — its `then` returns undefined, so nothing is awaited (#3578)"
            : "`act()` is not awaited — its result is a thenable the runner never sees",
        });
      }
    });
  }
  return findings;
}

/** One line per finding, in the shape a failing expectation prints. */
export function describeActFindings(findings: readonly ActFinding[]): string[] {
  return findings.map(
    (f) =>
      `${f.file}:${f.line} — ${f.text}\n    ${f.why}. Write \`await act(async () => { … })\` ` +
      `and put the assertions AFTER it, the way every other case in this repo does.`
  );
}

// The NO-DISPLAY-CASING-PASS census (issue #3480) — the rule that keeps the other
// half of the imported-name doctrine closed.
//
// lib/imported-name.ts moves the cleaning of a portal medication name to the import
// boundary, where a person accepts it. That only stays true if nobody later adds the
// cheap version at the far end: a `.toUpperCase()`, a title-case helper, a
// "capitalize" wrapper around a name on its way into the DOM. This module is the
// rule that can see one.
//
// WHAT IT MATCHES ON, and this is the part that took the measuring. Casing CALLS on
// a name are everywhere in this tree and almost all of them are correct: 21 sites
// lowercase a name to COMPARE, SORT or key a Map ("p.name.toLowerCase() ===
// name.trim().toLowerCase()", "sort: { value: (im) => (im.provider_name ??
// '').toLowerCase() }"). A census that flagged those would cry wolf and be deleted
// within the month, taking the real rule with it. So the rule is not "a casing call
// on a name" — it is "a casing transform inside a JSX interpolation that RENDERS a
// name", which is the only shape that reaches a reader's eyes.
//
// THE FLOOR IS PART OF THE RULE. "No display surface casings a name" is an ABSENCE
// assertion, so it goes green the moment the scan stops finding name renders at all
// — a renamed directory, a changed JSX spelling, a regex that quietly stops
// matching. `censusFiles` therefore reports how many files it read and how many name
// RENDER sites it saw, and the test asserts a floor under both (#3509's class).
//
// COMMENTS ARE BLANKED BEFORE SCANNING. A scan over raw source counts prose as code
// — a comment in this very file naming `.toUpperCase()` beside a name would flag
// itself. `blankComments` is exact about what it removes and the test proves it
// leaves string literals alone (a `//` inside a URL is not a comment). It MOVES the
// frozen count, so the size is on the record: 270 name render sites over raw source,
// 244 with comments blanked — a delta of 26, spread over 26 files. The casing-class
// count is unmoved (54 either way).
//
// Pure — reads the strings it is handed. The file walk is the test's, so the rule
// itself stays unit-testable against authored sources.

// The subtrees a user-facing render can live in.
export const CENSUS_ROOTS = ["app", "components"] as const;

// Blank out comments, preserving length and line structure so a hit's line number
// still means something. Runs a small state machine rather than a regex, because
// `"https://x"` and `` `${a}//${b}` `` both contain `//` and neither is a comment.
export function blankComments(source: string): string {
  const out = source.split("");
  let i = 0;
  const n = source.length;
  let quote: string | null = null;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

// An expression that mentions a name — `med.name`, `item.name`, `row.source_name`,
// `provider_name`, `c.name`. Deliberately loose: over-matching here only widens what
// the casing rule LOOKS at, and the casing rule is the narrow one.
//
// `className` is the one exclusion, and it is not cosmetic: it ENDS in "Name", so
// without the lookbehind every styled element inside an interpolation counted as a
// name render and the floor was inflated by sites that render no name at all (118
// of them, measured 2026-08-22: 362 apparent sites, 244 real). A denominator
// padded with non-subjects is the quietest way for a floor to stop meaning
// anything.
const NAME_EXPR = String.raw`[A-Za-z_$][\w.$?\[\]"'! ]*?(?<!class)[Nn]ame\b[\w.$?\[\]]*`;

// A casing transform, in every spelling this tree could reach for: the four String
// methods, and the helper shapes (`titleCase(x)`, `toTitleCase(x)`, `capitalize(x)`,
// `startCase(x)`) that would arrive with a utility rather than a method call.
const CASING = String.raw`(?:\.\s*to(?:Locale)?(?:Upper|Lower)Case\s*\(|(?<![\w.$])(?:to)?[Tt]itleCase\s*\(|(?<![\w.$])[Cc]apitali[sz]e\s*\(|(?<![\w.$])startCase\s*\()`;

// A JSX interpolation in a position a reader SEES: a text child (`>{ … }`, with the
// `>` not part of `=>`, `<=`, `>=` or `!==`), or one of the user-facing attributes
// whose value is read aloud or shown on hover. `[^{}]*` keeps a match inside ONE
// interpolation, so a `{` opening a callback body is never mistaken for a child.
const CHILD_OPEN = String.raw`(?<![=\-!<>])>\s*\{`;
const ATTR_OPEN = String.raw`(?:title|aria-label|alt|placeholder|label|value)\s*=\s*\{`;
const INTERP = String.raw`(?:${CHILD_OPEN}|${ATTR_OPEN})([^{}]*)\}`;

const RENDER_RE = new RegExp(INTERP, "g");
const NAME_IN_INTERP = new RegExp(NAME_EXPR);
const CASING_ON_NAME = new RegExp(
  `${NAME_EXPR}\\s*${CASING}|${CASING}\\s*${NAME_EXPR}`
);

export interface CensusHit {
  // The interpolation's text, for the failure message.
  text: string;
  // 1-based line of the interpolation.
  line: number;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

// Every JSX interpolation in this source that RENDERS a name. The census floor is a
// count of these: the rule can only speak about sites it can see.
export function nameRenderSites(source: string): CensusHit[] {
  const clean = blankComments(source);
  const hits: CensusHit[] = [];
  for (const m of clean.matchAll(RENDER_RE)) {
    const body = m[1] ?? "";
    if (!NAME_IN_INTERP.test(body)) continue;
    hits.push({ text: body.trim(), line: lineOf(clean, m.index) });
  }
  return hits;
}

// Every name render that applies a casing transform on the way to the DOM — the
// offending shape. A subset of nameRenderSites by construction, so a green sweep is
// only meaningful beside that count.
export function nameCasingHits(source: string): CensusHit[] {
  return nameRenderSites(source).filter((h) => CASING_ON_NAME.test(h.text));
}

// ── The MARKUP half, because a class or a style can casing-pass a name too ───
//
// `className="uppercase"` on the element that renders a name is a display casing pass
// with no JavaScript in it at all, so the rule above cannot see it. Neither can it see
// `style={{ textTransform: "uppercase" }}`, which is the same pass wearing a different
// attribute. This is the hole, and it is closed by measurement rather than by
// argument: the tree carries 54 casing classes (measured 2026-08-22) and NONE of them
// wraps a name render — every one sits on an eyebrow, a unit suffix or a table label.
// The rule below re-derives that on every run, and the test floors the count so a scan
// that stops finding casing markup at all cannot pass by finding nothing.
//
// THREE SHAPES IT USED TO MISS, all of them planted on the exact heading #3480 names
// and all of them found by review rather than by the guard:
//   • an inline `style={{ textTransform: "uppercase" }}` — a different attribute;
//   • `className={current ? "uppercase" : "normal-case"}` — the class in an
//     EXPRESSION rather than a string literal, which is how a conditional style is
//     always written, and 133 .tsx files carry a `className={…}` of some kind;
//   • `<b className="uppercase"><i>·</i>{med.name}</b>` — a NESTED tag, which ended
//     the old window at the first `</` it met (the inner `</i>`) and so never reached
//     the name. The window is now depth-aware.
//
// The window is still a heuristic, and heuristics under-match. It is worth having: an
// under-matching rule that catches the spellings somebody would actually reach for is
// what the tree would get wrong, and the alternative was a paragraph asserting the
// hole was empty with nothing checking it.

// A className or style attribute, with its value — a string literal, a template, or a
// braces expression (one level of nesting, which covers both `{cond ? "a" : "b"}` and
// `{{ textTransform: "uppercase" }}`).
const CASING_MARKUP_RE =
  /(className|style)\s*=\s*(?:"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})/g;

// A Tailwind casing class, anywhere in a className value.
const CASING_CLASS_RE = /\b(?:uppercase|lowercase|capitalize)\b/;

// The same pass as an inline style.
const CASING_STYLE_RE =
  /textTransform\s*:\s*["'`]\s*(?:uppercase|lowercase|capitalize)/;

function isCasingMarkup(attr: string, value: string): boolean {
  return attr === "className"
    ? CASING_CLASS_RE.test(value)
    : CASING_STYLE_RE.test(value);
}

// How far past the element to look for its rendered children, capped so a long
// child list cannot drag an unrelated name in.
const CSS_WINDOW = 240;

// The children of the element whose opening tag this attribute sits in — depth-aware,
// so a nested tag closes itself rather than ending the window, and a SIBLING after
// this element's own `</…>` is correctly outside it.
function childWindow(clean: string, from: number): string {
  let i = clean.indexOf(">", from);
  if (i === -1) return "";
  if (clean[i - 1] === "/") return ""; // self-closing: no children to case
  const start = i + 1;
  const cap = Math.min(clean.length, start + CSS_WINDOW);
  let depth = 0;
  i = start;
  while (i < cap) {
    if (clean[i] === "<") {
      const next = clean[i + 1] ?? "";
      if (next === "/") {
        if (depth === 0) break;
        depth -= 1;
        const close = clean.indexOf(">", i);
        if (close === -1) break;
        i = close;
      } else if (/[A-Za-z]/.test(next)) {
        const close = clean.indexOf(">", i);
        if (close === -1) break;
        if (clean[close - 1] !== "/") depth += 1;
        i = close;
      }
    }
    i += 1;
  }
  return clean.slice(start, Math.min(i, cap));
}

// Every casing class or casing style in this source — the denominator the floor is
// asserted on.
export function cssCasingClassSites(source: string): CensusHit[] {
  const clean = blankComments(source);
  const hits: CensusHit[] = [];
  for (const m of clean.matchAll(CASING_MARKUP_RE)) {
    if (!isCasingMarkup(m[1], m[0])) continue;
    hits.push({ text: m[0].trim(), line: lineOf(clean, m.index) });
  }
  return hits;
}

// Every casing class or casing style whose element then renders a name — the
// offending shape.
export function cssCasingOverNameHits(source: string): CensusHit[] {
  const clean = blankComments(source);
  const hits: CensusHit[] = [];
  for (const m of clean.matchAll(CASING_MARKUP_RE)) {
    if (!isCasingMarkup(m[1], m[0])) continue;
    const window = childWindow(clean, m.index + m[0].length);
    for (const interp of window.matchAll(/\{([^{}]*)\}/g)) {
      if (!NAME_IN_INTERP.test(interp[1] ?? "")) continue;
      hits.push({
        text: `${m[0].trim()} over {${(interp[1] ?? "").trim()}}`,
        line: lineOf(clean, m.index),
      });
      break;
    }
  }
  return hits;
}

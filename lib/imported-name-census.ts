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
// THE FLOOR IS PART OF THE RULE. The claim is an ABSENCE
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

// The census asks several questions of the same immutable source text. Keep the
// expensive common projections for the lifetime of this short-lived test worker
// instead of blanking comments and rebuilding the binding graph for every question.
const cleanSourceCache = new Map<string, string>();
const bindingCache = new Map<string, string[]>();
const renderSiteCache = new Map<string, CensusHit[]>();

function cleanSource(source: string): string {
  let clean = cleanSourceCache.get(source);
  if (clean === undefined) {
    clean = blankComments(source);
    cleanSourceCache.set(source, clean);
  }
  return clean;
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
// Binding analysis can only produce a cased local when the raw source contains a
// casing call. Comment blanking may remove a candidate, but it cannot create one.
const CASING_CALL_GATE = /(?:case|capitali[sz]e)\s*\(/i;

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

// ── HOISTING THE CALL OUT OF THE INTERPOLATION ───────────────────────────────
//
// `{med.name.toUpperCase()}` is the shape the rule above matches. It is not the only
// shape, and it is arguably not even the most natural one to write:
//
//     const shown = med.name.toUpperCase();
//     return <h3>{shown}</h3>;
//
// The transform and the render are now two statements, so an interpolation-shaped
// rule sees `{shown}` — an identifier that mentions no name and applies no casing —
// and reports a clean sweep. Two lines defeated it.
//
// So the scan first collects the LOCAL NAMES a casing transform of a name was bound
// to in this file, and then treats an interpolation that renders one of them as
// exactly what it is: a cased name reaching the DOM.
//
// THREE SHAPES WALKED THROUGH THE FIRST VERSION OF IT, and its own header called the
// thing that let them through a virtue. The right-hand side was `[^;{}]` — "it stops
// at the statement end, so a `{` opening a block body cannot drag the following
// statements in", which is true and is also exactly why a `{` of ANY kind ended the
// match early:
//
//     const shown = `${med.name.toUpperCase()}`;     // a template literal RHS
//     const parts = { shown: med.name.toUpperCase() }; // an object RHS
//     let shown = med.name;                            // and the two-step:
//     shown = shown.toUpperCase();                     // no declarator at all
//
// All three are ordinary code, and the first two are what anybody building a label
// writes. So the RHS now tolerates BALANCED braces (two levels, which is what
// `{{ … }}` and `` `${…}` `` need) while still ending at the statement's `;`, and the
// scan runs in two more passes:
//
//   * a NAME ALIAS is a local bound to a name expression with no casing on it
//     (`const shown = med.name`). Harmless by itself — it is what half the tree does.
//   * an ASSIGNMENT, declarator or not, that applies a casing transform to a name, to
//     a name alias, or to an already-cased binding, marks its target cased. Repeated
//     to a fixpoint, so a three-step hoist is caught as readily as a two-step one.
//
// WHAT IS STILL OUT OF REACH, said plainly rather than left for the next reviewer to
// find, because this rule reads ONE FILE'S TEXT and is not a parser. FOUR entries,
// and the fourth used to be missing here while the test's header carried it — which
// is the worst place for a gap list to disagree with itself, since the module is
// where a reader looks first:
//   * a COMPONENT that cases its own children — `<Shout>{med.name}</Shout>` — because
//     the casing lives in `Shout`'s definition and the call site is textually
//     identical to correct code;
//   * a cased name that leaves the file and comes back — through a prop, a helper's
//     return value, a context, a module-level function in another file;
//   * an alias chain that passes through a shape with no `=` in it, such as a
//     destructure or a function parameter;
//   * a casing call inside a CALLBACK BODY, which the right-hand side below stops at
//     ON PURPOSE (see the RHS comment). That one is a choice rather than a limit:
//     reaching in names shipped list filters that lower-case a name to COMPARE, and
//     a guard that cries wolf on those does not survive to catch anything. It is
//     still a shape the census cannot see, so it belongs on this list.
// Deciding the first three takes a cross-file graph. The census claims what it
// measures — these four mechanisms, in the spellings the test plants — and no more.

// The right-hand side of an assignment: everything up to the statement's `;`. Two
// brace shapes are admitted and no others, which is the whole of the widening:
//
//   * a `${…}` template interpolation, anywhere in the RHS;
//   * an object literal, only when the RHS OPENS with it.
//
// A `{` in any other position still ends the match — so `= useMemo(() => { … })` and
// `= () => { … }` stop at the block body exactly as before. That restraint is not
// fastidiousness: reaching into callback bodies pulled three shipped locals into the
// binding set on the first attempt (`filtered`, `flatFiltered`, `canonicalLower` —
// list filters that lower-case a name to COMPARE), and a rule that starts naming
// those is the rule that gets deleted for crying wolf, taking the real one with it.
//
// ONE OF THE THREE IS IN THE BINDING SET ANYWAY, and this was claimed the other way
// round until review measured it. `canonicalLower` (app/(app)/results/clinical-results/
// view/page.tsx:183) is `const canonicalLower = canonical.toLowerCase()` — a plain
// declarator, no callback around it — so the ALIAS pass registers `canonical` and this
// pass then marks `canonicalLower` cased. The restraint above never excluded it; only
// `filtered` and `flatFiltered` are kept out by it. It costs nothing, because a
// binding is not a hit: `canonicalLower` is a compare key and is never rendered, so
// `nameCasingHits` stays empty for that file. Worth stating rather than leaving as a
// surprise for whoever next reads this comment as a promise about the set.
const BRACED = String.raw`\{(?:[^{}]|\{[^{}]*\})*\}`;
// An optional leading object literal, then everything up to the `;` with `${…}`
// admitted. The leading group is OUTSIDE the repetition on purpose — inside it, an
// object literal would be allowed at any position and the restraint above would be
// no restraint at all.
const RHS = String.raw`(?:${BRACED})?(?:\$${BRACED}|[^;{}]){0,240}`;

const DECLARED_BINDING_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(${RHS})`,
  "g"
);

// Any assignment, declared or not — `shown = shown.toUpperCase()` has no declarator
// and was invisible to a rule that required one. `!=`, `==`, `>=` and `=>` are
// excluded so a comparison or an arrow is never read as a binding.
const ASSIGNMENT_RE = new RegExp(
  String.raw`(?<![=!<>])\b([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(${RHS})`,
  "g"
);

// A casing transform applied to one of the locals we already know carries a name.
function casingOnLocal(rhs: string, locals: Set<string>): boolean {
  for (const v of locals) {
    const id = v.replace(/\$/g, "\\$");
    if (
      new RegExp(`(?<![\\w$.])${id}(?![\\w$])\\s*${CASING}`).test(rhs) ||
      new RegExp(`${CASING}\\s*(?<![\\w$.])${id}(?![\\w$])`).test(rhs)
    )
      return true;
  }
  return false;
}

// The local identifiers this source binds a cased name to. Exported so the guard can
// assert on WHICH binding it found rather than only on the verdict.
export function casedNameBindings(source: string): string[] {
  const cached = bindingCache.get(source);
  if (cached) return [...cached];

  const clean = cleanSource(source);

  // Locals holding a name with no casing on them yet — `const shown = med.name`.
  // Not an offence; the material for the two-step one.
  const aliases = new Set<string>();
  for (const m of clean.matchAll(DECLARED_BINDING_RE)) {
    const rhs = m[2] ?? "";
    if (NAME_IN_INTERP.test(rhs) && !CASING_ON_NAME.test(rhs))
      aliases.add(m[1]);
  }

  const cased = new Set<string>();
  const assignments = [...clean.matchAll(ASSIGNMENT_RE)].map(
    (m) => [m[1], m[2] ?? ""] as const
  );
  // To a fixpoint: an alias cased into a second local, then rendered, is the same
  // offence one hop further out. Bounded by the number of assignments, so it
  // terminates on any input.
  for (let pass = 0; pass < assignments.length + 1; pass += 1) {
    let grew = false;
    for (const [target, rhs] of assignments) {
      if (cased.has(target)) continue;
      if (
        CASING_ON_NAME.test(rhs) ||
        casingOnLocal(rhs, aliases) ||
        casingOnLocal(rhs, cased) ||
        // A bare re-binding of an already-cased local — `const shown = shout;` —
        // carries the cased name onward untouched. Only an EXACT re-binding, so
        // `const n = shout.length` is not condemned by mentioning one.
        cased.has(rhs.trim())
      ) {
        cased.add(target);
        grew = true;
      }
    }
    if (!grew) break;
  }
  const bindings = [...cased];
  bindingCache.set(source, bindings);
  return [...bindings];
}

// Does this interpolation render one of those bindings? A word-boundary match, so
// `shown` does not match `shownAt` or `x.shown`.
function rendersBinding(body: string, bindings: string[]): boolean {
  return bindings.some((v) =>
    new RegExp(`(?<![\\w$.])${v.replace(/\$/g, "\\$")}(?![\\w$])`).test(body)
  );
}

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
  const cached = renderSiteCache.get(source);
  if (cached) return cached.map((hit) => ({ ...hit }));

  const clean = cleanSource(source);
  const bindings = CASING_CALL_GATE.test(source)
    ? casedNameBindings(source)
    : [];
  const hits: CensusHit[] = [];
  for (const m of clean.matchAll(RENDER_RE)) {
    const body = m[1] ?? "";
    if (!NAME_IN_INTERP.test(body) && !rendersBinding(body, bindings)) continue;
    hits.push({ text: body.trim(), line: lineOf(clean, m.index) });
  }
  renderSiteCache.set(source, hits);
  return hits.map((hit) => ({ ...hit }));
}

// Every name render that applies a casing transform on the way to the DOM — the
// offending shape. A subset of nameRenderSites by construction, so a green sweep is
// only meaningful beside that count.
export function nameCasingHits(source: string): CensusHit[] {
  const bindings = casedNameBindings(source);
  return nameRenderSites(source).filter(
    (h) => CASING_ON_NAME.test(h.text) || rendersBinding(h.text, bindings)
  );
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
  const clean = cleanSource(source);
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
  const clean = cleanSource(source);
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

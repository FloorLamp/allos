// THE TAP FLOOR'S REACH (#3486 part 3, under the #3514 ruling), in one place.
//
// #3510 declared the height floor on the `.btn` family — `.btn`, `.btn-ghost`,
// `.btn-danger` — and collapsed two hand-fixed call sites into it. That was the
// right call and the alternative was the per-site sprinkle this project rejects.
// But **the family is not the same set as "controls that need a floor"**, and
// nothing said so: `StarButton` rendered 36px beside a 40px `.btn` toggle on
// /trends/metric/weight, in one row, on a head where #3486's fix had shipped.
// #3529's geometry probe found it on its first real run.
//
// The instance is fixed. This module is the CLASS — the thing #3486's own
// comment asked for ("census for the class rather than fix the instance: a
// control with a hard `h-*` and an interactive role, outside the family, is
// enumerable") and the thing `docs/internals/design-system.md` §5 records as the
// tap-floor row's one OPEN item.
//
// `lib/__tests__/tap-floor-reach.test.ts` sweeps the tree with it.
//
// ── THE RULING THIS ENCODES ─────────────────────────────────────────────────
//
// Owner ruling on #3514 (2026-08-21): the tap floor is **44px EFFECTIVE target,
// everywhere**, met by either registered mechanism —
//
//   RENDERED — the control's own box is >= 44 (`min-h-11`, or membership of the
//   `.btn` family, whose below-`sm` rule in app/globals.css is `min-block-size:
//   2.75rem`).
//
//   HIT AREA — a deliberately smaller rendered control extended to >= 44
//   effective by the shared overlay: `.tap-target` uses `inset: -6px` around a
//   32px box (#644), while `chip-sm` uses 11px around its 22px painted box.
//
// Rendered height and hit area are different guarantees, so a rule says which it
// means. A control using NEITHER mechanism is the defect.
//
// ── AND THE HIT-AREA MECHANISM HAS AN ARITHMETIC PRECONDITION ───────────────
//
// This is what the census found that the ruling's prose does not say out loud.
// `inset: -6px` adds SIX PIXELS PER SIDE, so it turns a rendered box of `h` into
// `h + 12` — which reaches 44 only from 32px up. `.tap-target` on a 28px stepper
// yields 40 effective; on a 24px chip `x` it yields 36. Both are below the ruled
// floor while carrying a class that reads as compliance, and that is strictly
// worse than a bare undersized control: it is a control the floor believes it has
// already reached.
//
// The arithmetic is written down exactly once in the tree today — in
// `app/globals.css`'s `table-cards` rule, for one call site: "the visible control
// occupies 32px in layout while its pseudo-element extends the clickable button
// box to 44px — 32 + 2x6". `TAP_TARGET_MIN_RENDERED_PX` below is that sentence as
// a number every site can be checked against, and the guard reads the inset back
// out of `app/globals.css` so the two cannot drift apart.
//
// ── WHAT THIS SCAN CAN AND CANNOT SEE ───────────────────────────────────────
//
// It reads a control's below-`sm` height OUT OF ITS CLASS LIST. That is a real
// bound on the claim and it is stated rather than hidden: a control that PINS its
// height is judged here, and a control whose height is whatever its content
// happens to be is not — the latter needs a rendered measurement, which is
// `e2e/button-height-floor.mobile.spec.ts` for the family and #3489's geometry
// probe for the rest. Source and geometry answer different halves of one
// question and neither subsumes the other; the family's own floor shipped
// green against a class-string check and was caught by a bounding box.
//
// The half this DOES own is the half a rendered probe cannot: every route, every
// state, every control that never renders in a spec.

/** The floor, as a number of CSS pixels of EFFECTIVE target. #3514's ruling. */
export const TAP_FLOOR_PX = 44;

/**
 * `.tap-target`'s per-side extension, `inset: -6px` (#644). The guard asserts
 * this still matches `app/globals.css` rather than trusting the copy.
 */
export const TAP_TARGET_INSET_PX = 6;

/**
 * The smallest RENDERED box from which `.tap-target` still reaches the floor.
 * Derived, never spelled: the overlay adds one inset per side.
 */
export const TAP_TARGET_MIN_RENDERED_PX =
  TAP_FLOOR_PX - 2 * TAP_TARGET_INSET_PX;

/** Which registered mechanism a control uses to meet the floor, if any. */
export type FloorMechanism =
  /** Membership of the `.btn` family — the floor arrives from app/globals.css. */
  | "btn-family"
  /** Its own rendered box is already >= the floor. */
  | "rendered"
  /** `.tap-target`'s hit-area overlay. */
  | "tap-target"
  /** `chip-sm`'s measured 11px-per-side variant of the hit-area overlay. */
  | "chip-sm"
  /**
   * The class list could not be read, so NO mechanism can be established. This
   * is not a verdict — it is the absence of one, made countable. See
   * `UNREADABLE` below.
   */
  | "unreadable"
  /** Neither. This is the defect the class exists to enumerate. */
  | "none";

/**
 * What kind of control it is. The kind is not decoration — it is what licenses
 * an exemption, and each licence below is a claim that can go false.
 */
export type ControlKind =
  /** `<button>`. */
  | "button"
  /** `<a>` — a door, but a tapped one. */
  | "link"
  /** `<select>` / `<textarea>` / a typed `<input>` that takes text. */
  | "field"
  /** `<input type="checkbox">` / `<input type="radio">` — the native box. */
  | "native-box"
  /** `<input type="range">` — the TRACK, which is not the thumb. */
  | "range"
  /** Any other element made interactive by `onClick` or an interactive `role`. */
  | "handler";

/** One control the tap floor has an opinion about, found in one file. */
export type FlooredControl = {
  /** 1-based line of the opening tag. */
  line: number;
  /** The lowercase DOM tag. */
  tag: string;
  kind: ControlKind;
  /**
   * The rendered height this control PINS for itself below `sm`, in CSS pixels,
   * or null when it pins none and its height is its content's.
   */
  belowSmPx: number | null;
  mechanism: FloorMechanism;
  /**
   * For a `native-box`: whether a `<label>` takes the tap on its behalf — either
   * by wrapping it, or by naming its `id` in an `htmlFor`. This is the premise
   * that licenses a 16px checkbox, and it is checked per site rather than
   * assumed, so a bare unlabelled box is still a finding.
   */
  labelled: boolean;
  /**
   * The class list this scan judged: literal text where it could be resolved,
   * and the EXPRESSION AS WRITTEN where it could not. Read it with `readable`.
   */
  className: string;
  /**
   * Whether `className` is class text or an expression nobody resolved. False
   * means every field above is the absence of a verdict rather than one:
   * `belowSmPx` is null because nothing was read, not because nothing is pinned
   * (#3561). The census rosters these; it does not clear them.
   */
  readable: boolean;
};

/** Raised when the scan meets a control whose height it cannot read. */
export class UnreadableControlError extends Error {}

// ── Source reading ──────────────────────────────────────────────────────────

/**
 * The same source with every comment blanked — spaces for the comment's
 * characters, newlines kept — so line numbers still match the file on disk.
 *
 * PROSE IS NOT CODE, and this rule's subject files argue about it in prose:
 * `app/globals.css` and half a dozen components explain `h-8`, `min-h-11` and
 * `.tap-target` in sentences. A scan over raw source reads those as call sites
 * (#3509: an e2e census once counted a `.first()` written in English, and
 * Tailwind's content scanner once compiled a class out of a comment).
 *
 * Shared in spirit with `lib/add-affordance-grammar.ts`'s copy and deliberately
 * NOT imported from it: that module blanks comments for the affordance grammar's
 * own reasons and its signature is free to change with that rule. One helper
 * serving two unrelated sweeps is a coupling nobody would want to discover from
 * a failing test in the other one.
 */
export function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      for (; i < stop; i += 1) out += source[i] === "\n" ? "\n" : " ";
      continue;
    }
    // A string may contain `//` (a URL, a regex source) and must survive intact.
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      if (i < source.length) {
        out += source[i];
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * The opening tag starting at `from`, and the index just past it. Brace-aware,
 * because a JSX prop is routinely `{() => …}` and a scan to the first `>` stops
 * inside an arrow function.
 */
export function openingTag(
  source: string,
  from: number
): { tag: string; end: number } {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === ">" && depth === 0) {
      return { tag: source.slice(from, i + 1), end: i + 1 };
    }
  }
  throw new Error(
    `unterminated JSX tag at offset ${from}: ${source.slice(from, from + 60)}`
  );
}

/** The span of `<el …>…</el>`, given the index of its `<`. */
export function elementSpan(
  source: string,
  start: number,
  name: string
): { start: number; end: number } {
  const { end: afterOpen } = openingTag(source, start);
  if (source[afterOpen - 2] === "/") return { start, end: afterOpen };
  let depth = 1;
  const open = new RegExp(`<${name}(?=[\\s>])`, "g");
  const close = new RegExp(`</${name}\\s*>`, "g");
  let i = afterOpen;
  while (i < source.length) {
    open.lastIndex = i;
    close.lastIndex = i;
    const o = open.exec(source);
    const c = close.exec(source);
    if (!c) return { start, end: source.length };
    if (o && o.index < c.index) {
      depth += 1;
      i = o.index + 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return { start, end: c.index + c[0].length };
    i = c.index + 1;
  }
  return { start, end: source.length };
}

/**
 * The `className` as written, and WHICH OF TWO THINGS it is: the text of a quoted
 * string, or the SOURCE of a `className={…}` expression.
 *
 * Keeping those apart is the whole of #3561. A quoted string IS the class list; an
 * expression is a program that produces one, and reading its source as though it
 * were class text is how `className={ARROW_HIT}` came back as the class list
 * `"ARROW_HIT"` — a nine-letter word with no height token in it, indistinguishable
 * from a control that pins no height. `resolveClassName` below is what turns the
 * second kind into the first, or refuses.
 */
export function classNameExpression(
  tag: string
): { literal: boolean; text: string } | null {
  const m = /(?<![\w-])className\s*=\s*/.exec(tag);
  if (!m) return null;
  const at = m.index + m[0].length;
  const quote = tag[at];
  if (quote === '"' || quote === "'") {
    const end = tag.indexOf(quote, at + 1);
    return {
      literal: true,
      text: end < 0 ? tag.slice(at + 1) : tag.slice(at + 1, end),
    };
  }
  if (quote === "{") {
    let depth = 0;
    for (let i = at; i < tag.length; i += 1) {
      if (tag[i] === "{") depth += 1;
      else if (tag[i] === "}") {
        depth -= 1;
        if (depth === 0) return { literal: false, text: tag.slice(at + 1, i) };
      }
    }
  }
  return null;
}

// ── Reading a class list that is not written where the control is ───────────
//
// WHY THIS EXISTS, AND WHICH DIRECTION IT USED TO FAIL. `classNameOf` returns
// what is written inside `className={…}` VERBATIM, so a hoisted constant came
// back as its own IDENTIFIER — `className={ARROW_HIT}` yielded the nine-letter
// string `"ARROW_HIT"`. No height token matched, `belowSmHeightPx` returned
// null, and `floorMiss` returned null on its first line: no throw, no finding,
// no record that the control had ever been considered. The module threw on an
// unreadable HEIGHT TOKEN and stayed silent on an unreadable CLASS LIST, which
// is the wrong half — an unreadable token is one control the scan knows it
// lost, an unreadable class list is one it does not (#3561).
//
// It was hiding three live controls at the time: `TrainingLogCalendar`'s two
// month arrows and its day link, all `h-10` (40px) below `sm`, sized correctly
// against the floor as it stood at #3377 and left behind when #3514 ruled it to
// 44. Exactly the population the ruling was meant to sweep, invisible to the
// instrument built to enumerate it.
//
// `lib/__tests__/mobile-density-convention.test.ts` carries the same remedy for
// the same reason and is worth reading beside this (#3509): resolve, then read
// only literal text, and never let unresolved text pass as read.
//
// TWO WAYS TO FAIL, AND WHICH ONE IS WHOSE FAULT DECIDES THE DIRECTION:
//
//   THE SCAN CANNOT PARSE WHAT IT WAS GIVEN — an unterminated string, template
//   or `${…}` hole. That is this module being wrong about the language, not the
//   tree being unusual, and it THROWS `UnreadableControlError`, exactly as an
//   unpriceable height token does. A parser that quietly returns nothing on
//   source it does not understand is the failure this whole file is built
//   against.
//
//   THE CLASS TEXT IS COMPOSED SOMEWHERE ELSE — a forwarded `className` prop, a
//   `.map()` variable, a field of an imported data table, a helper that returns
//   a computed plan. Resolution bottoms out on an identifier with no text behind
//   it, and NO edit to the file being scanned can change that. Those controls
//   come back `readable: false` with `mechanism: "unreadable"`, and the census
//   rosters them EXACTLY — so the blind spot has a size, and a new one is red
//   until someone records it. That is the shape `UNJUDGED_TAP_TARGETS` already
//   uses one level down, and it is fail-closed in the sense that matters: the
//   number can only move when a person looks at it.
//
// The outcome that must never come back is the third one, which is what this
// module used to do: an unreadable class list reported as a readable one that
// pins no height.

/**
 * A module reached by following an import: its (comment-blanked) source, and a
 * reader for ITS OWN specifiers.
 *
 * The second half is what makes a BARREL readable, and the tree is full of them.
 * `BottomSheet` imports `OVERLAY_SCRIM` from `"./overlay"`, which is an
 * `index.ts` holding `export { OVERLAY_SCRIM } from "./tokens"`; `CardioFields`
 * imports `blockedField` from `"./model"`, which is `export * from
 * "@/lib/activity-form-model"`. Resolving `"./tokens"` against the file that
 * started the chain points at the wrong directory, so each module carries the
 * reader for the next hop rather than the scan guessing.
 */
export type ImportedModule = { source: string; readModule: ModuleReader };

/**
 * Reads the module a specifier names, written exactly as the importer wrote it
 * (`"@/components/OverflowMenu"`, `"./tokens"`). Returns null when it is not one
 * this corpus can follow — a package, a `.css` file.
 *
 * The caller owns path resolution because it owns the corpus: the census points
 * the same walk at the tree and at a temp directory, and neither this module nor
 * this signature should know which.
 *
 * The source handed back MUST be `withoutComments`-blanked, like the source
 * being scanned.
 */
export type ModuleReader = (specifier: string) => ImportedModule | null;

/**
 * A declaration this scan can substitute: the identifier, and the EXPRESSION
 * SOURCE it stands for.
 *
 * A function declaration whose body is a single `return` is normalised to an
 * arrow, so the call path below has one shape to handle rather than two. Both
 * spellings are in the tree — `function chipClass(pressed) { return … }` and
 * `const rowClass = (active) => …` — and they are the same thing.
 */
export type ClassDeclarations = Map<string, string | typeof AMBIGUOUS>;

/** Marks a name declared more than once: which one a call site meant is a guess. */
const AMBIGUOUS = Symbol("declared more than once");

const CONST_DECL =
  /^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=[ \t]*/gm;
const FN_DECL =
  /^[ \t]*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))[^{]*\{/gm;

/**
 * The expression a declaration is bound to: everything from `from` up to the `;`
 * that ends the statement, at bracket depth zero.
 *
 * SCANNED, NOT MATCHED, and the difference is not stylistic. A non-greedy
 * `([\s\S]*?);$` stops at the first `;` that ends a line, which inside a block
 * body is a statement in the MIDDLE of the declaration — `StrengthSets`'
 * `const sideFlags = (w, r, d) => {` came back truncated at its first inner
 * statement, brackets unbalanced, and every scan downstream then reported the
 * class list unreadable. A declaration read wrong is worse than one not read.
 */
function declarationValue(source: string, from: number): string | null {
  let depth = 0;
  let i = from;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < source.length && source[i] !== c)
        i += source[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "`") {
      i = endOfTemplate(source, i) + 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (c === ";" && depth === 0) return source.slice(from, i);
    i += 1;
  }
  return null;
}

function collectDeclarations(source: string, into: ClassDeclarations): void {
  const record = (name: string, text: string | null) => {
    if (text === null) return;
    into.set(
      name,
      into.has(name)
        ? AMBIGUOUS
        : text.includes("//") || text.includes("/*")
          ? blankExpressionComments(text)
          : text
    );
  };
  for (const m of source.matchAll(CONST_DECL))
    record(m[1], declarationValue(source, m.index + m[0].length));
  for (const m of source.matchAll(FN_DECL)) {
    // The opening brace is the last character the pattern matched.
    const brace = m.index + m[0].length - 1;
    const shut = closingBracket(source, brace);
    if (shut < 0) continue;
    const body = source.slice(brace + 1, shut).trim();
    // Only a single-`return` helper is a class-text function; anything else is
    // a program, and this scan does not run programs.
    if (!/^return\s/.test(body) || !body.endsWith(";")) continue;
    record(m[1], `${m[2]} => ${body.slice(6, -1)}`);
  }
}

/**
 * Every name whose class text this scan can reach from one file: the file's own
 * `const`s and single-`return` functions, plus the named exports it imports from
 * a module the reader can supply.
 *
 * ONE HOP, NOT A GRAPH — but the imported module's own constants are folded into
 * its exports first, because that is how the tree actually writes them:
 * `export const OVERLAY_SCRIM` is built from a `OVERLAY_SCRIM_TINT` that never
 * crosses the import, and a reader stopping at the export gets nothing.
 *
 * FILE-LOCAL AND MODULE-LOCAL ARE BOTH COLLECTED, deliberately. The precedent in
 * `mobile-density-convention` anchors on `^const` and so takes module scope only;
 * here a component's own `const STEP_CLASS = …` inside the function body is the
 * commonest spelling of the very thing this rule needs to read, and refusing it
 * would leave `PaginationControls`' three steppers unreadable for no gain. The
 * safety that gives up is bought back by AMBIGUOUS: a name declared twice in one
 * file resolves to nothing, because which one a call site meant is a guess.
 */
export function classDeclarations(
  source: string,
  readModule?: ModuleReader
): ClassDeclarations {
  const declared: ClassDeclarations = new Map();
  collectDeclarations(source, declared);
  if (!readModule) return declared;
  for (const m of source.matchAll(
    /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g
  )) {
    const names = importedNames(m[1]);
    if (names.size === 0) continue;
    const dependency = readModule(m[2]);
    if (dependency === null) continue;
    const reached = reachableExports(
      [...names.values()],
      dependency,
      IMPORT_HOPS
    );
    for (const [local, exported] of names) {
      const value = reached.get(exported);
      if (value === undefined) continue;
      declared.set(local, declared.has(local) ? AMBIGUOUS : value);
    }
  }
  return declared;
}

/**
 * How many `export … from` hops a barrel may add. The tree's deepest is ONE —
 * `./overlay`'s index re-exporting `./tokens`, and `./model`'s `export *` — and
 * three leaves room for a barrel of barrels without licensing a graph walk.
 */
const IMPORT_HOPS = 3;

/** `{ A, B as C, type D }` -> local name -> exported name, types dropped. */
function importedNames(list: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of list.split(",")) {
    const text = part.trim();
    if (text === "" || text.startsWith("type ")) continue;
    const [exported, local] = text.split(/\s+as\s+/).map((x) => x.trim());
    const name = local ?? exported;
    if (/^[A-Za-z_$][\w$]*$/.test(exported) && /^[A-Za-z_$][\w$]*$/.test(name))
      out.set(name, exported);
  }
  return out;
}

/**
 * One module's own declarations, and the class text behind each export already
 * asked for — memoised on the module object the reader handed back.
 *
 * A HANDFUL OF TOKEN MODULES IS IMPORTED BY HUNDREDS OF FILES, and without this
 * their whole source was re-scanned once per importer: a tree census went from
 * ~0.35s to ~5s, which is a test file that times out on a loaded CI box rather
 * than a slow one. Keyed on object identity, so a reader that caches its modules
 * (the census does) gets the reuse and one that does not is merely slower — never
 * wrong, and never stale, because a re-read produces a new object.
 */
const MODULE_MEMO = new WeakMap<
  ImportedModule,
  { own: ClassDeclarations; resolved: ClassDeclarations }
>();

function memoFor(module: ImportedModule) {
  let memo = MODULE_MEMO.get(module);
  if (memo === undefined) {
    const own: ClassDeclarations = new Map();
    collectDeclarations(module.source, own);
    memo = { own, resolved: new Map() };
    MODULE_MEMO.set(module, memo);
  }
  return memo;
}

/**
 * The class text behind each requested export of one module, following its own
 * `export … from` re-exports when it does not declare them itself.
 *
 * A module's constants are folded into its exports BEFORE they cross the import,
 * because the importing file cannot see them and never could.
 */
function reachableExports(
  wanted: string[],
  module: ImportedModule,
  hops: number
): ClassDeclarations {
  const { own, resolved } = memoFor(module);
  const out: ClassDeclarations = new Map();
  for (const name of wanted) {
    const already = resolved.get(name);
    if (already !== undefined) {
      out.set(name, already);
      continue;
    }
    const value = own.get(name);
    if (value === undefined) continue;
    const text = value === AMBIGUOUS ? AMBIGUOUS : substitute(value, own);
    resolved.set(name, text);
    out.set(name, text);
  }
  if (hops <= 0) return out;
  for (const m of module.source.matchAll(
    /export\s+(?:\{([^}]*)\}|\*)\s*from\s*"([^"]+)"/g
  )) {
    const still = wanted.filter((name) => !out.has(name));
    if (still.length === 0) break;
    // A named re-export forwards only what it lists; `export *` forwards all.
    const listed = m[1] === undefined ? null : importedNames(m[1]);
    const ask =
      listed === null ? still : still.filter((name) => listed.has(name));
    if (ask.length === 0) continue;
    const next = module.readModule(m[2]);
    if (next === null) continue;
    const under = listed === null ? ask : ask.map((name) => listed.get(name)!);
    const reached = reachableExports(under, next, hops - 1);
    for (let i = 0; i < ask.length; i += 1) {
      const value = reached.get(under[i]);
      if (value !== undefined) out.set(ask[i], value);
    }
  }
  return out;
}

/**
 * The same expression with every comment blanked to spaces, offsets intact.
 *
 * `withoutComments` cannot do this and should not try: it treats a template
 * literal as OPAQUE, which is right for a file (a `//` inside a string is not a
 * comment) and wrong for a `${…}` hole, which is code. This app writes comments
 * inside those holes — `StarButton`, `IntensityPicker` and `StrengthSets` all
 * explain a class choice there — and an unblanked one is a live hazard rather
 * than noise: its prose carries apostrophes and backticks, which every scanner
 * below reads as an unterminated string and gives up on. Three controls were
 * lost to exactly that before this existed.
 */
function blankExpressionComments(expression: string): string {
  const out = expression.split("");
  // A stack of what we are inside: template TEXT, or the CODE of a `${…}` hole.
  const stack: ("text" | "code")[] = ["code"];
  let depth = 0;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1)
      if (out[k] !== "\n") out[k] = " ";
  };
  while (i < expression.length) {
    const c = expression[i];
    const here = stack[stack.length - 1];
    if (here === "text") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        i += 1;
        continue;
      }
      if (c === "$" && expression[i + 1] === "{") {
        stack.push("code");
        depth = 0;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === "/" && expression[i + 1] === "/") {
      const end = expression.indexOf("\n", i);
      blank(i, end < 0 ? expression.length : end);
      i = end < 0 ? expression.length : end;
      continue;
    }
    if (c === "/" && expression[i + 1] === "*") {
      const end = expression.indexOf("*/", i + 2);
      blank(i, end < 0 ? expression.length : end + 2);
      i = end < 0 ? expression.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < expression.length && expression[i] !== c)
        i += expression[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "`") {
      stack.push("text");
      i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      if (depth === 0 && stack.length > 1) {
        stack.pop();
        i += 1;
        continue;
      }
      depth -= 1;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * The index of the bracket closing the one that opens at `open`, or -1.
 *
 * STRING-AWARE, and it has to be: a class list is mostly quoted text, and a
 * brace-counting scan that reads `"}"` as a closer walks off the end of the
 * expression and reports the whole thing unreadable.
 */
function closingBracket(text: string, open: number): number {
  const shut = { "(": ")", "[": "]", "{": "}" }[text[open]];
  if (shut === undefined) return -1;
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "`") {
      i = endOfTemplate(text, i) + 1;
      continue;
    }
    if (c === text[open]) depth += 1;
    else if (c === shut) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** The index of the backtick closing the template opening at `open`, or the end. */
function endOfTemplate(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length && text[i] !== "`") {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "$" && text[i + 1] === "{") {
      const shut = closingBracket(text, i + 1);
      i = shut < 0 ? text.length : shut + 1;
      continue;
    }
    i += 1;
  }
  return i;
}

/** The top-level values of an object literal, or null when it is not one. */
function objectValues(expression: string): string[] | null {
  const text = expression.trim();
  if (!text.startsWith("{") || closingBracket(text, 0) !== text.length - 1)
    return null;
  const inner = text.slice(1, -1);
  const values: string[] = [];
  let depth = 0;
  let colon = -1;
  for (let i = 0; i <= inner.length; i += 1) {
    const c = inner[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === ":" && depth === 0 && colon < 0) colon = i;
    if (i === inner.length || (c === "," && depth === 0)) {
      if (colon >= 0) values.push(inner.slice(colon + 1, i));
      colon = -1;
    }
  }
  return values.length > 0 ? values : null;
}

/**
 * The body of an arrow function `(a, b) => body`, or null — including when the
 * body is a BLOCK, which is a program rather than an expression this scan can
 * read.
 */
function arrowBody(expression: string): string | null {
  const text = expression.trim();
  if (!text.startsWith("(")) return null;
  const shut = closingBracket(text, 0);
  if (shut < 0) return null;
  const rest = text.slice(shut + 1).trimStart();
  if (!rest.startsWith("=>")) return null;
  const body = rest.slice(2).trim();
  return body.startsWith("{") ? null : body;
}

/**
 * How many single replacements one class list may take. Bounded so a cyclic or
 * self-referential declaration dies here instead of hanging, and generous because
 * hitting it is a BUG rather than a budget: the deepest class list in the tree
 * needs SIX (measured 2026-08-23, over app/ and components/), and the first draft
 * needed hundreds only because it could substitute into text it had just written.
 */
const SUBSTITUTION_LIMIT = 400;

/**
 * The expression with every reachable identifier replaced by the class text it
 * stands for.
 *
 * A CALL and an INDEX both collapse to the text they COULD produce:
 * `chipClass(active)` becomes the whole body of `chipClass`, and
 * `INPUT_CLASS[variant]` becomes every value of the record. This scan reads every
 * token a class list could carry rather than guessing which branch runs — the
 * same trade `belowSmHeightPx` already makes across a ternary's two arms, and
 * the direction that can only ever produce a false finding, never a missed one.
 */
function substitute(expression: string, declared: ClassDeclarations): string {
  let out = expression;
  for (let step = 0; step < SUBSTITUTION_LIMIT; step += 1) {
    const next = substituteOnce(out, declared);
    if (next === out) return out;
    out = next;
  }
  return out;
}

function substituteOnce(
  expression: string,
  declared: ClassDeclarations
): string {
  const skip = literalSpans(expression);
  for (const m of expression.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
    const at = m.index;
    if (skip.some((span) => at >= span.start && at < span.end)) continue;
    const value = declared.get(m[0]);
    if (value === undefined || value === AMBIGUOUS) continue;
    // AN IDENTIFIER IN A CONDITION IS LEFT ALONE, and this is not an
    // optimisation. `MoodValencePicker` writes `selected ? … : …`, where
    // `selected` is `value === score` and `score` is `index + 1` and `index` is a
    // `.map()` parameter — expanding a test that could never contribute class text
    // walked the resolver into an identifier with no text behind it and reported a
    // wholly literal class list as unreadable. Substitute what a browser would
    // CONCATENATE, not what it would evaluate.
    if (
      IDENTIFIER_IN_CONDITION.test(afterPostfix(expression, at + m[0].length))
    )
      continue;
    let end = at + m[0].length;
    let replacement = `(${value})`;
    const rest = expression.slice(end);
    const gap = rest.length - rest.trimStart().length;
    const next = rest.trimStart();
    if (next.startsWith("(")) {
      const body = arrowBody(value);
      const shut = closingBracket(expression, end + gap);
      if (body === null || shut < 0) continue;
      replacement = `(${body})`;
      end = shut + 1;
    } else if (next.startsWith("[") || next.startsWith(".")) {
      const values = objectValues(value);
      if (values === null) continue;
      const shut = next.startsWith("[")
        ? closingBracket(expression, end + gap)
        : -1;
      if (next.startsWith("[") && shut < 0) continue;
      replacement = values.map((v) => `(${v})`).join(" + ");
      end = next.startsWith("[")
        ? shut + 1
        : end + gap + /^\.[\w$]*/.exec(next)![0].length;
    }
    return expression.slice(0, at) + replacement + expression.slice(end);
  }
  return expression;
}

/**
 * The spans of literal TEXT in an expression — a quoted string, and the text
 * chunks of a template literal but NOT its `${…}` holes, which are code.
 *
 * IT MUST DESCEND INTO A HOLE rather than skip it, and the first draft skipped
 * it. A hole's own strings are literals too, so `(variant === "cell")` — itself
 * the result of a substitution — had its `"cell"` read as substitutable code, and
 * `cell` was replaced inside its own replacement, forever, until the bound
 * stopped it. A substitution that can re-enter what it just wrote is not
 * bounded by anything the source contains.
 */
function literalSpans(
  expression: string,
  offset = 0,
  spans: { start: number; end: number }[] = []
): { start: number; end: number }[] {
  let i = 0;
  while (i < expression.length) {
    const c = expression[i];
    if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      while (i < expression.length && expression[i] !== c)
        i += expression[i] === "\\" ? 2 : 1;
      spans.push({ start: offset + start, end: offset + i + 1 });
      i += 1;
      continue;
    }
    if (c === "`") {
      i += 1;
      let chunk = i;
      while (i < expression.length && expression[i] !== "`") {
        if (expression[i] === "\\") {
          i += 2;
          continue;
        }
        if (expression[i] === "$" && expression[i + 1] === "{") {
          spans.push({ start: offset + chunk, end: offset + i });
          const shut = closingBracket(expression, i + 1);
          const stop = shut < 0 ? expression.length : shut;
          literalSpans(expression.slice(i + 2, stop), offset + i + 2, spans);
          i = stop + 1;
          chunk = i;
          continue;
        }
        i += 1;
      }
      spans.push({ start: offset + chunk, end: offset + i });
      i += 1;
      continue;
    }
    i += 1;
  }
  return spans;
}

// An identifier may REMAIN in a resolved expression only where it cannot
// contribute class text: a ternary test, a logical operand, a comparison, a
// member base, an index, an argument list.
const IDENTIFIER_IN_CONDITION =
  /^\s*(\?\?|\?\.|\?|&&|\|\||===|!==|==|!=|>=|<=|>|<|\)|,|\.|\[)/;
const NOT_A_VALUE = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "typeof",
  "in",
]);

/**
 * What follows an identifier once its calls, indexes and member accesses are
 * consumed — so the question asked of it is "does this WHOLE thing sit in a
 * condition", not "does the bare name". `sideFlags(w, r, d).weight ? a : b` is a
 * test; `chipClass(active)` on its own is class text.
 */
function afterPostfix(residue: string, from: number): string {
  let i = from;
  for (;;) {
    const rest = residue.slice(i);
    const gap = rest.length - rest.trimStart().length;
    const next = rest.trimStart();
    if (next.startsWith("(") || next.startsWith("[")) {
      const shut = closingBracket(residue, i + gap);
      if (shut < 0) return rest;
      i = shut + 1;
      continue;
    }
    const member = /^\??\.[\w$]+/.exec(next);
    if (member) {
      i += gap + member[0].length;
      continue;
    }
    return rest;
  }
}

/** What a control's class list turned out to be. */
export type ClassText =
  | { readable: true; text: string }
  /** The identifier whose class text is not in this file. */
  | { readable: false; name: string };

/**
 * The class text a browser would actually see — or a refusal naming the identifier
 * that stopped it. Throws `UnreadableControlError` only when the expression cannot
 * be PARSED at all; see the section header on why those are the two outcomes.
 */
function readClassText(
  expression: string,
  declared: ClassDeclarations
): ClassText {
  const parts: string[] = [];
  let residue = "";
  let i = 0;
  while (i < expression.length) {
    const c = expression[i];
    if (c === '"' || c === "'") {
      const end = expression.indexOf(c, i + 1);
      if (end < 0)
        throw new UnreadableControlError(
          "unterminated string in a class list expression"
        );
      parts.push(expression.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let chunk = "";
      while (j < expression.length && expression[j] !== "`") {
        if (expression[j] === "\\") {
          chunk += expression.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (expression[j] === "$" && expression[j + 1] === "{") {
          parts.push(chunk);
          chunk = "";
          const shut = closingBracket(expression, j + 1);
          if (shut < 0)
            throw new UnreadableControlError(
              "unterminated template hole in a class list expression"
            );
          const inner = readClassText(expression.slice(j + 2, shut), declared);
          if (!inner.readable) return inner;
          parts.push(inner.text);
          j = shut + 1;
          continue;
        }
        chunk += expression[j];
        j += 1;
      }
      if (j >= expression.length)
        throw new UnreadableControlError(
          "unterminated template literal in a class list expression"
        );
      parts.push(chunk);
      i = j + 1;
      continue;
    }
    residue += c;
    i += 1;
  }

  for (const m of residue.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
    if (NOT_A_VALUE.has(m[0])) continue;
    if (
      IDENTIFIER_IN_CONDITION.test(afterPostfix(residue, m.index + m[0].length))
    )
      continue;
    return { readable: false, name: m[0] };
  }
  return { readable: true, text: parts.join(" ") };
}

/**
 * The class list of one opening tag, resolved as far as its file allows.
 *
 * `null` means the tag carries no `className` at all — a different thing from a
 * `className` that cannot be read, which is `{ readable: false }`.
 */
export function resolveClassName(
  openTag: string,
  declared: ClassDeclarations | (() => ClassDeclarations)
): ClassText | null {
  const written = classNameExpression(openTag);
  if (written === null) return null;
  // A quoted class list IS the class text, and asking for the file's declarations
  // to reach that conclusion is what made the census walk every import of every
  // file for the 1223 controls in 1456 that need none.
  if (written.literal) return { readable: true, text: written.text };
  const reachable = typeof declared === "function" ? declared() : declared;
  const expression = blankExpressionComments(written.text);
  return readClassText(substitute(expression, reachable), reachable);
}

// A Tailwind height token with its full variant chain: `h-8`, `sm:h-auto`,
// `max-sm:min-h-11`, `h-[38px]`.
const HEIGHT_TOKEN =
  /(?:^|[\s"'`{}(),:?])((?:[a-z0-9.-]+:)*)(min-h|h)-(\[[^\]]*\]|[\d.]+|px|auto|full|screen|fit|min|max)(?![\w.[-])/g;

/** A Tailwind spacing value as CSS pixels, or null when it is not a length. */
function scaleToPx(value: string): number | null {
  if (value === "px") return 1;
  if (value.startsWith("[")) {
    const inner = value.slice(1, -1);
    const px = /^(\d+(?:\.\d+)?)px$/.exec(inner);
    if (px) return Number(px[1]);
    const rem = /^(\d+(?:\.\d+)?)rem$/.exec(inner);
    if (rem) return Number(rem[1]) * 16;
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n * 4 : null;
}

/**
 * The rendered height this class list pins BELOW `sm`, in CSS pixels — or null
 * when it pins none.
 *
 * WHY BELOW `sm` IS THE WHOLE QUESTION. The family's floor is
 * `@media (max-width: 639.98px)` and nothing else: desktop density keeps its
 * compact rows, where a mouse is doing the pointing. So a `sm:h-11` is not an
 * answer to anything this rule asks, and reading it as one is how a 36px phone
 * control passes a floor check — the exact mistake shape a `min(all h-* tokens)`
 * scan makes. Only an UNPREFIXED token and a `max-sm:` one govern below `sm`,
 * and `max-sm:` wins over the unprefixed base because it is the narrower query.
 *
 * `h-auto` / `h-full` / `h-fit` and friends UNPIN it: the height goes back to
 * being the content's, which this scan does not claim to know.
 */
export function belowSmHeightPx(className: string): number | null {
  let base: number | null = null;
  let basePinned = false;
  let narrow: number | null = null;
  let narrowPinned = false;
  for (const m of className.matchAll(HEIGHT_TOKEN)) {
    const variants = m[1] ? m[1].slice(0, -1).split(":") : [];
    const governsBelowSm = variants.length === 0;
    const governsNarrowly = variants.length === 1 && variants[0] === "max-sm";
    if (!governsBelowSm && !governsNarrowly) continue;
    const px = scaleToPx(m[3]);
    if (governsNarrowly) {
      narrowPinned = true;
      narrow = px;
    } else {
      basePinned = true;
      base = px;
    }
  }
  if (narrowPinned) return narrow;
  if (basePinned) return base;
  return null;
}

/** True when this class list names a `.btn`-family member. */
export function inButtonFamily(className: string): boolean {
  return /(?:^|[\s"'`{}(),:?])btn(?:-ghost|-danger|-sm)?(?![\w-])/.test(
    className
  );
}

/** True when this class list carries `.tap-target`. */
export function usesTapTarget(className: string): boolean {
  return /(?:^|[\s"'`{}(),:?])tap-target(?![\w-])/.test(className);
}

/** True when this class list carries the dense chip hit-area mechanism. */
export function usesChipSm(className: string): boolean {
  return /(?:^|[\s"'`{}(),:?])chip-sm(?![\w-])/.test(className);
}

const INTERACTIVE_TAGS = new Set([
  "button",
  "a",
  "select",
  "textarea",
  "input",
  "summary",
]);

const INTERACTIVE_ROLE =
  /role\s*=\s*"(button|tab|switch|menuitem|menuitemcheckbox|menuitemradio|option|checkbox|radio|link)"/;

function kindOf(tag: string, openTag: string): ControlKind {
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "a") return "link";
  if (tag === "select" || tag === "textarea") return "field";
  if (tag === "input") {
    const type = /(?<![\w-])type\s*=\s*"([^"]*)"/.exec(openTag)?.[1] ?? "text";
    if (type === "checkbox" || type === "radio") return "native-box";
    if (type === "range") return "range";
    return "field";
  }
  return "handler";
}

/**
 * Every interactive control in one file's source, with what the tap floor makes
 * of it.
 *
 * `source` must already be `withoutComments`-blanked; passing raw source is the
 * #3509 mistake and this function cannot detect it for you.
 *
 * WHICH DIRECTION THIS FAILS. A control whose class list names a height this
 * scan cannot turn into a number — an arbitrary value in a unit it does not
 * know, `h-[3lh]` — THROWS rather than being skipped. A skipped control is a
 * control this rule has silently stopped governing, which is the state #3486 was
 * filed about, and an absence assertion over a shrinking corpus is the failure
 * mode this whole module is built against.
 */
export function findFlooredControls(
  source: string,
  readModule?: ModuleReader
): FlooredControl[] {
  const found: FlooredControl[] = [];
  const lineOf = (i: number) => source.slice(0, i).split("\n").length;
  // Collected ONCE per file, and only when a control actually needs it: every
  // class list in most files is a quoted string, and building the declaration set
  // walks this file's imports. Lazy, not eager, for that reason alone.
  let declared: ClassDeclarations | null = null;
  const declarations = () =>
    (declared ??= classDeclarations(source, readModule));

  // Every `<label>` span in the file, and every id a `htmlFor` names. Both
  // spellings of "a label takes the tap for this box" are in the tree.
  const labelSpans: { start: number; end: number }[] = [];
  for (const m of source.matchAll(/<label(?=[\s>])/g))
    labelSpans.push(elementSpan(source, m.index, "label"));
  // BOTH SPELLINGS OF AN `htmlFor`, because this app writes the interesting one
  // as an expression. A row rendered from a list gives its box
  // `id={`digest-tune-${c}`}` and its label the identical template — a
  // `htmlFor="…"`-only match reads that pair as UNASSOCIATED and reports six
  // correctly-labelled boxes as findings, which is the check-manufactures-work
  // direction. The comparison is textual on the raw attribute value: two
  // expressions that are the same source ARE the same id at runtime, and two that
  // differ are not something a scan should be guessing about.
  const labelledIds = new Set<string>();
  for (const m of source.matchAll(/htmlFor\s*=\s*("[^"]*"|\{[^}]*\})/g))
    labelledIds.add(m[1].replace(/\s+/g, ""));

  for (const m of source.matchAll(/<([a-z][\w-]*)(?=[\s>])/g)) {
    const tag = m[1];
    const { tag: openTag } = openingTag(source, m.index);
    const byTag = INTERACTIVE_TAGS.has(tag);
    const byHandler =
      /(?<![\w-])onClick\s*=/.test(openTag) || INTERACTIVE_ROLE.test(openTag);
    if (!byTag && !byHandler) continue;
    let resolved: ClassText | null;
    try {
      resolved = resolveClassName(openTag, declarations);
    } catch (error) {
      if (error instanceof UnreadableControlError)
        throw new UnreadableControlError(
          `line ${lineOf(m.index)}: <${tag}>'s ${error.message}`
        );
      throw error;
    }
    if (resolved === null) continue;

    // THE CLASS LIST NOBODY CAN READ FROM HERE. Its text is at the call site (a
    // forwarded `className` prop), in a `.map()` variable, or in an imported data
    // table. No verdict is possible and none is invented: the control is recorded
    // with the expression it was written as, so the census can count it.
    if (!resolved.readable) {
      found.push({
        line: lineOf(m.index),
        tag,
        kind: kindOf(tag, openTag),
        belowSmPx: null,
        mechanism: "unreadable",
        labelled: false,
        className: classNameExpression(openTag)!
          .text.replace(/\s+/g, " ")
          .trim(),
        readable: false,
      });
      continue;
    }
    const className = resolved.text;

    // The unreadable case: a height token in a shape this scan cannot price.
    for (const token of className.matchAll(HEIGHT_TOKEN)) {
      const variants = token[1] ? token[1].slice(0, -1).split(":") : [];
      const governs =
        variants.length === 0 ||
        (variants.length === 1 && variants[0] === "max-sm");
      if (!governs) continue;
      const value = token[3];
      if (/^(auto|full|screen|fit|min|max)$/.test(value)) continue;
      if (scaleToPx(value) === null) {
        throw new UnreadableControlError(
          `line ${lineOf(m.index)}: <${tag}> pins its below-\`sm\` height with ` +
            `\`${token[2]}-${value}\`, which this scan cannot turn into pixels. The tap ` +
            `floor is ${TAP_FLOOR_PX}px effective (#3514) and a control whose height ` +
            "cannot be read is a control the floor has stopped governing. Use a scale " +
            "step, or an arbitrary value in `px` or `rem`."
        );
      }
    }

    const belowSmPx = belowSmHeightPx(className);
    const kind = kindOf(tag, openTag);
    const mechanism: FloorMechanism = inButtonFamily(className)
      ? "btn-family"
      : usesChipSm(className)
        ? "chip-sm"
        : usesTapTarget(className)
          ? "tap-target"
          : belowSmPx !== null && belowSmPx >= TAP_FLOOR_PX
            ? "rendered"
            : "none";
    const id = /(?<![\w-])id\s*=\s*("[^"]*"|\{[^}]*\})/
      .exec(openTag)?.[1]
      ?.replace(/\s+/g, "");
    const labelled =
      labelSpans.some((s) => m.index > s.start && m.index < s.end) ||
      (id !== undefined && labelledIds.has(id));

    found.push({
      line: lineOf(m.index),
      tag,
      kind,
      belowSmPx,
      mechanism,
      labelled,
      className: className.replace(/\s+/g, " ").trim(),
      readable: true,
    });
  }

  return found.sort((a, b) => a.line - b.line);
}

/**
 * Why this control misses the floor, or null when it does not.
 *
 * TWO WAYS TO MISS, and the second is the one #3510's fix could not have found.
 *
 *   NO MECHANISM — a pinned height under the floor, no family membership, no
 *   hit-area overlay. This is `StarButton`'s old `h-9`.
 *
 *   A MECHANISM THAT CANNOT REACH — `.tap-target` on a control rendered smaller
 *   than `TAP_TARGET_MIN_RENDERED_PX`. The overlay adds a fixed 12px, so below
 *   32px it lands short while wearing the class that says it does not. A control
 *   that believes it is already compliant is worse than one that knows it is
 *   not, because nothing will ever look at it again.
 *
 * A control that pins NO height is not judged here — see the module header on
 * what this scan can see. That is a stated bound, not a silent skip.
 */
export function floorMiss(control: FlooredControl): string | null {
  // NOT A CLEARANCE — the absence of a reading. `readable: false` means the class
  // text is not in the file this control lives in, so there is nothing to judge;
  // the census rosters these EXACTLY rather than letting them look like the line
  // below, which is a control that was read and pins no height (#3561).
  if (!control.readable) return null;
  if (control.belowSmPx === null) return null;
  if (control.mechanism === "btn-family" || control.mechanism === "rendered")
    return null;
  if (control.mechanism === "chip-sm") return null;
  if (control.mechanism === "tap-target") {
    if (control.belowSmPx >= TAP_TARGET_MIN_RENDERED_PX) return null;
    return (
      `${control.belowSmPx}px rendered + \`.tap-target\`'s 2x${TAP_TARGET_INSET_PX}px = ` +
      `${control.belowSmPx + 2 * TAP_TARGET_INSET_PX}px effective, under the ` +
      `${TAP_FLOOR_PX}px floor. The hit-area mechanism only reaches it from ` +
      `${TAP_TARGET_MIN_RENDERED_PX}px up`
    );
  }
  if (control.belowSmPx >= TAP_FLOOR_PX) return null;
  return (
    `${control.belowSmPx}px rendered below \`sm\`, under the ${TAP_FLOOR_PX}px floor, ` +
    "with neither registered mechanism"
  );
}

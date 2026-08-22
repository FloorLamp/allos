// THE ADD AFFORDANCE'S GRAMMAR (#3486), in one place.
//
// The app had five placements and two verbs for one act, and nothing anywhere
// said which was right — so every new surface re-decided, and the review that
// filed #3486 counted the results. Two of that issue's three rules have no
// runtime form to hold them the way the height floor has a CSS declaration: a
// label is a string a call site writes, and a placement is where a call site
// puts a tag. What CAN be written once is the RULE — the verb, the housings, and
// how to recognise an add affordance in source — and that is this file.
//
// `lib/__tests__/add-affordance-grammar.test.ts` sweeps the tree with it.
//
// ── HOW THIS REPO SPELLS THE CONSTRUCT ──────────────────────────────────────
//
// Measured before it was encoded (2026-08-22), because a guard written to the
// shape an issue's author had in mind is green against a tree that never used it
// (#3325). Four spellings, and only four:
//
//   1. A `<button>` whose visible text starts with the verb — "Add medication",
//      "New goal". This is the bulk of them.
//   2. A `<button>` that is icon-only below `sm` and carries the label as an
//      `aria-label` — /wellness's `+`, the supplement add toggle. The visible
//      text is "Add" or nothing; the SPOKEN name is the label.
//   3. An `<AddEntryPanel>` mount. It renders its own `btn` internally from
//      `addLabel ?? label`, so the mount's props ARE the affordance and the file
//      that mounts it never spells a button. Twenty-odd of these; a scan that
//      only looked for `<button>` would have missed the single most common
//      spelling, which is exactly the #3325 failure.
//   4. A component whose whole export IS the affordance — `AddPracticeButton`,
//      `AddSupplementModal`, `ProtocolFormModal`. The button is in one file and
//      its PLACEMENT is decided in another, so placement is read at the mount.
//
// ── THE TWO RULES ───────────────────────────────────────────────────────────
//
// VERB. One verb, "Add X". The "New X" minority converts. This is a whole-tree
// rule: it holds for a page primary, a section create, a row repeater and a form
// submit alike, because a person reading the app should meet one word for one
// act.
//
// PLACEMENT. A page-level create is the page header's one primary; a
// section-level create is that section's header-row action; a form submit keeps
// form grammar; nothing floats unhoused. Expressed as HOUSINGS below — the rule
// is not "be in the right place", which no scan can read, but "be inside one of
// these four containers", which one can.
//
// PLACEMENT IS ASKED OF PRIMARIES ONLY, and that boundary is deliberate. A
// `btn`-token control is what this app calls a primary (the same token
// `records-action-grammar.test.ts` counts), and a page-level or section-level
// create is exactly what #3486's acceptance criteria govern. A `btn-ghost`
// "+ Add set" inside a set editor, or an "Add reaction" that adds a row to a
// form, is not making a placement claim and a guard that cried wolf on those
// would be deleted within a week, taking the real rule with it.

/** The one verb an add affordance uses. */
export const CREATE_VERB = "Add";

/**
 * Verbs that mean the same act and are retired. "New" is the minority #3486
 * ruled out; it is not a synonym anyone may reach for again.
 */
export const RETIRED_CREATE_VERBS = ["New"] as const;

/**
 * Where a page-level or section-level create may live. A create outside all
 * four is the "mid-page, left-aligned, unhoused" row of #3486's placement
 * table — the shape the whole rule exists to make impossible.
 */
export type Housing =
  /** `PageHeader`'s `action` — the page's one primary create. */
  | "page-header"
  /** `CardSectionHeader`'s `action`, or a section's own heading row. */
  | "section-header"
  /** A `<form>`; a submit keeps form grammar and makes no placement claim. */
  | "form"
  /** `AddEntryPanel` — the #1497 rare-cadence disclosure, housed by being it. */
  | "disclosure";

export const HOUSINGS: readonly Housing[] = [
  "page-header",
  "section-header",
  "form",
  "disclosure",
];

/** One add affordance found in one file. */
export type CreateAffordance = {
  /** 1-based line of the opening tag. */
  line: number;
  /** How it is spelled — see the four spellings above. */
  kind: "button" | "entry-panel" | "link";
  /** The name a person reads or hears, as written in source. */
  label: string;
  /** The label's first word: `Add`, or a retired verb, and nothing else. */
  verb: string;
  /** Carries the bare `btn` token — this app's primary. */
  primary: boolean;
  /** Resolved housing, or null when the file itself houses it in none. */
  housing: Housing | null;
  /** The component this affordance is declared inside, when it is exported. */
  ownerComponent: string | null;
};

/**
 * The same source with every comment blanked — spaces for the comment's
 * characters, newlines kept — so line numbers still match the file on disk.
 *
 * PROSE IS NOT CODE, and this rule's own subject files argue about it in prose:
 * `AddEntryPanel` explains what `addLabel` is for by quoting "+ Add result", and
 * this very module names both verbs a dozen times. A guard that fired on its own
 * explanation would be deleted. It is also the #3509 failure in miniature — an
 * `e2e-hygiene` census once counted a `.first()` written in an English sentence,
 * and Tailwind's content scanner compiled a class out of a comment that merely
 * mentioned it.
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

/** Every verb this grammar recognises as naming the create act. */
export function createVerbs(): string[] {
  return [CREATE_VERB, ...RETIRED_CREATE_VERBS];
}

const VERB_HEAD = new RegExp(
  `^[+＋]?\\s*(${createVerbs().join("|")})\\b(?!\\s*(?:another\\b))`
);

/**
 * The verb a spoken string leads with, or null when it is not naming the create
 * act at all.
 *
 * `Add another activity` is deliberately NOT a create affordance: it repeats a
 * row inside a form that is already open, which is form grammar and not a
 * placement claim. Its own verb is still `Add`, so the verb rule is satisfied by
 * construction and there is nothing for the sweep to judge.
 */
export function leadingVerb(spoken: string): string | null {
  const m = VERB_HEAD.exec(spoken.trim());
  return m ? m[1] : null;
}

/** True when `label` obeys the one-verb rule. */
export function verbIsCurrent(label: string): boolean {
  return leadingVerb(label) === CREATE_VERB;
}

// ── Source reading ──────────────────────────────────────────────────────────

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

/** The span of a braced attribute value (`action={…}`), or null. */
function bracedAttrSpan(
  tag: string,
  tagStart: number,
  attr: string
): { start: number; end: number } | null {
  const at = tag.search(new RegExp(`(?<![\\w$])${attr}\\s*=\\s*\\{`));
  if (at < 0) return null;
  let i = tag.indexOf("{", at);
  let depth = 0;
  for (let j = i; j < tag.length; j += 1) {
    if (tag[j] === "{") depth += 1;
    else if (tag[j] === "}") {
      depth -= 1;
      if (depth === 0) return { start: tagStart + i, end: tagStart + j };
    }
  }
  return null;
}

/** The span of `<El …>…</El>`, given the index of its `<`. */
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
 * The strings a person reads or hears from this control: its bare text nodes,
 * any string literals among its children, and its own `aria-label`.
 *
 * Nested element TAGS are dropped first, so a child's `className` is not read as
 * something the control says. What survives braces is deliberate: a label is
 * routinely `{open ? "Close" : "Add medication"}`, and reading only the bare
 * text would have missed the Medications page's primary entirely.
 */
export function spokenStrings(
  openTag: string,
  inner: string,
  literals: ReadonlyMap<string, string> = new Map()
): string[] {
  const out: string[] = [];
  const aria = /aria-label\s*=\s*"([^"]*)"/.exec(openTag);
  if (aria) out.push(aria[1]);
  const body = inner.replace(/<[^>]*>/g, " ");
  for (const m of body.matchAll(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g))
    out.push(m[2]);
  // A name held in a same-file identifier — `{label}` against a `label = "Log
  // reading"` prop default, or a module const. Resolving these is what keeps the
  // unreadable-throw meaningful rather than merely loud: without it the throw
  // fires on every honest component that parameterises its own label, and a guard
  // that reds on correct code is deleted with the rule inside it. It is the same
  // property `mobile-density-convention.test.ts` has, for the same reason.
  for (const m of body.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
    const resolved = literals.get(m[1]);
    if (resolved !== undefined) out.push(resolved);
  }
  // The bare text node, whole. It is collapsed rather than split: "Add goal" is
  // one name, and a scan that split on whitespace would read every one of this
  // app's labels as the bare verb "Add" and then cheerfully report the verb rule
  // satisfied — a check passing for a reason unrelated to what it claims.
  const text = body
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text) out.push(text);
  return out;
}

/**
 * String literals bound to a plain identifier in this file: module consts and
 * destructured prop defaults.
 *
 * Deliberately shallow — one file, one hop, literals only. A name assembled at
 * runtime, or imported, is not resolvable here and is not meant to be: that case
 * is what the throw is for.
 */
export function sameFileLiterals(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const patterns = [
    // `const LABEL = "Add result";`
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])((?:\\.|(?!\2)[^\\])*)\2/g,
    // `{ label = "Log reading" }` — a destructured prop default.
    /([A-Za-z_$][\w$]*)\s*=\s*(["'])((?:\\.|(?!\2)[^\\])*)\2\s*[,}]/g,
  ];
  for (const pattern of patterns)
    for (const m of source.matchAll(pattern))
      if (!out.has(m[1])) out.set(m[1], m[3]);
  return out;
}

/** True when the class string names this app's PRIMARY (the bare `btn` token). */
export function isPrimary(openTag: string): boolean {
  return /(?<![\w-])btn(?![\w-])/.test(openTag);
}

/**
 * Which housing contains `index`, if any. Later entries do not override earlier
 * ones: the four are disjoint in practice and the first match is reported, so a
 * form submit inside a section header reads as a form submit.
 */
export function housingAt(source: string, index: number): Housing | null {
  // `action={…}` IS THIS APP'S NAME FOR THE HEADER SLOT, and not only on the two
  // primitives. `PageHeader`, `CardSectionHeader`, `SupplementSchedule` and
  // `MobileDetailPage` all take one and all render it right-aligned beside their
  // own title — so the prop, not the component, is the convention. Reading only
  // the two named primitives reported the supplements hub's create as unhoused
  // when it sits in exactly the slot the rule asks for; reading the prop is what
  // the repo actually does.
  for (const m of source.matchAll(/<([A-Z][\w.]*)(?=[\s>])/g)) {
    const { tag } = openingTag(source, m.index);
    const span = bracedAttrSpan(tag, m.index, "action");
    if (span && index > span.start && index < span.end)
      return m[1] === "PageHeader" ? "page-header" : "section-header";
  }
  for (const m of source.matchAll(/<form(?=[\s>])/g)) {
    const span = elementSpan(source, m.index, "form");
    if (index > span.start && index < span.end) return "form";
  }
  // A FIELD ROW — a form in everything but the tag, and the second spelling of
  // form grammar in this repo. Measured, not assumed: most of this app's
  // create-and-post pairs (`PortalsSurface`'s "Add login" and "Add portal",
  // `EquipmentQuickAdd`, the family invite) build a `FormData` by hand and call a
  // server action, so there is no `<form>` element for a scan to find. What there
  // IS, every time, is the control sitting in one wrapper beside the fields it
  // submits. A control next to its own inputs is making no placement claim, and
  // a guard that called those unhoused would be crying wolf on the most common
  // shape in the tree.
  //
  // The two INNERMOST wrappers decide, and no further. Two because a submit is
  // routinely given its own button row inside the panel that holds the fields
  // (`PortalsSurface`'s "Add portal" sits in a `flex gap-2` beside a Cancel, one
  // level under the panel carrying the name input). Not more than two, because
  // the enclosing element of anything eventually contains a search box, and a
  // rule that walks far enough up launders every create on the page into form
  // grammar and stops being able to fail.
  const wrappers: { start: number; end: number }[] = [];
  for (const tag of ["div", "li", "fieldset"] as const)
    for (const m of source.matchAll(new RegExp(`<${tag}(?=[\\s>])`, "g"))) {
      const span = elementSpan(source, m.index, tag);
      if (index > span.start && index < span.end) wrappers.push(span);
    }
  wrappers.sort((a, b) => a.end - a.start - (b.end - b.start));
  const FIELD =
    /<(input|select|textarea|Combobox|DateField|WhenControl)(?=[\s/>])/;
  for (const wrapper of wrappers.slice(0, 2))
    if (FIELD.test(source.slice(wrapper.start, wrapper.end))) return "form";
  // A SECTION'S OWN HEADING ROW, which is how this repo actually spells a
  // section-level action — measured, not assumed: `GoalsManager`,
  // `RoutinesManager`, `EquipmentManager` and `CardSectionHeader` itself all
  // write the identical `flex … items-center justify-between` row with the
  // heading in the left cell and the actions in the right. The heading is what
  // makes it a HEADER row rather than any old spaced-apart pair, so it is
  // required rather than inferred — and the heading is accepted either INSIDE the
  // row (Goals, Routines, Equipment) or immediately ABOVE it (the supplements
  // hub's "Manage" section-label over an action row). Both are the same anatomy;
  // only the nesting differs, and refusing the second reported a create as
  // unhoused for a reason a reader of the page could not have seen.
  const HEADING = /<h[1-6](?=[\s>])|section-label/;
  for (const m of source.matchAll(/<div(?=[\s>])/g)) {
    const { tag } = openingTag(source, m.index);
    if (!/justify-between/.test(tag)) continue;
    const span = elementSpan(source, m.index, "div");
    if (index <= span.start || index >= span.end) continue;
    if (HEADING.test(source.slice(span.start, span.end)))
      return "section-header";
    // The heading immediately above the row, within the section that holds both.
    // Bounded to 400 characters so "somewhere earlier on the page" cannot pass.
    if (HEADING.test(source.slice(Math.max(0, span.start - 400), span.start)))
      return "section-header";
  }
  return null;
}

/** Raised when the scan meets a control it cannot read. Never swallowed. */
export class UnreadableAffordanceError extends Error {}

// A `<Link>` is deliberately NOT here. A link that says "Add your age" is a DOOR
// to the surface where the add happens, and §4 of the registry governs doors
// separately ("doors live on the surfaces they serve; the label is the
// destination's own name"). Judging a door's placement against the create
// grammar would report `BioAgeInputsCard`'s link to /settings/health as an
// unhoused page primary, which is a sentence about the wrong rule.
const CONTROL_TAGS = ["button", "SubmitButton"] as const;

/**
 * Every add affordance in one file's source.
 *
 * `source` must already be `withoutComments`-blanked; passing raw source is the
 * #3509 mistake and this function cannot detect it for you.
 *
 * WHICH DIRECTION THIS FAILS. A control that LOOKS like a create — it carries
 * the `IconPlus` glyph this app spells "add" with — but whose name the scan
 * cannot read THROWS rather than being skipped. A skipped control is a control
 * this rule has silently stopped governing, which is the state #3486 was filed
 * about; a red saying "this scan cannot read that call site" is the correct
 * outcome, and the call site's answer is to give it a readable name, which it
 * owed a screen reader anyway.
 */
export function findCreateAffordances(source: string): CreateAffordance[] {
  const found: CreateAffordance[] = [];
  const lineOf = (i: number) => source.slice(0, i).split("\n").length;
  const literals = sameFileLiterals(source);

  for (const tagName of CONTROL_TAGS) {
    for (const m of source.matchAll(new RegExp(`<${tagName}(?=[\\s>])`, "g"))) {
      const { tag, end } = openingTag(source, m.index);
      const span = elementSpan(source, m.index, tagName);
      const inner = source.slice(
        end,
        Math.max(end, span.end - tagName.length - 3)
      );
      const spoken = spokenStrings(tag, inner, literals);
      const named = spoken.find((s) => leadingVerb(s) !== null);
      if (named === undefined) {
        // The unreadable case: it wears the add glyph and says nothing this scan
        // can resolve to a name.
        const wearsPlusGlyph = /<IconPlus(?=[\s>])/.test(inner);
        const hasAnyName =
          spoken.some((s) => /[A-Za-z]/.test(s)) ||
          /aria-label\s*=\s*\{/.test(tag);
        if (wearsPlusGlyph && !hasAnyName) {
          throw new UnreadableAffordanceError(
            `line ${lineOf(m.index)}: a <${tagName}> carries IconPlus and no name this ` +
              "scan can read — no text, no string literal, no `aria-label`. It is either " +
              "an add affordance the add-affordance grammar has stopped governing, or a " +
              "control with no accessible name at all. Give it one."
          );
        }
        continue;
      }
      found.push({
        line: lineOf(m.index),
        kind: tagName === "Link" ? "link" : "button",
        label: named.trim(),
        verb: leadingVerb(named)!,
        primary: isPrimary(tag) || tagName === "SubmitButton",
        housing:
          tagName === "SubmitButton"
            ? (housingAt(source, m.index) ?? "form")
            : housingAt(source, m.index),
        ownerComponent: null,
      });
    }
  }

  // Spelling 3: an `<AddEntryPanel>` mount IS the affordance. It renders its own
  // `btn` from `addLabel ?? label`, so the collapsed button's name is whichever
  // of those two props the mount supplies — and the mount is the only place a
  // reader of THIS file can see it.
  for (const m of source.matchAll(/<AddEntryPanel(?=[\s>])/g)) {
    const { tag } = openingTag(source, m.index);
    const read = (attr: string) =>
      new RegExp(`(?<![\\w$])${attr}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];
    const label = read("addLabel") ?? read("label");
    if (label === undefined) {
      throw new UnreadableAffordanceError(
        `line ${lineOf(m.index)}: <AddEntryPanel> mounts with no readable \`label\`. ` +
          "The collapsed panel renders a button named `addLabel ?? label`, so an " +
          "unreadable one is an add affordance nobody is checking the verb of."
      );
    }
    if (leadingVerb(label) === null) continue;
    found.push({
      line: lineOf(m.index),
      kind: "entry-panel",
      label,
      verb: leadingVerb(label)!,
      // The panel IS its own housing: #1497's rare-cadence disclosure is a
      // resolved placement, which is how #3482 closed the cycles page's
      // "mid-page, unhoused" row without moving it into a header.
      primary: true,
      housing: "disclosure",
      ownerComponent: null,
    });
  }

  return found.sort((a, b) => a.line - b.line);
}

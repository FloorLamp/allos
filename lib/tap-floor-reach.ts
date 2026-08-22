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
//   effective by `.tap-target`'s `inset: -6px` overlay (#644).
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
  /** The class list as written, for the failure message. */
  className: string;
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
 * The `className` value as written — the quoted string, or everything inside the
 * braces of a `className={…}` expression (a template literal or a ternary, both
 * of which this app uses constantly and both of which carry the tokens we need).
 */
export function classNameOf(tag: string): string | null {
  const m = /(?<![\w-])className\s*=\s*/.exec(tag);
  if (!m) return null;
  const at = m.index + m[0].length;
  const quote = tag[at];
  if (quote === '"' || quote === "'") {
    const end = tag.indexOf(quote, at + 1);
    return end < 0 ? tag.slice(at + 1) : tag.slice(at + 1, end);
  }
  if (quote === "{") {
    let depth = 0;
    for (let i = at; i < tag.length; i += 1) {
      if (tag[i] === "{") depth += 1;
      else if (tag[i] === "}") {
        depth -= 1;
        if (depth === 0) return tag.slice(at + 1, i);
      }
    }
  }
  return null;
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
export function findFlooredControls(source: string): FlooredControl[] {
  const found: FlooredControl[] = [];
  const lineOf = (i: number) => source.slice(0, i).split("\n").length;

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
    const className = classNameOf(openTag);
    if (className === null) continue;

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
  if (control.belowSmPx === null) return null;
  if (control.mechanism === "btn-family" || control.mechanism === "rendered")
    return null;
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

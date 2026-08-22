// The card-mode meta VALUE-SHAPE census (#3517).
//
// WHAT IT ANSWERS. Below `sm` a `.table-cards` meta cell is an `inline-flex`
// container that does not wrap (app/globals.css, the `table-cards` utility), so
// every top-level node of the cell — the `card-cell-label` span and each node of
// the value — is a flex ITEM on ONE line. `components/ResponsiveTable.tsx` states
// the consequence where `label` is documented: a value with internal structure is
// passed as ONE node and stacks inside itself. That rule is real, it is written
// down, and until now nothing but review enforced it.
//
// It was not enforced because it did not exist yet: #3499 turned the cell into a
// flex line, and the sleep history was already passing its naps as several loose
// sibling `<div>`s. Valid under the block flow that stacked them; three items side
// by side under a flex line, running the row 29px past its own right edge. Page
// level clipping checks read ZERO throughout (the `<tr>` scrolls, the document
// does not), and no spec looked. It was found by rendering the page (#3516).
//
// WHY A SOURCE CENSUS AND NOT A ROUTE LIST. #3517 asked for a bounded, justified
// target list rather than a hand-picked set of routes, on the grounds that the
// at-risk surfaces are enumerable by reading `slot="meta"` children. They are —
// and the enumeration is what makes this cheap: a route list only guards the
// routes somebody thought of, while this fails on the next cell of the wrong shape
// whether or not anyone remembers to render it.
//
// THE SHAPE IS NOT THE ONE THE ISSUE NAMED, AND THE DIFFERENCE MATTERS.
// #3517 narrows the at-risk set to cells "whose value is a block element",
// because that is what the PRE-#3499 defect needed: in an inline flow a label
// could only be split from its value by a value that began a line of its own.
// #3499 removed that failure mode by construction — the pair is one flex line now
// — and introduced this one, which needs something different:
//
//   a value of SEVERAL top-level nodes, at least one of them block-displayed.
//
// Both halves are load-bearing, and the tree contains the cases that prove it:
//   * ONE node that is block, or has block descendants, is FINE. It is a single
//     flex item and it stacks inside itself — `ImmunizationHistory`'s
//     "Lot / route / site" wraps its reaction line in one span, `EncounterList`'s
//     "Visit" wraps its whole stack in one `<div>`. Flagging these would be noise,
//     and a guard that cries wolf is deleted within a week, taking the real guard
//     with it.
//   * SEVERAL nodes that are all inline is FINE too. `MetricReadingsTable`'s
//     "Source" is a value plus a short inline `<span>`; the sleep history's "Mood"
//     is a face glyph plus its text. Two short inline items on a flex line are a
//     phrase, which is what the line is for.
//   * SEVERAL nodes with a BLOCK among them is the defect. A block sibling is a
//     node whose author meant it to start its own line — and a flex line is
//     exactly where it will not.
//
// So a census written to the issue's wording would have gone green over both of
// the surfaces this one found, and red on four that are correct.
//
// SCOPE, STATED SO IT IS NOT MISREAD. This reads SOURCE TEXT. It cannot resolve a
// component's rendered display (`NotesText` renders a `span` by default and a
// `div` on request), and it does not try: `blockTokens` matches the block
// spellings this repo actually writes, which is what `hasBlockSibling` documents.
// It is the enumeration that bounds the e2e work, never a substitute for it —
// "the row did not overflow" stays a geometry fact, measured at 390px by
// `scanCardMetaPairs` (e2e/helpers.ts). This census tells you WHERE to point that.

/** One card-mode meta cell the census resolved, with the verdict on its value. */
export interface CardMetaValueCell {
  /** Repo-relative source file. */
  file: string;
  /** The cell's card label — its `label` prop, or its column `header`. */
  label: string;
  /** 1-based line of the cell's opening tag / its column's `header`. */
  line: number;
  /** Top-level nodes in the value, excluding the `card-cell-label` span. */
  nodes: number;
  /** At least one top-level value node is block-displayed. */
  block: boolean;
}

// How this repo spells "this node starts its own line". Both spellings are in the
// tree and both were found by grepping for the construct rather than assuming it:
// intrinsic block tags, and Tailwind display utilities on an otherwise-inline tag
// (`<span className="block">` is how the sleep history's own fix is written, so a
// scan that only knew about `<div>` would be blind to the shape of the fix).
const BLOCK_TAGS = [
  "div",
  "p",
  "ul",
  "ol",
  "li",
  "dl",
  "table",
  "section",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
];
const BLOCK_CLASS_TOKENS = ["block", "flex", "grid", "table"];

/**
 * Split a JSX children string into its TOP-LEVEL nodes.
 *
 * Top-level means at element depth 0 and brace depth 0 — so a `{cond ? <a/> :
 * null}` expression container is ONE node however much markup is inside it, which
 * is exactly right: React renders it as one child, and a flex line lays out one
 * item for it. Whitespace-only text between nodes is not a node (JSX drops it),
 * which is also why `Td` leaves no gap between a label and its value.
 */
export function topLevelNodes(children: string): string[] {
  const nodes: string[] = [];
  let text = "";
  let i = 0;
  const pushText = () => {
    if (text.trim()) nodes.push(text);
    text = "";
  };
  while (i < children.length) {
    const ch = children[i];
    if (ch === "{") {
      pushText();
      let depth = 0;
      const start = i;
      let quote: string | null = null;
      for (; i < children.length; i++) {
        const c = children[i];
        if (quote) {
          if (c === quote && children[i - 1] !== "\\") quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      const container = children.slice(start, i);
      // A JSX COMMENT IS NOT A NODE, and neither is an empty container. `{/* … */}`
      // renders nothing, but it is spelled with the same braces as a value — and
      // the sleep history's naps cell carries a five-line one explaining the very
      // rule this census enforces, so counting it made the FIXED cell read as two
      // nodes and the guard indict its own fix.
      if (!/^\{\s*(?:\/\*[^]*\*\/\s*)?\}$/.test(container))
        nodes.push(container);
      continue;
    }
    if (ch === "<" && children[i + 1] !== "/") {
      pushText();
      const start = i;
      const tag = /^<\s*([A-Za-z][\w.]*)/.exec(children.slice(i));
      const name = tag?.[1] ?? "";
      let depth = 0;
      let quote: string | null = null;
      let brace = 0;
      let selfClosing = false;
      // Walk the opening tag to its `>`, then, if it is not self-closing, to the
      // matching close tag — counting nested same-name tags so a `<div>` inside a
      // `<div>` does not end the outer one early.
      for (; i < children.length; i++) {
        const c = children[i];
        if (quote) {
          if (c === quote && children[i - 1] !== "\\") quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{") brace++;
        else if (c === "}") brace--;
        else if (c === ">" && brace === 0) {
          selfClosing = children[i - 1] === "/";
          i++;
          break;
        }
      }
      if (selfClosing || name === "") {
        nodes.push(children.slice(start, i));
        continue;
      }
      depth = 1;
      const open = new RegExp(`<\\s*${name}(?=[\\s/>])`, "g");
      const close = new RegExp(`<\\s*/\\s*${name}\\s*>`, "g");
      while (depth > 0 && i < children.length) {
        open.lastIndex = i;
        close.lastIndex = i;
        const o = open.exec(children);
        const c = close.exec(children);
        if (!c) break;
        if (o && o.index < c.index) {
          depth++;
          i = o.index + o[0].length;
        } else {
          depth--;
          i = c.index + c[0].length;
        }
      }
      nodes.push(children.slice(start, i));
      continue;
    }
    // A JSX fragment's own `<>`/`</>` delimiters are not nodes; the caller strips
    // them before calling, and a stray `</` here is skipped.
    if (ch === "<") {
      const end = children.indexOf(">", i);
      i = end === -1 ? children.length : end + 1;
      continue;
    }
    text += ch;
    i++;
  }
  pushText();
  return nodes;
}

/** Strip one enclosing JSX fragment, so `<>a<span/></>` reads as two nodes. */
export function unwrapFragment(children: string): string {
  const trimmed = children.trim();
  if (!trimmed.startsWith("<>") || !trimmed.endsWith("</>")) return children;
  return trimmed.slice(2, -3);
}

/**
 * Does any TOP-LEVEL node of this value start its own line?
 *
 * Only the node's OWN box is read — a block DESCENDANT is irrelevant, because it
 * lays out inside its parent flex item rather than beside it. That distinction is
 * the whole reason `ImmunizationHistory`'s Lot / route / site is not an offender
 * and `VaccineDoseHistory`'s Dose was.
 *
 * AN EXPRESSION CONTAINER IS NOT A BOX, and missing that made the first cut of
 * this census report a clean tree over two real offenders — the reassuring
 * direction, and the one that ends with nobody looking again. `{cond ? <span
 * className="block"/> : null}` renders the span ITSELF as the child: the braces are
 * source syntax, not an element, so the flex item is the span. Nearly every
 * conditional value in this tree is written that way, so a scan that reads only
 * literal opening tags sees inline text where the page lays out a block. The fix
 * is to look through a `{…}` node at the elements it can yield — which is also
 * what makes `{xs.map(x => <div/>)}` (the naps, verbatim) resolve as block.
 */
export function hasBlockSibling(nodes: readonly string[]): boolean {
  return nodes.some((node) => {
    const trimmed = node.trim();
    if (trimmed.startsWith("{")) {
      const inner = trimmed.slice(1, trimmed.endsWith("}") ? -1 : undefined);
      // One level of look-through is enough and is deliberate: the elements a
      // container yields are its branch results, which sit at ITS depth 0. Going
      // deeper would start reading descendants, which is the thing this must not do.
      return hasBlockSibling(
        topLevelNodes(inner).filter((n) => n.trim().startsWith("<"))
      );
    }
    const tag = /^<\s*([A-Za-z][\w.]*)([^]*?)(?:\/?>)/.exec(trimmed);
    if (!tag) return false;
    const name = tag[1].toLowerCase();
    if (BLOCK_TAGS.includes(name)) return true;
    const cls = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(tag[2]);
    const value = cls?.[1] ?? cls?.[2] ?? "";
    return BLOCK_CLASS_TOKENS.some((token) =>
      new RegExp(`(?:^|[\\s:])${token}(?![\\w-])`).test(value)
    );
  });
}

/**
 * The verdict for one card-mode meta cell's value.
 *
 * TRUE means: several flex items on the cell's one line, at least one of which was
 * authored to occupy a line of its own. That is the sleep-history shape, and it is
 * the only shape that can push a card row past its own right edge.
 */
export function valueOverflowsItsLine(children: string): {
  nodes: number;
  block: boolean;
  offends: boolean;
} {
  const nodes = topLevelNodes(unwrapFragment(children));
  const block = hasBlockSibling(nodes);
  return { nodes: nodes.length, block, offends: nodes.length > 1 && block };
}

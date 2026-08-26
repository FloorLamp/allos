import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Icon-only controls still need an accessible name after #3729 removed native
// hover titles. This source scan detects glyph-only buttons and requires an
// explicit aria-label; the raw-title boundary separately rejects title attributes.
//
// ── what "icon-only" means here ─────────────────────────────────────────────
//
// The scan below is a small brace-aware JSX reader, not a regex: it parses the
// <button> opening tag (attribute values may span lines and contain nested
// braces, template literals and JSX), then walks the children and asks whether
// anything VISIBLE besides a glyph renders. Text in a nested element counts;
// text in an `sr-only` element does not; an expression counts only if one of
// its value positions (the branches of ?:, the right of &&) is something other
// than a JSX element. An icon+text button is not the convention's business.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

/** Components that render a glyph and no text of their own. */
function isIconElement(name: string): boolean {
  return (
    /^Icon[A-Z]/.test(name) || // @tabler/icons-react
    name === "svg" ||
    name === "ActivityIcon" ||
    name === "FoodGroupIcon" ||
    name === "Avatar" ||
    name === "Spinner"
  );
}

// ── a very small JSX reader ─────────────────────────────────────────────────

/** `s[i]` opens a string/template literal. Returns the index just after it. */
function skipString(s: string, i: number): number {
  const q = s[i];
  i++;
  while (i < s.length) {
    if (s[i] === "\\") i += 2;
    else if (s[i] === q) return i + 1;
    else if (q === "`" && s[i] === "$" && s[i + 1] === "{") {
      i = skipBraces(s, i + 1);
    } else i++;
  }
  return i;
}

/** `s[i] === "{"`. Returns the index just after the matching `}`. */
function skipBraces(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(s, i);
    else if (c === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl;
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i);
      i = end === -1 ? s.length : end + 2;
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
  }
  return i;
}

interface Tag {
  name: string;
  closing: boolean;
  attrs: string;
  end: number;
  selfClosing: boolean;
}

/** `s[i] === "<"`. Parses the tag; `end` is the index just after its `>`. */
function parseTag(s: string, i: number): Tag | null {
  let j = i + 1;
  const closing = s[j] === "/";
  if (closing) j++;
  const nameMatch = /^[A-Za-z_$][\w.$-]*/.exec(s.slice(j));
  if (!nameMatch) return null;
  const name = nameMatch[0];
  j += name.length;
  const attrStart = j;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'" || c === "`") j = skipString(s, j);
    else if (c === "{") j = skipBraces(s, j);
    else if (c === "/" && s[j + 1] === ">")
      return {
        name,
        closing,
        attrs: s.slice(attrStart, j),
        end: j + 2,
        selfClosing: true,
      };
    else if (c === ">")
      return {
        name,
        closing,
        attrs: s.slice(attrStart, j),
        end: j + 1,
        selfClosing: false,
      };
    else j++;
  }
  return null;
}

/** From just after an opening `<name>`, find its matching close tag. */
function findClose(
  s: string,
  i: number,
  name: string
): { childrenEnd: number; end: number } | null {
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(s, i);
      continue;
    }
    if (c === "{") {
      i = skipBraces(s, i);
      continue;
    }
    if (c === "<") {
      const t = parseTag(s, i);
      if (t && t.name === name) {
        if (t.closing) {
          depth--;
          if (depth === 0) return { childrenEnd: i, end: t.end };
        } else if (!t.selfClosing) depth++;
        i = t.end;
        continue;
      }
      if (t) {
        i = t.end;
        continue;
      }
    }
    i++;
  }
  return null;
}

type Node =
  | { kind: "text"; src: string }
  | { kind: "expr"; src: string }
  | { kind: "el"; name: string; attrs: string; kids: Node[] };

function childNodes(s: string): Node[] {
  const out: Node[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    if (text.trim()) out.push({ kind: "text", src: text });
    text = "";
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "{") {
      const end = skipBraces(s, i);
      flush();
      out.push({ kind: "expr", src: s.slice(i + 1, end - 1) });
      i = end;
    } else if (c === "<") {
      const t = parseTag(s, i);
      if (!t) {
        text += c;
        i++;
        continue;
      }
      flush();
      if (t.selfClosing) {
        out.push({ kind: "el", name: t.name, attrs: t.attrs, kids: [] });
        i = t.end;
      } else {
        const close = findClose(s, t.end, t.name);
        if (!close) {
          i = t.end;
          continue;
        }
        out.push({
          kind: "el",
          name: t.name,
          attrs: t.attrs,
          kids: childNodes(s.slice(t.end, close.childrenEnd)),
        });
        i = close.end;
      }
    } else {
      text += c;
      i++;
    }
  }
  flush();
  return out;
}

/**
 * A JSX-stripped expression: split the top-level `?:` / `&&` / `||` and inspect
 * only the VALUE positions, so `{open ? <IconUp/> : <IconDown/>}` renders no
 * text while `{open ? "Hide" : "Show"}` and `{label}` do.
 */
function valueHasText(src: string): boolean {
  const s = src.trim();
  if (!s) return false;
  const split = (str: string, ops: string[]): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let last = 0;
    let i = 0;
    while (i < str.length) {
      const c = str[i];
      if (c === '"' || c === "'" || c === "`") {
        i = skipString(str, i);
        continue;
      }
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (depth === 0) {
        for (const op of ops) {
          if (str.startsWith(op, i)) {
            parts.push(str.slice(last, i));
            last = i + op.length;
            i += op.length - 1;
            break;
          }
        }
      }
      i++;
    }
    parts.push(str.slice(last));
    return parts;
  };
  const ternary = split(s, ["?"]);
  if (ternary.length > 1) {
    const rest = ternary.slice(1).join("?");
    return split(rest, [":"]).some(valueHasText);
  }
  const and = split(s, ["&&"]);
  if (and.length > 1) return valueHasText(and[and.length - 1]);
  const or = split(s, ["||"]);
  if (or.length > 1) return or.some(valueHasText);
  const leaf = s.replace(/^\(+|\)+$/g, "").trim();
  if (!leaf || leaf === JSX_PLACEHOLDER) return false;
  return !/^(null|undefined|false|true|0|""|''|``)$/.test(leaf);
}

const JSX_PLACEHOLDER = "§jsx§";
const TEXT_PLACEHOLDER = "§text§";

/** Replace the JSX elements inside an expression, then judge what is left. */
function inspectExpression(src: string): { text: boolean; icon: boolean } {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  let out = "";
  let i = 0;
  let icon = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(s, i);
      out += s.slice(i, end);
      i = end;
      continue;
    }
    const t = c === "<" ? parseTag(s, i) : null;
    if (!t) {
      out += c;
      i++;
      continue;
    }
    if (t.selfClosing) {
      if (isIconElement(t.name)) icon = true;
      out += ` ${JSX_PLACEHOLDER} `;
      i = t.end;
      continue;
    }
    const close = findClose(s, t.end, t.name);
    if (!close) {
      out += c;
      i++;
      continue;
    }
    const kids = childNodes(s.slice(t.end, close.childrenEnd));
    if (isIconElement(t.name) || kids.some(rendersIcon)) icon = true;
    out += ` ${rendersText(kids) ? TEXT_PLACEHOLDER : JSX_PLACEHOLDER} `;
    i = close.end;
  }
  return { text: valueHasText(out), icon };
}

function rendersIcon(n: Node): boolean {
  if (n.kind === "el") return isIconElement(n.name) || n.kids.some(rendersIcon);
  if (n.kind === "expr") return inspectExpression(n.src).icon;
  return false;
}

function rendersText(nodes: Node[]): boolean {
  for (const n of nodes) {
    if (n.kind === "text" && n.src.trim()) return true;
    if (n.kind === "expr" && inspectExpression(n.src).text) return true;
    if (n.kind === "el") {
      if (/\bsr-only\b/.test(n.attrs)) continue; // not visible
      if (isIconElement(n.name)) continue;
      if (rendersText(n.kids)) return true;
      // An unknown childless component could render anything — assume text, so
      // the guard errs toward NOT demanding a tooltip it cannot justify.
      if (n.kids.length === 0 && /^[A-Z]/.test(n.name)) return true;
    }
  }
  return false;
}

const hasAttribute = (attrs: string, name: string): boolean =>
  new RegExp(`(?:^|\\s)${name}\\s*=`).test(attrs);

export interface IconButton {
  rel: string;
  line: number;
  hasAriaLabel: boolean;
}

/** Every icon-only `<button>` in one file's source. */
function iconOnlyButtons(rel: string, text: string): IconButton[] {
  const found: IconButton[] = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<button", i);
    if (lt === -1) break;
    const tag = parseTag(text, lt);
    if (!tag || tag.name !== "button") {
      i = lt + "<button".length;
      continue;
    }
    let kids: Node[] = [];
    let after = tag.end;
    if (!tag.selfClosing) {
      const close = findClose(text, tag.end, "button");
      if (close) {
        kids = childNodes(text.slice(tag.end, close.childrenEnd));
        after = close.end;
      }
    }
    if (kids.some(rendersIcon) && !rendersText(kids)) {
      found.push({
        rel,
        line: text.slice(0, lt).split("\n").length,
        hasAriaLabel: hasAttribute(tag.attrs, "aria-label"),
      });
    }
    i = after;
  }
  return found;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function scanRepo(): IconButton[] {
  const found: IconButton[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      found.push(...iconOnlyButtons(rel, fs.readFileSync(full, "utf8")));
    }
  }
  return found;
}

const HOW = "Every icon-only <button> carries an aria-label naming its action.";

describe("icon-only button naming convention (issue #1535/#3729)", () => {
  const buttons = scanRepo();

  it("finds the icon-only buttons at all (the scan is not silently empty)", () => {
    expect(buttons.length).toBeGreaterThan(50);
  });

  it("every icon-only button carries an aria-label", () => {
    const offenders = buttons
      .filter((b) => !b.hasAriaLabel)
      .map((b) => `${b.rel}:${b.line}`);
    expect(
      offenders,
      `${HOW}\n\nMissing aria-label:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});

describe("the icon-only classifier itself", () => {
  const scan = (src: string) => iconOnlyButtons("fixture.tsx", src);

  it("finds a named icon-only button", () => {
    const found = scan(
      `<button type="button" aria-label="Delete"><IconTrash className="h-4 w-4" /></button>`
    );
    expect(found).toHaveLength(1);
    expect(found[0].hasAriaLabel).toBe(true);
  });

  it("still classifies obsolete title metadata", () => {
    const found = scan(
      `<button aria-label="Delete dose" title="Delete dose"><IconTrash /></button>`
    );
    expect(found).toHaveLength(1);
    expect(found[0].hasAriaLabel).toBe(true);
  });

  it("ignores an icon+text button", () => {
    expect(
      scan(`<button aria-label="Delete"><IconTrash />Delete</button>`)
    ).toEqual([]);
  });

  it("ignores a text-only button", () => {
    expect(scan(`<button onClick={save}>Save</button>`)).toEqual([]);
  });

  it("ignores a button whose text comes from an expression", () => {
    expect(scan(`<button><IconPlus />{label}</button>`)).toEqual([]);
    expect(
      scan(`<button><IconPlus />{open ? "Hide" : "Show"}</button>`)
    ).toEqual([]);
    expect(scan(`<button><IconPlus />{count > 0 && count}</button>`)).toEqual(
      []
    );
  });

  it("still flags a button whose only child is a conditional pair of icons", () => {
    const found = scan(
      `<button aria-label="Toggle">{open ? <IconChevronUp /> : <IconChevronDown />}</button>`
    );
    expect(found).toHaveLength(1);
  });

  it("treats sr-only text as invisible — the glyph is still all a sighted user sees", () => {
    const found = scan(
      `<button aria-label="Delete"><IconTrash /><span className="sr-only">Delete</span></button>`
    );
    expect(found).toHaveLength(1);
  });

  it("reads a multi-line tag whose attribute values contain braces and templates", () => {
    const found = scan(`<button
        type="button"
        aria-label={\`Remove \${day.label || \`day \${di + 1}\`}\`}
        title="Remove day"
        onClick={() => setDays((ds) => ds.filter((_, i) => i !== di))}
        className="shrink-0"
      >
        <IconX className="h-4 w-4" />
      </button>`);
    expect(found).toHaveLength(1);
    expect(found[0].hasAriaLabel).toBe(true);
  });

  it("finds each of several sibling buttons, nested markup and all", () => {
    const found = scan(`<div>
        <button aria-label="Edit" title="Edit record"><IconPencil /></button>
        <button aria-label="Delete"><IconTrash /></button>
        <button title="Save"><span><strong>Save</strong></span></button>
      </div>`);
    expect(found.map((b) => b.hasAriaLabel)).toEqual([true, true]);
  });
});

describe("destructive icon-only buttons are recoverable", () => {
  // These are the shared row/table surfaces where a
  // single tap deletes a record — each routes through `useConfirm()`, so the
  // tap is recoverable whether or not the tooltip was ever readable.
  const CONFIRMS = [
    "components/RecordTable.tsx",
    "components/DeleteDocumentButton.tsx",
    "components/EquipmentManager.tsx",
    "app/(app)/encounters/AppointmentList.tsx",
    "app/(app)/immunizations/VaccineDoseHistory.tsx",
    "components/practices/PracticeSessionHistory.tsx",
    "app/(app)/trends/BodyMetricRowMenu.tsx",
  ];

  it.each(CONFIRMS)("%s confirms before it deletes", (rel) => {
    const text = fs.readFileSync(path.join(REPO, rel), "utf8");
    expect(text).toMatch(/useConfirm\(\)|confirmDelete/);
  });
});

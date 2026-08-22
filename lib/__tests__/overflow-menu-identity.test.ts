import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { overflowMenuLabel } from "../overflow-menu-label";

// EVERY ACTION SHEET NAMES THE ROW IT ACTS ON (#3501) — the source-scan half of
// the rule, in the tradition of mobile-density-convention.test.ts.
//
// `components/OverflowMenu.tsx` carried this rule as a COMMENT for as long as it
// existed ("the trigger's accessible name names the row these actions belong
// to"). Nine callers followed it and nineteen did not, and nothing could tell
// them apart, because a `label: string` prop can only ever be obeyed by
// convention. #3501 moved the sentence into lib/overflow-menu-label.ts and made
// the component ask for its PARTS: `itemName` is required, so a menu cannot be
// mounted without naming the thing it acts on.
//
// That much the type checker enforces on its own, and this file does not repeat
// it. What a type cannot say is the half that actually went wrong: `itemName`
// must be the ROW, not another generic string literal typed at the call site.
// `itemName="More actions"` type-checks perfectly and reintroduces the whole
// defect. So the boundary this file guards is the one the compiler leaves open.
//
// WHICH DIRECTION THIS FAILS. A census shaped "no mount passes a literal" is
// green over an empty census — it goes quiet the moment the scan stops finding
// mounts, which is what a rename of the component, a move of the directories, or
// a change in JSX formatting all look like. So the shape here is: prove the
// census found the mounts FIRST, then judge them; and when a mount's `itemName`
// cannot be read, THROW rather than skip. A red saying "this scan cannot read
// that call site" is the correct outcome; a green is not.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ROOTS = ["app", "components"];
const MENU = "components/OverflowMenu.tsx";
const COMPOSER = "lib/overflow-menu-label.ts";

// THE FLOOR THE CENSUS MUST CLEAR. Not the exact count — mounts are added all the
// time and this file is not a changelog — but a number well above zero, so a scan
// that has stopped seeing OverflowMenu fails LOUDLY instead of passing over an
// empty list. It only ever moves up, and only when someone has looked.
const MOUNT_FLOOR = 30;

// The ONE composition that is allowed to name a literal, and why.
//
// A menu is not always a ROW menu. `ImmunizationRecordActions` mounts one for the
// immunization RECORD as a whole — print, share, import act on the document, not
// on a line in it — so the record is the thing named and there is no row
// expression to read it from. Registered here by file, with its literal, so that
// "this is a surface menu" is a decision someone made in this file rather than a
// string that slipped past a scan.
const SURFACE_MENUS = new Map<string, string>([
  ["app/(app)/immunizations/ImmunizationRecordActions.tsx", "Immunizations"],
]);

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// The same source with every COMMENT blanked out — spaces for the comment's
// characters, newlines kept — so offsets and line numbers still line up with the
// file on disk.
//
// Prose is not code, and this rule's own subject files explain it in prose: both
// components/OverflowMenu.tsx and the composer quote the very phrasing this scan
// forbids, in order to say where it belongs. A guard that fired on its own
// explanation would be deleted, and one that fired on a `//` mention of
// `<OverflowMenu>` would be counting comments as mounts.
function codeOnly(source: string): string {
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

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        walk(rel);
      } else if (entry.name.endsWith(".tsx")) {
        out.push(rel);
      }
    }
  };
  for (const root of ROOTS) walk(root);
  return out.sort();
}

// The opening `<OverflowMenu …>` tag starting at `from`, returned with the index
// just past it. Brace-aware, because a prop value is routinely `{() => …}` and a
// naive scan to the first `>` stops inside an arrow function.
function openingTag(
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
  throw new Error("unterminated <OverflowMenu> tag");
}

type Mount = { file: string; tag: string; line: number };

function mounts(): Mount[] {
  const found: Mount[] = [];
  for (const file of sourceFiles()) {
    const source = codeOnly(read(file));
    // The MOUNT, not the definition or a mention in prose: `<OverflowMenu`
    // followed by whitespace or `>`. `OverflowMenu` inside a comment or an
    // import does not match.
    for (const m of source.matchAll(/<OverflowMenu(?=[\s>])/g)) {
      const { tag } = openingTag(source, m.index);
      found.push({
        file,
        tag,
        line: source.slice(0, m.index).split("\n").length,
      });
    }
  }
  return found;
}

// `itemName`'s value at one mount — a string LITERAL, an EXPRESSION, or a THROW.
//
// The throw is the load-bearing branch. This scan judges literals, so anything it
// cannot classify has to be loud: a mount whose `itemName` it silently failed to
// find would be a mount this file has stopped checking, which is exactly the hole
// the `label: string` prop left open in the first place.
function itemNameAt(mount: Mount):
  | { literal: true; text: string }
  | {
      literal: false;
    } {
  const where = `${mount.file}:${mount.line}`;
  // `itemName` as its own attribute, not `menuItemName` or `itemNameOf`.
  const at = mount.tag.search(/(?<![\w$])itemName\s*=/);
  if (at < 0) {
    throw new Error(
      `${where}: <OverflowMenu> carries no \`itemName\`. It is a required prop, so this ` +
        "is a mount this scan could not read rather than one that omits it — make the " +
        "attribute literal on the tag instead of spreading it in."
    );
  }
  let i = mount.tag.indexOf("=", at) + 1;
  while (/\s/.test(mount.tag[i])) i += 1;
  if (mount.tag[i] === '"' || mount.tag[i] === "'") {
    const quote = mount.tag[i];
    const end = mount.tag.indexOf(quote, i + 1);
    if (end < 0) throw new Error(`${where}: unterminated \`itemName\` string`);
    return { literal: true, text: mount.tag.slice(i + 1, end) };
  }
  if (mount.tag[i] !== "{") {
    throw new Error(
      `${where}: \`itemName\` is written in a form this scan cannot read (\`${mount.tag
        .slice(i, i + 20)
        .trim()}\`). Use a quoted string or a braced expression.`
    );
  }
  // A braced expression. A bare string inside braces (`itemName={"More actions"}`)
  // is a literal wearing a costume, so unwrap one before believing it is a row.
  let depth = 0;
  let end = i;
  for (; end < mount.tag.length; end += 1) {
    if (mount.tag[end] === "{") depth += 1;
    else if (mount.tag[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const inner = mount.tag.slice(i + 1, end).trim();
  const bare = inner.match(/^(["'`])([^"'`$]*)\1$/);
  if (bare) return { literal: true, text: bare[2] };
  return { literal: false };
}

describe("every ⋯ menu names the row it acts on (#3501)", () => {
  const census = mounts();

  // THE CENSUS ITSELF, ASSERTED BEFORE ANYTHING IS JUDGED. Every check below is
  // a per-mount verdict, and a verdict over an empty list is green and says
  // nothing.
  it("finds the OverflowMenu mounts it is about to judge", () => {
    expect(
      census.length,
      `Found ${census.length} <OverflowMenu> mounts under ${ROOTS.join("/")}, below the ` +
        `floor of ${MOUNT_FLOOR}. Either this scan has stopped seeing them (a rename, a ` +
        "move, a JSX shape it cannot parse) or the menus really are gone — check which " +
        "before lowering this number."
    ).toBeGreaterThanOrEqual(MOUNT_FLOOR);
  });

  it("names a ROW at every mount, and a literal only where a surface is registered", () => {
    const generic: string[] = [];
    const unregistered: string[] = [];
    for (const mount of census) {
      const value = itemNameAt(mount);
      if (!value.literal) continue;
      const registered = SURFACE_MENUS.get(mount.file);
      if (registered === undefined) {
        generic.push(`${mount.file}:${mount.line} — itemName="${value.text}"`);
      } else if (registered !== value.text) {
        unregistered.push(
          `${mount.file}:${mount.line} — itemName="${value.text}", registered as "${registered}"`
        );
      }
    }
    expect(
      generic,
      "An <OverflowMenu> names a hard-coded string instead of its row. `itemName` is the " +
        "DISPLAY NAME of the row these actions belong to, because below `md` the menu is a " +
        "sheet that has left the row behind by the time anyone reads its heading. A menu " +
        "that genuinely acts on a whole surface rather than a row belongs in SURFACE_MENUS " +
        "in this file, with the reason."
    ).toEqual([]);
    expect(
      unregistered,
      "A registered surface menu's literal has changed. Update SURFACE_MENUS deliberately — " +
        "the registry is what makes 'this is a surface, not a row' a decision rather than a " +
        "string that slipped past."
    ).toEqual([]);
  });

  it("composes the sentence in exactly one place", () => {
    // The phrasing lives in lib/overflow-menu-label.ts and nowhere else. A call
    // site that goes back to writing "… actions" itself has re-opened the drift
    // this issue closed, whichever prop it hands the result to.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = codeOnly(read(file));
      for (const m of source.matchAll(/["'`][^"'`\n]*\bactions for\b/gi)) {
        offenders.push(
          `${file}:${source.slice(0, m.index).split("\n").length}`
        );
      }
    }
    expect(
      offenders,
      `Only ${COMPOSER} composes an action menu's name. A call site spelling ` +
        '"… actions for …" itself is the drift #3501 closed — pass `itemName` (and `kind`) ' +
        "and let the composer write the sentence."
    ).toEqual([]);
  });

  it("no longer offers the `label` prop that made the rule optional", () => {
    // The API boundary, asserted as such. `label` was the prop a caller could obey
    // or ignore; while it exists, so does the option of ignoring the rule.
    const menu = codeOnly(read(MENU));
    expect(menu).toMatch(/(?<![\w$])itemName\s*:\s*string/);
    expect(
      /^\s*label\??\s*:\s*string/m.test(menu),
      `${MENU} declares a \`label\` prop again. #3501's whole mechanism is that the ` +
        "component asks for the row's PARTS and composes the name itself, so there is no " +
        "finished string for a call site to get wrong."
    ).toBe(false);
    expect(menu).toContain(
      COMPOSER.replace(/^lib\//, "@/lib/").replace(/\.ts$/, "")
    );
  });
});

describe("the composed name itself", () => {
  it("leads with the app's existing vocabulary when a kind is given", () => {
    expect(overflowMenuLabel("Amoxicillin", "Medication")).toBe(
      "Medication actions for Amoxicillin"
    );
    expect(overflowMenuLabel("Fermented foods")).toBe(
      "Actions for Fermented foods"
    );
  });

  it("never ships a dangling name to a screen reader", () => {
    // An empty name is a caller bug, and the source guard above is what keeps a
    // caller from choosing this path. What it must not do is render the bug.
    expect(overflowMenuLabel("", "Medication")).toBe("Medication actions");
    expect(overflowMenuLabel("   ")).toBe("Actions");
    expect(overflowMenuLabel("  Vitamin D  ", "  Supplement  ")).toBe(
      "Supplement actions for Vitamin D"
    );
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { jsxTags, lineAt, walkTsx, REPO } from "./jsx-tag-scan";

// Static guard: every command inside a `role="menu"` panel announces itself as
// an item of that menu (issue #5181).
//
// A `role="menu"` whose children are plain buttons is not a menu to a screen
// reader. The role tells assistive technology to expect menu items and to state
// how many there are; a child that carries no menu role is not counted and is
// not announced as part of the list, so the panel reads as "menu, 1 item" over a
// kebab that visibly offers three. The panel is right and the children were
// wrong: components/OverflowMenu.tsx hands `role="menu"` to
// components/overlay/AnchoredPanel.tsx in BOTH presentations, and ~60 items
// across the app already answer with `role="menuitem"` — so this is the shared
// answer being kept, not a new one being minted.
//
// THE POPULATION IS THE PANEL'S CHILDREN, not a class. Keying on `MENU_ITEM`
// would have found the same 18 sites today and been blind tomorrow to an item
// styled any other way — and menu items ARE written without it (the merge
// picker's rows, CompactDateMenu's radios). So the scan locates each menu panel
// and looks at what is inside it.
//
// WHAT COUNTS AS AN ITEM: the command elements — `button`, `a`, `Link` —
// written LITERALLY inside a panel, in the SAME FILE. The scan does not follow a
// component to its definition, so a wrapper mounted in a panel
// (OverflowMenuSubmitItem, SourceDocumentLink, MyChartImport) is skipped here:
// the render tier holds those, and SourceDocumentLink takes `role` from its
// caller, which no definition site can answer for. Non-command content inside a
// panel — a form wrapping a submit item, a hidden input, the merge picker's
// checkboxes — is out of this scan's scope.

const SCAN_DIRS = ["app", "components"];

// The trigger promised a menu, so these are the two ways a panel delivers one:
// the shared kebab, and a hand-rolled panel that declares the role itself.
const MENU_TAG = "OverflowMenu";
const COMMANDS = new Set(["button", "a", "Link"]);

/** [start, end) of the CHILDREN of every menu panel opened in `text`. */
export function menuPanelRegions(text: string): [number, number][] {
  const out: [number, number][] = [];
  const tags = jsxTags(text);
  // A self-closing `<div … />` opens nothing, so counting it as a nesting level
  // leaves the panel's own `</div>` unmatched and runs the region to end of file
  // — reporting commands that are nowhere near the menu (#5204).
  const selfClosingAt = new Set(
    tags.filter((t) => t.selfClosing).map((t) => t.start)
  );
  for (const tag of tags) {
    const opensMenu =
      tag.name === MENU_TAG || /\brole\s*=\s*"menu"/.test(tag.attrs);
    if (!opensMenu || tag.selfClosing) continue;
    const close = `</${tag.name}>`;
    const open = `<${tag.name}`;
    let depth = 1;
    let i = tag.end;
    while (i < text.length && depth > 0) {
      if (text.startsWith(close, i)) {
        depth--;
        if (depth === 0) break;
        i += close.length;
        continue;
      }
      if (
        text.startsWith(open, i) &&
        !/[\w.]/.test(text[i + open.length] ?? "")
      ) {
        if (!selfClosingAt.has(i)) depth++;
        i += open.length;
        continue;
      }
      i++;
    }
    out.push([tag.end, i]);
  }
  return out;
}

// The role the failure message asks for, spelled once. Asking instead whether
// SOME `role=` is present let the likeliest wrong answer through — `role="button"`
// on a button — and a bare `data-role=` with it, since `-` is a non-word
// character. The gate and the population count are ONE question (#5204).
const MENU_ITEM_ROLE = /\brole\s*=\s*"menuitem(checkbox|radio)?"/;

/** Every command inside a menu panel, with whether it announces a menu role. */
function menuCommands(text: string): { line: number; hasRole: boolean }[] {
  const regions = menuPanelRegions(text);
  if (regions.length === 0) return [];
  const inside = (i: number) => regions.some(([s, e]) => i >= s && i < e);
  return jsxTags(text)
    .filter((t) => COMMANDS.has(t.name) && inside(t.start))
    .map((t) => ({
      line: lineAt(text, t.start),
      hasRole: MENU_ITEM_ROLE.test(t.attrs),
    }));
}

/** Line numbers of the commands inside a menu panel that carry no menu role. */
export function menuItemsWithoutRole(text: string): number[] {
  return menuCommands(text)
    .filter((c) => !c.hasRole)
    .map((c) => c.line);
}

/** Line numbers of the commands inside a menu panel that DO carry a menu role. */
function menuItemsWithRole(text: string): number[] {
  return menuCommands(text)
    .filter((c) => c.hasRole)
    .map((c) => c.line);
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walkTsx(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe('every command in a role="menu" panel is an item of it (#5181)', () => {
  it("no menu panel holds a role-less button or link", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      for (const line of menuItemsWithoutRole(text)) {
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(
      offenders,
      `These commands sit inside a role="menu" panel without announcing ` +
        `themselves as items of it, so a screen reader does not count them among ` +
        `the menu's items. Add role="menuitem" (or menuitemcheckbox / ` +
        `menuitemradio for a stateful one) — the same answer the rest of the ` +
        `app's menu items give:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  // THE POSITIVE CONTROL FOR THE CENSUS ITSELF. An empty offender list is only
  // good news if the scan can see the population it is scanning, and this one
  // could not twice over before #5181 fixed the reader: a menu written inside a
  // braced attribute and a menu whose opening tag carries a comment were both
  // invisible. So the census states the size of what it found, and names the two
  // files whose shapes it used to miss.
  it("sees the population it is clearing", () => {
    let panels = 0;
    let items = 0;
    const withPanels: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      const found = menuPanelRegions(text).length;
      if (found > 0) withPanels.push(rel);
      panels += found;
      items += menuItemsWithRole(text).length;
    }
    expect(panels).toBeGreaterThanOrEqual(30);
    expect(items).toBeGreaterThanOrEqual(60);
    // The menu inside a braced `action={…}` prop, and the menu whose opening tag
    // carries a `//` comment containing a backtick. Each was a whole panel the
    // reader stepped over.
    expect(withPanels).toContain("app/(app)/protocols/ProtocolControls.tsx");
    expect(withPanels).toContain("app/(app)/trends/BodyMetricRowMenu.tsx");
  });

  it("recognises the defect and leaves everything else alone", () => {
    const menu = (body: string) =>
      `<OverflowMenu itemName={n} open={o} onOpenChange={s}>{({ close }) => (${body})}</OverflowMenu>`;

    // The defect: a command in the panel with no role.
    expect(
      menuItemsWithoutRole(
        menu(`<button type="button" onClick={close}>Edit</button>`)
      )
    ).toEqual([1]);
    // A link is a menu item too when the menu is what it is inside.
    expect(menuItemsWithoutRole(menu(`<Link href={h}>Open</Link>`))).toEqual([
      1,
    ]);
    // A hand-rolled panel that declares the role itself is held to the same rule.
    expect(
      menuItemsWithoutRole(
        `<div role="menu"><button type="button">Edit</button></div>`
      )
    ).toEqual([1]);

    // A button OUTSIDE any menu is not this scan's business.
    expect(
      menuItemsWithoutRole(`<div><button type="button">Save</button></div>`)
    ).toEqual([]);
    // Nor is one after the panel has closed.
    expect(
      menuItemsWithoutRole(
        `${menu(`<button type="button" role="menuitem">Edit</button>`)}<button type="button">Save</button>`
      )
    ).toEqual([]);
  });

  // THE GATE SPELLS THE ROLE IT DEMANDS (#5204). Asking only whether SOME
  // `role=` is present accepts the likeliest wrong answer — `role="button"` on a
  // button — and a `data-role=` passes too, because `-` is a non-word character.
  it.each([
    ['role="menuitem"', []],
    ['role="menuitemradio"', []],
    ['role="menuitemcheckbox"', []],
    ['role="button"', [1]],
    ['role="menu-item"', [1]],
    ['data-role="edit"', [1]],
  ])("a command in a panel carrying %s", (attr, expected) => {
    expect(
      menuItemsWithoutRole(
        `<div role="menu"><button type="button" ${attr}>Edit</button></div>`
      )
    ).toEqual(expected);
  });

  // WHAT THE SCAN REACHES. Commands written literally inside a panel, in the
  // same file. It does not follow a component to its definition, and a
  // definition that sits outside any panel is not scanned at all — this pins the
  // claim the header makes, which used to say the opposite (#5204).
  it("reads only the commands written inside a panel in the same file", () => {
    expect(
      menuItemsWithoutRole(
        `export function Item() {\n  return <button type="button">Edit</button>;\n}`
      )
    ).toEqual([]);
    expect(
      menuItemsWithoutRole(
        `<div role="menu"><OverflowMenuSubmitItem label="Edit" /></div>`
      )
    ).toEqual([]);
  });

  // THE READER'S BLIND SPOTS (#5204). An apostrophe in menu copy ("Don't",
  // "won't", "today's") and a regex literal both opened a string that ran on,
  // taking every tag after it out of the census — the direction that reads as a
  // clean bill of health.
  it.each([
    [
      "an apostrophe in menu copy",
      `<div role="menu">Don't stop<button type="button">Edit</button></div>`,
      [1],
    ],
    [
      // The apostrophe closing on the SAME line is the one only the
      // operand-position rule catches: "Don't" opens, "today's" closes, and the
      // item between them was gone from the census.
      "an apostrophe on each side of an item",
      `<div role="menu">Don't stop<button type="button">Edit</button>today's plan</div>`,
      [1],
    ],
    [
      // And a quote that never closes at all is not a string either — an
      // opening apostrophe in copy used to take the rest of the file.
      "an apostrophe that opens copy and never closes",
      `<div role="menu">'til later<button type="button">Edit</button></div>`,
      [1],
    ],
    [
      "a regex literal above the panel",
      `const q = /['"]/;\n<div role="menu"><button type="button">Edit</button></div>`,
      [2],
    ],
  ])("still sees the items after %s", (_shape, src, expected) => {
    expect(menuItemsWithoutRole(src)).toEqual(expected);
  });

  it("ends a panel at its own close, not at a self-closing child", () => {
    // The third shape, and it INVENTS population: a self-closing `<div … />`
    // opens nothing, so counting it as a nesting level leaves the panel's own
    // `</div>` unmatched and the region runs to end of file — reporting a button
    // that is nowhere near the menu.
    const src = [
      '<div role="menu">',
      '<div className="sep" />',
      '<button type="button" role="menuitem">Edit</button>',
      "</div>",
      '<button type="button">Save</button>',
    ].join("\n");
    expect(menuPanelRegions(src)).toHaveLength(1);
    expect(menuPanelRegions(src)[0][1]).toBe(src.indexOf("</div>"));
    expect(menuItemsWithoutRole(src)).toEqual([]);
  });

  it("sees a menu nested in a braced attribute value", () => {
    // app/(app)/protocols/ProtocolControls.tsx and
    // app/(app)/wellness/PracticeCard.tsx both mount their kebab inside a
    // header's `action` prop. Skipping braces wholesale hid five real offenders
    // in the first of those, and folded the second's items into the OUTER tag's
    // attributes — inventing population as readily as it hid it.
    const src = `<PageHeader title={t} action={<div><OverflowMenu itemName={n} open={o} onOpenChange={s}>{() => (<button type="button">End now</button>)}</OverflowMenu></div>} />`;
    expect(menuPanelRegions(src)).toHaveLength(1);
    expect(menuItemsWithoutRole(src)).toEqual([1]);
  });

  it("sees a menu whose opening tag carries a comment", () => {
    // app/(app)/trends/BodyMetricRowMenu.tsx and app/(app)/upcoming/RowActions.tsx
    // explain their `itemName` in a `//` comment between attributes, and the one
    // in BodyMetricRowMenu quotes a template literal. A reader that skipped
    // comments only BETWEEN tags opened a string on that backtick and lost the
    // rest of the file.
    const src = [
      "<OverflowMenu",
      "  // it used to compose `Actions for entry from ${label}` itself",
      "  itemName={label}",
      "  open={o}",
      "  onOpenChange={s}",
      ">",
      '  {() => <button type="button">Delete entry</button>}',
      "</OverflowMenu>",
    ].join("\n");
    expect(menuPanelRegions(src)).toHaveLength(1);
    expect(menuItemsWithoutRole(src)).toEqual([7]);
  });
});

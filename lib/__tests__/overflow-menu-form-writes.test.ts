// EVERY KEBAB MENU'S WRITE GOES THROUGH `runAction` (#2641).
//
// `OverflowMenu.runAction` is what turns a menu item's Server Action into a
// reported one: a typed refusal toasts its own error, a throw toasts the failure
// sentence, and both are raised from the menu component rather than from the panel
// that is about to unmount. A menu item that spells the same thing by hand —
//
//   <form action={async (fd) => { await someAction(fd); close(); }}>
//
// gets none of it. The action's `FormResult` is discarded, so a refusal renders as
// nothing at all and is indistinguishable from a lost tap; a throw escalates to the
// route error boundary (#477).
//
// That is not hypothetical. It is what `components/illness/EpisodeControls.tsx`
// did for "Remove condition" — `unpromoteEpisodeConditionAction` refuses an episode
// that is no longer there, and nobody ever saw the refusal — for the nine months
// after every other menu write moved onto the shared path. The copy survived
// precisely because nothing could see it: it type-checks, it renders, it posts.
//
// WHICH DIRECTION THIS FAILS. The census is a per-item verdict, and a verdict over
// an empty list is green and says nothing — the defect class this repo keeps
// naming. So it asserts its own floor first, and an item whose enclosing form it
// cannot read THROWS rather than being skipped.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO, relPath } from "./sql-scan";
import { stripComments } from "./strip-comments";

// The floors, measured on this tree: 10 submitting menu items across 5 files
// (SnoozeDismissMenu 2, RowActions 3, GoalsManager 3, EditableSupplementRow 1,
// EpisodeControls 1). Not exact counts — menus are added all the time and this
// file is not a changelog — but numbers a scan that has stopped seeing the items
// cannot clear. They only move up, and only when someone has looked.
const ITEM_FLOOR = 10;
const FILE_FLOOR = 5;

function menuFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        walk(p);
      } else if (e.isFile() && p.endsWith(".tsx")) {
        out.push(p);
      }
    }
  };
  walk(path.join(REPO, "components"));
  walk(path.join(REPO, "app"));
  return out;
}

const lineAt = (code: string, i: number) => code.slice(0, i).split("\n").length;

export interface MenuItem {
  file: string;
  line: number;
  // The enclosing <form>'s `action` prop, verbatim.
  action: string;
}

// The `action={…}` of the <form> a menu item at `at` posts, or a throw. Brace-aware
// on the way out of the prop, because the value is routinely `{(fd) => …}` and a
// scan to the first `>` stops inside the arrow function.
function enclosingFormAction(code: string, at: number, where: string): string {
  const formAt = code.lastIndexOf("<form", at);
  const opened = formAt >= 0 && !code.slice(formAt, at).includes("</form>");
  // A menu item this scan cannot attribute to a form is a menu item it has stopped
  // checking — exactly the hole the hand-rolled copy sat in. Be loud.
  if (!opened)
    throw new Error(
      `${where}: a submitting menu item outside any <form>, which this scan cannot read.`
    );
  const propAt = code.slice(formAt, at).search(/(?<![\w$])action\s*=\s*\{/);
  if (propAt < 0)
    throw new Error(
      `${where}: its <form> carries no readable \`action={…}\`. A menu write is a Server ` +
        "Action posted through `runAction`; make the prop literal on the tag."
    );
  const start = code.indexOf("{", formAt + propAt);
  let depth = 0;
  for (let i = start; i < at; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}" && --depth === 0) return code.slice(start, i + 1);
  }
  throw new Error(`${where}: unterminated \`action={…}\` on its <form>.`);
}

// Every `<OverflowMenuSubmitItem>` mount — the shape a kebab's write is spelled in —
// paired with the form it posts. Imports and prose do not match: the name must be
// followed by whitespace or `>`, in code with the comments blanked out.
export function menuSubmitItems(src: string, file: string): MenuItem[] {
  const code = stripComments(src);
  const items: MenuItem[] = [];
  for (const m of code.matchAll(/<OverflowMenuSubmitItem(?=[\s>])/g)) {
    const line = lineAt(code, m.index);
    items.push({
      file,
      line,
      action: enclosingFormAction(code, m.index, `${file}:${line}`),
    });
  }
  return items;
}

describe("kebab menu writes go through runAction (#2641)", () => {
  const items: MenuItem[] = [];
  for (const f of menuFiles()) {
    const rel = relPath(f);
    if (rel.includes("__tests__")) continue;
    items.push(...menuSubmitItems(fs.readFileSync(f, "utf8"), rel));
  }
  const files = new Set(items.map((i) => i.file));

  it("finds the submitting menu items it is about to judge", () => {
    expect(
      items.length,
      `Found ${items.length} submitting menu items under components/ and app/, below the ` +
        `floor of ${ITEM_FLOOR}. Either this scan has stopped seeing them (a rename, a moved ` +
        "directory, a JSX shape it cannot parse) or the menu writes really are gone — check " +
        "which before lowering this number."
    ).toBeGreaterThanOrEqual(ITEM_FLOOR);
    expect(
      files.size,
      `Those items are in ${files.size} files, below the floor of ${FILE_FLOOR}.`
    ).toBeGreaterThanOrEqual(FILE_FLOOR);
  });

  it("posts every one of them through runAction", () => {
    const handRolled = items
      .filter((i) => !/(?<![\w$])runAction\s*\(/.test(i.action))
      .map(
        (i) => `${i.file}:${i.line} — action=${i.action.replace(/\s+/g, " ")}`
      );
    expect(
      handRolled,
      "A kebab menu item posts its write without `runAction`. Hand-rolling it — awaiting the " +
        "action and then calling `close()` — discards the action's typed result, so a refusal " +
        "is indistinguishable from a lost tap, and lets a throw reach the route error boundary. " +
        "Pass the action to `runAction(action, fd, message)` instead."
    ).toEqual([]);
  });

  // The guard must be able to fail (the #1893 fixture rule).
  it("FLAGS a planted hand-rolled write and reads a shared one", () => {
    const handRolled = `<form action={async (fd) => { await someAction(fd); close(); }}>
      <OverflowMenuSubmitItem pendingLabel="Removing…">Remove condition</OverflowMenuSubmitItem>
    </form>`;
    expect(menuSubmitItems(handRolled, "f.tsx")).toEqual([
      {
        file: "f.tsx",
        line: 2,
        action: "{async (fd) => { await someAction(fd); close(); }}",
      },
    ]);

    const shared = `<form action={(fd) => runAction(someAction, fd, "Done")}>
      <OverflowMenuSubmitItem>Remove condition</OverflowMenuSubmitItem>
    </form>`;
    expect(
      menuSubmitItems(shared, "f.tsx").map((i) =>
        /(?<![\w$])runAction\s*\(/.test(i.action)
      )
    ).toEqual([true]);

    // An item with no form to post is unreadable, not absent.
    expect(() =>
      menuSubmitItems(
        `<OverflowMenuSubmitItem>Remove</OverflowMenuSubmitItem>`,
        "f.tsx"
      )
    ).toThrow(/outside any <form>/);

    // Prose and imports are not mounts.
    expect(
      menuSubmitItems(
        `import { OverflowMenuSubmitItem } from "@/components/OverflowMenu";\n// <OverflowMenuSubmitItem> in a sentence\n`,
        "f.tsx"
      )
    ).toEqual([]);
  });
});

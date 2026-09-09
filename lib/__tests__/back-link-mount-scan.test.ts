import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard: a page under `app/` does not mount `BackLink` itself (#5411).
//
// #3237 unified the arrow, the paint and the tap into one component but left the
// PLACE to each caller, so "above the title, never below it, never inside a card"
// held only because 20 of 24 files happened to write `<BackLink>` on the line
// before `<PageHeader>`. #5411 moved the place into the header: `PageHeader` takes
// a `back` slot and draws it above its own h1, which also keeps the link visible
// where `compactBelowSm` sends the title `sr-only`. A page that mounts the
// component directly opts out of both guarantees, silently.
//
// Three pages have no `PageHeader` to put it in and keep a standalone mount by
// argument. They are named below; a fourth is this test going red.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The whole remainder. Each entry states why the page has no header slot.
const HEADERLESS_MOUNTS: Record<string, string> = {
  // The printable card IS the content; the link shares a row with PrintButton.
  "app/(app)/immunizations/print/page.tsx": "printable card, no page title",
  "app/(app)/medications/print/page.tsx": "printable card, no page title",
  // #531/#534: the episode's identity is inside its card, not in a page header.
  "app/(app)/medical/episodes/[id]/page.tsx": "in-card identity (#531/#534)",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// An import of the component or a render of it. Either one is a mount site: the
// import is what a page needs to draw its own, and the tag is the drawing.
export function mountsBackLink(text: string): boolean {
  return (
    /(^|\n)\s*import\s+BackLink\s+from\s+"@\/components\/BackLink"/.test(
      text
    ) || /<BackLink(?=[\s/>])/.test(text)
  );
}

function appMountSites(): string[] {
  const sites: string[] = [];
  for (const full of walk(path.join(REPO, "app"))) {
    const rel = path.relative(REPO, full).split(path.sep).join("/");
    if (rel.includes("__tests__")) continue;
    if (mountsBackLink(fs.readFileSync(full, "utf8"))) sites.push(rel);
  }
  return sites.sort();
}

describe("back links are placed by the header (#5411)", () => {
  it("mounts BackLink under app/ only in the three headerless pages", () => {
    expect(
      appMountSites(),
      "A page with a `PageHeader` cannot draw its own back link: pass " +
        "`back={{ href, destination }}` and the header places it above the h1 and " +
        "keeps it visible where `compactBelowSm` hides the title. The three files " +
        "listed in this test have no page header to hold the slot. If a fourth " +
        "genuinely has none, add it here with the reason it does."
    ).toEqual(Object.keys(HEADERLESS_MOUNTS).sort());
  });

  it("recognises a mount and leaves a header slot alone", () => {
    expect(
      mountsBackLink('import BackLink from "@/components/BackLink";\n')
    ).toBe(true);
    expect(mountsBackLink('<BackLink href={h} destination="Body" />')).toBe(
      true
    );
    // The header slot is the sanctioned form and names no component.
    expect(
      mountsBackLink('<PageHeader back={{ href: h, destination: "Body" }} />')
    ).toBe(false);
    // A different component whose name merely starts the same way is not a mount.
    expect(mountsBackLink("<BackLinkRail />")).toBe(false);
  });
});

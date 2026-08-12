import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard: `aria-pressed` never appears on a link (issue #2535).
//
// `aria-pressed` is a TOGGLE BUTTON state. It is supported on `role="button"` and
// the roles that inherit from it. An `<a href>` is `role="link"`, which does not
// support it, so the attribute is invalid there and axe's `aria-allowed-attr` rule
// flags it. The consequence is not cosmetic: assistive technology announces NO
// selected state at all, so a screen-reader user cannot tell which of the segments
// is the one in effect. The visual selection is carried entirely by `className`.
//
// Four URL-state selectors had exactly this defect — Timeline's and Upcoming's mode
// toggles, the body census's Tiles / All charts, and the care trail's Illness /
// Visits — because `SegmentedControl` was onChange-only and none of them could reach
// it. All four now use its link binding, which renders `aria-current`. The 40-odd
// `aria-pressed` occurrences on real `<button>` elements elsewhere in the app are
// correct and untouched; this scan only looks at links.
//
// The rule has no false-positive surface: there is no case where a link should carry
// a pressed state. A link that represents the current view uses `aria-current`
// ("page" when the segments are different views of the surface, "true" when they
// re-present the page you are already on).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

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

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// The opening tag starting at `start` (the `<`), ended by the first `>` outside
// braces and string literals — so `onClick={() => …}` does not cut it short.
function tagText(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length && i < start + 4000; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start, start + 4000);
}

export function linkAriaPressedLines(text: string): number[] {
  const out: number[] = [];
  // `<a` and `<Link` — the two ways this app renders an anchor. PendingNavLink and
  // SegmentedControl wrap one of them and are covered through their own source.
  const re = /<(a|Link)(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const tag = tagText(text, m.index);
    if (/\baria-pressed\b/.test(tag)) {
      out.push(text.slice(0, m.index).split("\n").length);
    }
  }
  return out;
}

describe("aria-pressed never lands on a link (#2535)", () => {
  it("no <a> or <Link> carries aria-pressed", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      for (const line of linkAriaPressedLines(text)) {
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(
      offenders,
      `aria-pressed is a toggle-BUTTON state and an <a href> is role="link", so ` +
        `it is invalid there and the selected state is announced to nobody. Use ` +
        `aria-current on a link. For a one-line mutually-exclusive selector whose ` +
        `state lives in the URL, render <SegmentedControl> with an \`href\` on each ` +
        `option — it owns both bindings.`
    ).toEqual([]);
  });

  it("recognises the defect and leaves buttons alone", () => {
    expect(
      linkAriaPressedLines('<Link href={h} aria-pressed={active}>x</Link>')
    ).toEqual([1]);
    expect(linkAriaPressedLines('<a href="/x" aria-pressed="true">x</a>')).toEqual(
      [1]
    );
    // A multi-line tag with an arrow function before the attribute still matches.
    expect(
      linkAriaPressedLines(
        "<Link\n  href={h}\n  onClick={() => go(1)}\n  aria-pressed={on}\n>\n"
      )
    ).toEqual([1]);
    // Buttons are the correct home for it.
    expect(
      linkAriaPressedLines('<button type="button" aria-pressed={active} />')
    ).toEqual([]);
    // aria-current on a link is the fix, not another offense.
    expect(
      linkAriaPressedLines('<Link href={h} aria-current="page">x</Link>')
    ).toEqual([]);
  });
});

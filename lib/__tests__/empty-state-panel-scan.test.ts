import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the shared empty-state panel (issue #2536).
//
// `EmptyState` (components/ui.tsx) is the app's ONE "nothing here yet" panel. The
// audit that produced this scan found eleven hand-rolled copies of its dashed panel
// across ten files — one of them character-for-character its default className, one
// that string with every token `sm:`-prefixed, and two more it minus the background
// pair. They had already drifted to three paddings (`p-10`, `py-8`, `py-6`) and two
// radii, so the same "nothing here" panel rendered at three sizes depending on which
// surface you landed on.
//
// Copying it stopped being cosmetic in #2531. That change made `EmptyState` stamp
// `data-empty-state` on itself, and app/globals.css keys a layout rule on the marker
// (`&:has(> [data-empty-state]) { aspect-ratio: auto; height: auto; }`) — which is
// how #2399's "an absent chart does not reserve the chart's height" is implemented.
// A hand-rolled panel carries no marker, so it is invisible to that rule and to
// anything that later keys on it. The component is now load-bearing, and a copy of
// it is a silent opt-out rather than a style nit.
//
// The signature scanned is the one the audit was found by, so the guard is exactly
// as precise as the audit: a class literal carrying BOTH `border-dashed` and
// `text-center` as standalone tokens (responsive/dark variant prefixes stripped, so
// `sm:border-dashed` counts). That pair IS the panel; a dashed border used for
// anything else in the app — a dashed "add" chip, a dashed chart guide line, a
// dashed drop target, a dashed placeholder dot — never centers its text, and none
// of those trip it.
//
// A surface that genuinely cannot express itself through the component declares
// itself below with a reason. An allowlist entry, not silent drift.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// The component itself, plus any surface whose panel the component cannot express.
const ALLOWLIST = new Map<string, string>([
  [
    "components/ui.tsx",
    "EmptyState itself — this is the one declaration of the panel",
  ],
  [
    "app/(app)/trends/StarredSection.tsx",
    "ONE responsive state, not a copy: below `sm` the starred grid's empty state " +
      "is a compact inline row carrying the add-tile control, and the dashed " +
      "panel only appears at `sm` and up (every token is `sm:`-prefixed). " +
      "EmptyState takes a message and typed links, so it can express neither the " +
      "breakpoint nor the control — and #2536 decided against widening it into a " +
      "content slot for a single caller, which is how a primitive becomes a div",
  ],
]);

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

// Every string / template literal in the file, with the 1-based line it opens on.
// Class strings are the only literals long enough to carry both tokens, so no JSX
// parsing is needed — a literal is scanned wherever it sits (a `className=`, a
// `const panel =`, a ternary branch, a lookup table's value).
function literals(text: string): { line: number; value: string }[] {
  const out: { line: number; value: string }[] = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const startLine = line;
      const quote = ch;
      let value = "";
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          value += text[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        if (text[i] === "\n") line++;
        value += text[i];
        i++;
      }
      out.push({ line: startLine, value });
      continue;
    }
    i++;
  }
  return out;
}

// A Tailwind class token with any variant prefixes (`sm:`, `dark:`, `sm:dark:`)
// removed — `sm:border-dashed` and `border-dashed` are the same decision.
function bareTokens(value: string): Set<string> {
  const out = new Set<string>();
  for (const raw of value.split(/[\s${}]+/)) {
    if (!raw) continue;
    const parts = raw.split(":");
    out.add(parts[parts.length - 1]);
  }
  return out;
}

export function panelLiterals(text: string): number[] {
  return literals(text)
    .filter(({ value }) => {
      if (!value.includes("border-dashed")) return false;
      const tokens = bareTokens(value);
      return tokens.has("border-dashed") && tokens.has("text-center");
    })
    .map(({ line }) => line);
}

describe("the shared empty-state panel (#2536)", () => {
  it("no file hand-rolls EmptyState's dashed panel", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOWLIST.has(rel)) continue;
      for (const line of panelLiterals(text)) {
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(
      offenders,
      `These class strings draw EmptyState's dashed panel (border-dashed + ` +
        `text-center) by hand. Render <EmptyState message=… /> instead — it ` +
        `carries the #2531 data-empty-state marker that #2399's layout rule ` +
        `keys on, takes typed \`action\`/\`actions\` links when the copy names a ` +
        `destination (#812/#1410), and has exactly two paddings (default and ` +
        `\`compact\`). If a surface genuinely cannot use it, add it to ` +
        `ALLOWLIST in this file with the reason.`
    ).toEqual([]);
  });

  it("every allowlisted file exists and still draws the panel", () => {
    // An allowlist entry that no longer matches is a stale exemption — it would
    // silently excuse a future hand-roll in the same file.
    const stale: string[] = [];
    for (const rel of ALLOWLIST.keys()) {
      const abs = path.join(REPO, rel);
      if (!fs.existsSync(abs)) {
        stale.push(`${rel} (file is gone)`);
        continue;
      }
      if (panelLiterals(fs.readFileSync(abs, "utf8")).length === 0) {
        stale.push(`${rel} (no longer draws the panel)`);
      }
    }
    expect(
      stale,
      "Stale ALLOWLIST entries — remove them so the scan keeps covering these files."
    ).toEqual([]);
  });

  it("recognises the panel signature and nothing adjacent to it", () => {
    // The verbatim copy this issue was filed over (NotifyRunTable's, now adopted).
    expect(
      panelLiterals(
        'const c = "rounded-xl border border-dashed border-black/10 bg-white ' +
          'p-10 text-center text-sm text-slate-500";'
      )
    ).toEqual([1]);
    // Responsive variants count — StarredSection's copy was this shape.
    expect(
      panelLiterals('const c = "sm:border-dashed sm:text-center";')
    ).toEqual([1]);
    // A dashed control that does not center text is not this panel.
    expect(
      panelLiterals('const c = "rounded-full border border-dashed px-3 py-1";')
    ).toEqual([]);
    // Centered text without a dashed border is not this panel either.
    expect(panelLiterals('const c = "text-center text-sm";')).toEqual([]);
    // Not fooled by a token that merely contains one of the names.
    expect(
      panelLiterals('const c = "border-dashed-alt text-center";')
    ).toEqual([]);
  });
});

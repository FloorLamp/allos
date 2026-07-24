import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard banning the native HTML <datalist> autocomplete (issues #1176/#1177).
// The native control gives only prefix matching, no fuzzy search, and no per-option
// adornments (no individual/organization icons, no by-id disambiguation), and it
// dedupes options by value so two distinct same-named providers collapse (#534/#574).
// Every autocomplete now goes through the shared components/Combobox.tsx (fuzzyFilter
// + allowFreeText + the #1176 iconFor slot) — usually via a thin wrapper
// (ProviderCombobox, or the option-context providers). This test reads the repo's own
// source as TEXT (no DB, no network, so it stays "pure" in the vitest sense) and fails
// the build if a NEW `<datalist>` element or an `<input … list=…>` that pairs with one
// appears in app/ or components/, pointing the author at the Combobox instead.
//
// House style (telegram-chokepoint): the scan does NOT strip comments — a stray
// `<datalist` in a doc comment counts too, so the ban can't be narrated around. A
// genuinely-needed exception carries an inline `datalist-guard-ok` marker on the line.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// React JSX lives in these dirs.
const SCAN_DIRS = ["app", "components"];

// The banned signatures: the <datalist> element, and the ` list=` JSX attribute that
// links a plain <input> to one (` list="ids"` / ` list={id}`). A default param like
// `list = []` carries spaces around `=` and so never matches ` list=`.
const DATALIST = /<datalist\b/;
const LIST_ATTR = /\slist=/;

// A line may opt out with an inline marker (the guard's escape hatch).
const MARKER = "datalist-guard-ok";

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
      if (rel.includes("__tests__") || rel.endsWith(".test.tsx")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("no native <datalist> autocomplete (issues #1176/#1177)", () => {
  it("every autocomplete uses the shared Combobox, not a native <datalist>", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      text.split("\n").forEach((line, i) => {
        if (line.includes(MARKER)) return;
        if (DATALIST.test(line) || LIST_ATTR.test(line))
          offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `Native <datalist> / <input list=…> is banned — use the shared ` +
        `components/Combobox.tsx (fuzzy search + icons + create-on-type) or one of ` +
        `its wrappers (ProviderCombobox, the option-context providers). Offending ` +
        `lines:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the shared Combobox exists and carries the iconFor leading slot (#1176)", () => {
    const src = fs.readFileSync(
      path.join(REPO, "components/Combobox.tsx"),
      "utf8"
    );
    expect(/export default function Combobox\b/.test(src)).toBe(true);
    expect(src.includes("iconFor")).toBe(true);
  });
});

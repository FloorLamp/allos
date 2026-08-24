import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #2730 closes the selected-state third voice. A mutually exclusive client
// view uses SegmentedControl; navigation uses chip-nav; an in-place filter uses
// chip-filter. The only two semantic keeps are documented at their sites.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const KEEP_MARKER = "Selected-state registry keep (#2730)";
const KEEP_FILES = [
  "app/(app)/settings/SettingsSubPageNav.tsx",
  "components/DoseStatusControl.tsx",
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".tsx")) files.push(rel);
    }
  };
  walk("app");
  walk("components");
  return files.filter((file) => !file.includes("/__tests__/"));
}

function openingTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length && i < start + 4000; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start, start + 4000);
}

export function handRolledSelectedTags(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(/<(?:button|Link)(?=[\s/>])/g)) {
    const tag = openingTag(source, match.index ?? 0);
    if (!/\baria-(?:pressed|current)\b/.test(tag)) continue;
    if (/\bchip chip-(?:nav|filter)\b/.test(tag)) continue;
    // Full-width menu rows and content rows are not chips. Everything else
    // with a control radius, horizontal padding, and a selected-state ternary
    // is the hand-roll this guard closes.
    if (/\bw-full\b/.test(tag)) continue;
    if (
      /rounded-(?:full|md)(?![\w-])/.test(tag) &&
      /\bpx-\d/.test(tag) &&
      /\?/.test(tag)
    ) {
      hits.push(tag);
    }
  }
  return hits;
}

describe("selected-state rows use the registered primitive (#2730)", () => {
  it("has no selected chip hand-roll outside the registered primitives", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = read(file);
      for (const tag of handRolledSelectedTags(source)) {
        const line = source.slice(0, source.indexOf(tag)).split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("recognises a planted fourth voice and accepts registered roles", () => {
    expect(
      handRolledSelectedTags(
        '<button aria-pressed={on} className={`rounded-full px-2.5 ${on ? "bg-brand-500" : "bg-slate-100"}`}>x</button>'
      )
    ).toHaveLength(1);
    expect(
      handRolledSelectedTags(
        '<button aria-pressed={on} className="chip chip-filter chip-sm">x</button>'
      )
    ).toEqual([]);
  });

  it("freezes the two documented semantic keeps", () => {
    const marked = sourceFiles()
      .filter((file) => read(file).includes(KEEP_MARKER))
      .sort();
    expect(marked).toEqual([...KEEP_FILES].sort());
  });

  it("pins the four live-row dispositions from the issue", () => {
    const training = read("app/(app)/training/TrainingLogView.tsx");
    expect(training).toContain("<SegmentedControl");
    expect(training).toContain('className="chip chip-filter"');
    expect(read("components/ImportTabStrip.tsx")).toContain(
      'className="chip chip-nav chip-sm"'
    );
    expect(read("components/DataTableManager.tsx")).not.toContain(
      "aria-pressed"
    );
  });
});

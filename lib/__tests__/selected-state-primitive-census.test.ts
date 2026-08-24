import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findFlooredControls,
  withoutComments,
  type ImportedModule,
} from "@/lib/tap-floor-reach";
import { makeTmpDir } from "./tmp-dir";

// #2730 closes the selected-state third voice. A mutually exclusive client
// view uses SegmentedControl; navigation uses chip-nav; an in-place filter uses
// chip-filter. The scan resolves local and imported class helpers before it
// judges them, so moving a hand-roll behind `chipCls(active)` cannot hide it.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const KEEP_MARKER = "Selected-state registry keep (#2730)";
const KEEP_FILES = [
  "app/(app)/settings/SettingsSubPageNav.tsx",
  "components/DoseStatusControl.tsx",
] as const;
const PRIMITIVE_IMPLEMENTATION_FILES = [
  "components/SegmentedControl.tsx",
] as const;
const UNREADABLE_SELECTED_STATE = [
  "components/CustomRangeDisclosure.tsx", // forwarded registered chip-filter class from DateRangeControl
  "components/activity-form/IntensityPicker.tsx", // three-up field grid, not a chip row
] as const;

function read(base: string, rel: string): string {
  return fs.readFileSync(path.join(base, rel), "utf8");
}

function sourceFiles(base: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    const abs = path.join(base, dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".tsx")) files.push(rel);
    }
  };
  walk("app");
  walk("components");
  return files.filter((file) => !file.includes("/__tests__/"));
}

function moduleReader(base: string, dir: string) {
  const cache = new Map<string, ImportedModule | null>();
  const reader = (specifier: string): ImportedModule | null => {
    let target: string;
    if (specifier.startsWith("@/"))
      target = path.join(base, specifier.slice(2));
    else if (specifier.startsWith(".")) target = path.resolve(dir, specifier);
    else return null;
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const file = target + suffix;
      if (!cache.has(file)) {
        cache.set(
          file,
          fs.existsSync(file)
            ? {
                source: withoutComments(fs.readFileSync(file, "utf8")),
                readModule: moduleReader(base, path.dirname(file)),
              }
            : null
        );
      }
      const found = cache.get(file)!;
      if (found) return found;
    }
    return null;
  };
  return reader;
}

type Finding = { file: string; line: number; className: string };

function isHandRolledSelectedClass(className: string): boolean {
  if (/\bchip chip-(?:nav|filter)\b/.test(className)) return false;
  if (/\bw-full\b/.test(className)) return false;
  return (
    /rounded-(?:full|md)(?![\w-])/.test(className) &&
    /\b(?:px|p[lr])-\d/.test(className)
  );
}

export function scanSelectedStateCorpus(base: string): {
  findings: Finding[];
  unreadable: string[];
} {
  const findings: Finding[] = [];
  const unreadable = new Set<string>();
  for (const file of sourceFiles(base)) {
    const source = withoutComments(read(base, file));
    const controls = findFlooredControls(
      source,
      moduleReader(base, path.dirname(path.join(base, file)))
    );
    for (const control of controls) {
      if (!control.selectedState) continue;
      if (
        (KEEP_FILES as readonly string[]).includes(file) ||
        (PRIMITIVE_IMPLEMENTATION_FILES as readonly string[]).includes(file)
      )
        continue;
      if (!control.readable) {
        unreadable.add(file);
        continue;
      }
      if (isHandRolledSelectedClass(control.className))
        findings.push({
          file,
          line: control.line,
          className: control.className,
        });
    }
  }
  return { findings, unreadable: [...unreadable].sort() };
}

describe("selected-state rows use the registered primitive (#2730)", () => {
  it("has no selected chip hand-roll outside the registered primitives", () => {
    const scan = scanSelectedStateCorpus(REPO);
    expect(scan.findings).toEqual([]);
    expect(scan.unreadable).toEqual([...UNREADABLE_SELECTED_STATE].sort());
  });

  it("fails on a helper-bound fourth voice in a filesystem corpus", () => {
    const base = makeTmpDir("selected-state-census");
    try {
      fs.mkdirSync(path.join(base, "components"), { recursive: true });
      fs.mkdirSync(path.join(base, "lib"), { recursive: true });
      fs.writeFileSync(
        path.join(base, "lib/chips.ts"),
        'export const chipCls = (on: boolean) => `rounded-full border px-2.5 py-1 ${on ? "bg-brand-500" : "bg-slate-100"}`;\n'
      );
      fs.writeFileSync(
        path.join(base, "components/Offender.tsx"),
        'import { chipCls } from "@/lib/chips";\nexport function Offender({ on }: { on: boolean }) { return <button aria-pressed={on} className={chipCls(on)}>x</button>; }\n'
      );
      expect(scanSelectedStateCorpus(base).findings).toMatchObject([
        { file: "components/Offender.tsx", line: 2 },
      ]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("freezes the two documented semantic keeps", () => {
    const marked = sourceFiles(REPO)
      .filter((file) => read(REPO, file).includes(KEEP_MARKER))
      .sort();
    expect(marked).toEqual([...KEEP_FILES].sort());
  });

  it("pins the four live-row dispositions from the issue", () => {
    const training = read(REPO, "app/(app)/training/TrainingLogView.tsx");
    expect(training).toContain("<SegmentedControl");
    expect(training).toContain('className="chip chip-filter"');
    expect(read(REPO, "components/ImportTabStrip.tsx")).toContain(
      'className="chip chip-nav chip-sm"'
    );
    expect(read(REPO, "components/DataTableManager.tsx")).not.toContain(
      "aria-pressed"
    );
  });
});

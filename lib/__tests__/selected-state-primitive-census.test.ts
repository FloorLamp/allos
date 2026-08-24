import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classDeclarations,
  classNameExpression,
  findFlooredControls,
  isApprovedChipAdopterClass,
  openingTag,
  resolveJsxClassNameBindings,
  unapprovedChipAdopterTokens,
  withoutComments,
  type ImportedModule,
} from "@/lib/tap-floor-reach";
import { makeTmpDir } from "./tmp-dir";

// #2730 closes the selected-state third voice. A mutually exclusive client
// view uses SegmentedControl; navigation uses chip-nav; an in-place filter uses
// chip-filter. The scan resolves local and imported class helpers before it
// judges them, including rounded-lg `role="tab"` controls using aria-selected,
// so moving a hand-roll behind `chipCls(active)` cannot hide it.

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
type VocabularyFinding = Finding & { tokens: string[] };
type ForwardedChipBinding = Finding & { component: string };
type ForwardedChipSummary = Omit<ForwardedChipBinding, "line"> & {
  controls: number;
};

// A registered chip belongs on its native interactive element. DateRangeControl
// has one deliberate indirection: its two quick-range links may render through
// TimelineFilterLink so Timeline can preserve scroll. The binding is exact and
// the forwarding chain below is structurally pinned; a second component or a
// second class vocabulary is a new contract, not an allow-list entry to append.
const FORWARDED_CHIP_BINDINGS = [
  {
    file: "components/DateRangeControl.tsx",
    component: "LinkComponent",
    className: "chip chip-filter",
    controls: 2,
  },
] as const;

function isChipAdopter(className: string): boolean {
  const tokens = new Set(className.match(/[^\s"'`{}(),+?]+/g) ?? []);
  return (
    tokens.has("chip") && (tokens.has("chip-nav") || tokens.has("chip-filter"))
  );
}

function lineOf(source: string, at: number): number {
  return source.slice(0, at).split("\n").length;
}

function customComponentClassBindings(
  base: string,
  file: string
): ForwardedChipBinding[] {
  const source = withoutComments(read(base, file));
  const readModule = moduleReader(base, path.dirname(path.join(base, file)));
  let declared: ReturnType<typeof classDeclarations> | null = null;
  const declarations = () =>
    (declared ??= classDeclarations(source, readModule));
  const findings: ForwardedChipBinding[] = [];
  const nextLinks = new Set(
    [
      ...source.matchAll(/import\s+([A-Z][\w$]*)\s+from\s+["']next\/link["']/g),
    ].map((match) => match[1])
  );
  for (const match of source.matchAll(/<([A-Z][\w$.]*)(?=[\s>])/g)) {
    // Next's Link is the terminal interactive owner: it renders the native <a>
    // and lives outside this repository, so there is no repo-local forwarding
    // body that can append a second shell.
    if (nextLinks.has(match[1])) continue;
    const open = openingTag(source, match.index).tag;
    for (const resolved of resolveJsxClassNameBindings(open, declarations)) {
      if (!resolved.readable || !isChipAdopter(resolved.text)) continue;
      findings.push({
        file,
        line: lineOf(source, match.index),
        component: match[1],
        className: resolved.text.replace(/\s+/g, " ").trim(),
      });
    }
  }
  return findings;
}

export function scanForwardedChipBindings(
  base: string
): ForwardedChipBinding[] {
  return sourceFiles(base).flatMap((file) =>
    customComponentClassBindings(base, file)
  );
}

function bindingSummary(bindings: ForwardedChipBinding[]) {
  const summary = new Map<string, ForwardedChipSummary>();
  for (const binding of bindings) {
    const key = `${binding.file}\0${binding.component}\0${binding.className}`;
    const current = summary.get(key);
    summary.set(key, {
      file: binding.file,
      component: binding.component,
      className: binding.className,
      controls: (current?.controls ?? 0) + 1,
    });
  }
  return [...summary.values()].sort((a, b) =>
    `${a.file}:${a.component}:${a.className}`.localeCompare(
      `${b.file}:${b.component}:${b.className}`
    )
  );
}

function tagClassExpressions(source: string, tag: string) {
  const expressions: { literal: boolean; text: string }[] = [];
  const pattern = new RegExp(`<${tag}(?=[\\s>])`, "g");
  for (const match of source.matchAll(pattern)) {
    const expression = classNameExpression(openingTag(source, match.index).tag);
    if (expression) expressions.push(expression);
  }
  return expressions;
}

function isHandRolledSelectedClass(control: {
  className: string;
  selectedAttribute?: "pressed" | "current" | "selected";
}): boolean {
  const { className } = control;
  if (/\bchip chip-(?:nav|filter)\b/.test(className)) return false;
  if (/\bw-full\b/.test(className)) return false;
  return (
    (/rounded-(?:full|md)(?![\w-])/.test(className) ||
      (control.selectedAttribute === "selected" &&
        /rounded-lg(?![\w-])/.test(className))) &&
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
      if (isHandRolledSelectedClass(control))
        findings.push({
          file,
          line: control.line,
          className: control.className,
        });
    }
  }
  return { findings, unreadable: [...unreadable].sort() };
}

export function scanUnapprovedChipVocabularyCorpus(
  base: string
): VocabularyFinding[] {
  const findings: VocabularyFinding[] = [];
  for (const file of sourceFiles(base)) {
    const source = withoutComments(read(base, file));
    const readModule = moduleReader(base, path.dirname(path.join(base, file)));
    let declared: ReturnType<typeof classDeclarations> | null = null;
    const declarations = () =>
      (declared ??= classDeclarations(source, readModule));
    for (const match of source.matchAll(/<([a-z][\w-]*)(?=[\s>])/g)) {
      const open = openingTag(source, match.index).tag;
      const interactive =
        ["button", "a", "select", "textarea", "input", "summary"].includes(
          match[1]
        ) ||
        /(?<![\w-])onClick\s*=/.test(open) ||
        /role\s*=\s*"(button|tab|switch|menuitem|menuitemcheckbox|menuitemradio|option|checkbox|radio|link)"/.test(
          open
        );
      if (!interactive) continue;
      for (const resolved of resolveJsxClassNameBindings(open, declarations)) {
        if (!resolved.readable || !isChipAdopter(resolved.text)) continue;
        const className = resolved.text.replace(/\s+/g, " ").trim();
        if (isApprovedChipAdopterClass(className)) continue;
        const tokens = unapprovedChipAdopterTokens(className);
        findings.push({
          file,
          line: lineOf(source, match.index),
          className,
          tokens,
        });
      }
    }
  }
  return findings;
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
      fs.writeFileSync(
        path.join(base, "components/TabOffender.tsx"),
        'export function TabOffender({ on }: { on: boolean }) { return <button role="tab" aria-selected={on} className={`rounded-lg px-3 py-1.5 ${on ? "bg-brand-600" : "bg-slate-100"}`}>x</button>; }\n'
      );
      expect(scanSelectedStateCorpus(base).findings).toMatchObject([
        { file: "components/Offender.tsx", line: 2 },
        { file: "components/TabOffender.tsx", line: 1 },
      ]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects every token outside the exact adopter vocabulary, directly or through imports", () => {
    expect(scanUnapprovedChipVocabularyCorpus(REPO)).toEqual([]);

    const base = makeTmpDir("chip-vocabulary-census");
    try {
      fs.mkdirSync(path.join(base, "components"), { recursive: true });
      fs.mkdirSync(path.join(base, "lib"), { recursive: true });
      fs.writeFileSync(
        path.join(base, "lib/chips.ts"),
        'export const BASE = "chip chip-filter chip-sm";\nexport const EXTRA = "outline-2 outline-dashed outline-rose-500 pointer-coarse:h-8 [min-height:2rem]";\n'
      );
      fs.writeFileSync(
        path.join(base, "components/DirectOffender.tsx"),
        'export function DirectOffender() { return <button aria-pressed className="chip chip-filter chip-sm outline-2 outline-dashed outline-rose-500 pointer-coarse:h-8 [min-height:2rem]">x</button>; }\n'
      );
      fs.writeFileSync(
        path.join(base, "components/ImportedOffender.tsx"),
        'import { BASE, EXTRA } from "@/lib/chips";\nexport function ImportedOffender() { return <button aria-pressed className={`${BASE} ${EXTRA}`}>x</button>; }\n'
      );
      fs.writeFileSync(
        path.join(base, "components/SpreadOffender.tsx"),
        'export function SpreadOffender() { return <button {...{ className: "chip chip-filter min-h-0! h-4 outline-2", children: "Adversarial" }} />; }\n'
      );
      fs.writeFileSync(
        path.join(base, "components/SpreadFlowOffender.tsx"),
        'const BAD = { className: "chip chip-filter min-h-0! h-4 outline-2" };\nconst withClass = (className: string) => ({ className });\nexport function SpreadFlowOffender({ enabled, maybe }: { enabled: boolean; maybe: { className?: string } | null }) { return <>\n<button {...withClass("chip chip-filter min-h-0! h-4 outline-2")} />\n<button {...(enabled ? BAD : {})} />\n<button {...(maybe || BAD)} />\n</>; }\n'
      );
      const expectedTokens = [
        "outline-2",
        "outline-dashed",
        "outline-rose-500",
        "pointer-coarse:h-8",
        "[min-height:2rem]",
      ];
      expect(scanUnapprovedChipVocabularyCorpus(base)).toMatchObject([
        {
          file: "components/DirectOffender.tsx",
          line: 1,
          tokens: expectedTokens,
        },
        {
          file: "components/ImportedOffender.tsx",
          line: 2,
          tokens: expectedTokens,
        },
        {
          file: "components/SpreadFlowOffender.tsx",
          line: 4,
          tokens: ["min-h-0!", "h-4", "outline-2"],
        },
        {
          file: "components/SpreadFlowOffender.tsx",
          line: 5,
          tokens: ["min-h-0!", "h-4", "outline-2"],
        },
        {
          file: "components/SpreadFlowOffender.tsx",
          line: 6,
          tokens: ["min-h-0!", "h-4", "outline-2"],
        },
        {
          file: "components/SpreadOffender.tsx",
          line: 1,
          tokens: ["min-h-0!", "h-4", "outline-2"],
        },
      ]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps registered chip classes on native controls or one pinned forwarding seam", () => {
    const forwarded = scanForwardedChipBindings(REPO);
    expect(
      bindingSummary(forwarded),
      "a custom component receiving a registered chip class owns an unreadable shell boundary; only the structurally pinned DateRange link seam may do that"
    ).toEqual(FORWARDED_CHIP_BINDINGS);
    for (const binding of forwarded) {
      expect(
        isApprovedChipAdopterClass(binding.className),
        `${binding.file}:${binding.line} forwards an unapproved chip class through <${binding.component}>`
      ).toBe(true);
    }

    const dateRange = read(REPO, "components/DateRangeControl.tsx");
    expect(tagClassExpressions(dateRange, "LinkComponent")).toEqual([
      { literal: false, text: "RANGE_PILL" },
      { literal: false, text: "RANGE_PILL" },
    ]);
    expect(tagClassExpressions(dateRange, "Link")).toEqual([
      { literal: false, text: "className" },
      {
        literal: true,
        text: "btn-ghost w-full py-1.5 text-center sm:py-2",
      },
    ]);
    expect(tagClassExpressions(dateRange, "CustomRangeToggle")).toEqual([]);

    const customRange = read(REPO, "components/CustomRangeDisclosure.tsx");
    expect(tagClassExpressions(customRange, "button")).toEqual([
      { literal: true, text: "sm:hidden chip chip-filter" },
    ]);
    expect(customRange).not.toMatch(/\bclassName\s*:\s*string/);

    expect(
      tagClassExpressions(
        read(REPO, "components/TimelineFilterLink.tsx"),
        "PendingLink"
      )
    ).toEqual([{ literal: false, text: "className" }]);
    expect(
      tagClassExpressions(read(REPO, "components/PendingLink.tsx"), "Link")
    ).toEqual([{ literal: false, text: "className" }]);

    const base = makeTmpDir("forwarded-chip-census");
    try {
      fs.mkdirSync(path.join(base, "components"), { recursive: true });
      fs.writeFileSync(
        path.join(base, "components/ForwardedChip.tsx"),
        "export function ForwardedChip({ className }: { className: string }) { return <button aria-current className={`${className} min-h-0! h-4 outline-2`}>x</button>; }\n"
      );
      fs.writeFileSync(
        path.join(base, "components/Caller.tsx"),
        'import { ForwardedChip } from "./ForwardedChip";\nimport SubmitButton from "./SubmitButton";\nconst className = "an unrelated local must not rewrite an object key";\nconst IDENTIFIER_PROPS = { className: "chip chip-filter min-h-0! h-4 outline-2", children: "Identifier" };\nconst helperProps = () => ({ className: "chip chip-filter min-h-0! h-4 outline-2", children: "Helper" });\nconst withClass = (className: string) => ({ className });\nconst enabled = true;\nconst CONDITIONAL_PROPS = enabled ? IDENTIFIER_PROPS : {};\nconst LOGICAL_PROPS = null || IDENTIFIER_PROPS;\nexport function Caller() { return <>\n<ForwardedChip className="chip chip-filter" />\n<SubmitButton {...{ className: "chip chip-filter min-h-0! h-4 outline-2", children: "Adversarial" }} />\n<SubmitButton {...IDENTIFIER_PROPS} />\n<SubmitButton {...helperProps()} />\n<SubmitButton {...withClass("chip chip-filter min-h-0! h-4 outline-2")} />\n<SubmitButton {...CONDITIONAL_PROPS} />\n<SubmitButton {...LOGICAL_PROPS} />\n</>; }\n'
      );
      expect(bindingSummary(scanForwardedChipBindings(base))).toEqual([
        {
          file: "components/Caller.tsx",
          component: "ForwardedChip",
          className: "chip chip-filter",
          controls: 1,
        },
        {
          file: "components/Caller.tsx",
          component: "SubmitButton",
          className: "chip chip-filter min-h-0! h-4 outline-2",
          controls: 6,
        },
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

  it("uses complete button semantics for every audited photo selector", () => {
    const segmented = read(REPO, "components/SegmentedControl.tsx");
    expect(
      segmented,
      "each segment must render its own disjoint 44px target"
    ).toMatch(/segmentClass\s*=\s*`[^`]*\bmin-h-11\b/);
    expect(
      segmented.match(/className=\{segmentClass\}/g),
      "both the Link and button bindings must consume the one guarded segment class"
    ).toHaveLength(2);
    expect(segmented.match(/data-segmented-option=""/g)).toHaveLength(2);

    const viewFiles = [
      "app/(app)/progress/ProgressPhotosView.tsx",
      "app/(app)/records/specialty/skin/LesionPhotoStrip.tsx",
      "components/illness/SymptomPhotoStrip.tsx",
      "components/photo/PhotoGallery.tsx",
    ];
    for (const file of viewFiles) {
      const source = read(REPO, file);
      expect(
        source,
        `${file} must use the shared small-view control`
      ).toContain("<SegmentedControl");
      expect(
        source,
        `${file} must not expose incomplete tab semantics`
      ).not.toMatch(/role="tab(?:list)?"|aria-selected/);
    }

    const gallery = read(REPO, "components/photo/PhotoGallery.tsx");
    expect(
      gallery,
      "series narrowing remains an in-place chip filter"
    ).toContain("aria-pressed={series === s.key}");
    expect(gallery).toContain('className="chip chip-filter chip-sm"');
  });
});

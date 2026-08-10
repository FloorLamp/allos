import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the page-width convention (issue #794 cluster 9b), in the
// repo's established source-scan idiom (`notes-text.test.ts`,
// `chart-scaffold-scan.test.ts`): read the app's own TSX as TEXT — no DB, no
// network, so it stays "pure" — and fail the build when a page hand-writes the
// width `<PageContainer>` owns.
//
// WHY THIS EXISTS. `components/PageContainer.tsx` was introduced so a detail
// page and a form page could not drift to different measures, but nothing
// checked. Pages kept self-capping (`mx-auto max-w-6xl` on onboarding, sleep,
// longevity, the share surfaces), and two Trends detail pages did something
// subtler — they rendered `<PageContainer>` and then passed `max-w-6xl` through
// its `className`, routing around the component's own prop.
//
// THE RULE, in one sentence: a className that both CENTERS (`mx-auto`) and CAPS
// (`max-w-*`) is a page width policy, and page width comes from
// `<PageContainer width>` — never from a literal on the page, and never through
// PageContainer's `className`.
//
// The vocabulary is not restated here: WIDTHS is read straight out of
// PageContainer.tsx, so adding a named width there teaches this guard about it
// with no second list to keep in sync (the same one-computation stance
// nav-routes.test.ts takes when it reads Nav.tsx's hrefs).
//
// SCOPE. `page.tsx` and `layout.tsx` — the route files that own a page's content
// width. Deliberately NOT the whole tree: an inner `max-w-2xl` on a paragraph or
// a `max-w-56` on a thumbnail is a content measure, not a page measure, and
// a rule that flagged those would be an allowlist wearing a guard's clothes.
// `error.tsx` / `not-found.tsx` are out for the same reason — they render a
// centered fallback CARD, with no page beneath it.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PAGE_CONTAINER = "components/PageContainer.tsx";

/** Route files that own a page's content width. */
const ROOT_FILES = new Set(["page.tsx", "layout.tsx"]);

/**
 * Pages that legitimately own a width literal. Keyed by file, with the reason.
 * One entry, and it is the reason PageContainer's own doc comment exists.
 */
const PAGE_WIDTH_EXCEPTIONS = new Map<string, string>([
  [
    "app/(app)/layout.tsx",
    "the app SHELL's own 110rem content cap — the outer measure every " +
      "PageContainer width sits inside, and the one place page width is " +
      "deliberately owned outside PageContainer (see its doc comment)",
  ],
]);

/** A Tailwind width cap, including arbitrary values and breakpoint prefixes. */
const MAX_W = /(?:^|[\s:])max-w-[[\w./-]/;
/** The centering half of a page width policy. */
const CENTERED = /(?:^|\s)mx-auto(?:\s|$)/;

/** True when a className is a page width POLICY: it centers AND it caps. */
export function isPageWidthPolicy(className: string): boolean {
  return CENTERED.test(className) && MAX_W.test(className);
}

/**
 * Every className literal in a source file, as `{ value, line }`. Covers the
 * three shapes the app writes: `className="…"`, `className={"…"}` and
 * ``className={`…`}`` (the template's interpolations are irrelevant — a width
 * token is never computed).
 */
export function classNames(text: string): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];
  const re =
    /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
    out.push({ value, line: text.slice(0, m.index).split("\n").length });
  }
  return out;
}

/**
 * The className passed to each `<PageContainer …>` opening tag in a file. The
 * tag is matched up to its first `>` at depth 0 so a multi-line tag with JSX
 * expression props is still read whole.
 */
export function pageContainerClassNames(
  text: string
): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];
  const re = /<PageContainer\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    const tag = text.slice(m.index, end);
    const line = text.slice(0, m.index).split("\n").length;
    for (const cn of classNames(tag)) out.push({ value: cn.value, line });
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function rel(full: string): string {
  return path.relative(REPO, full).split(path.sep).join("/");
}

/** The route ROOT files: app/**\/page.tsx and app/**\/layout.tsx. */
function routeRootFiles(): { rel: string; text: string }[] {
  return walk(path.join(REPO, "app"))
    .filter((f) => ROOT_FILES.has(path.basename(f)))
    .map((f) => ({ rel: rel(f), text: fs.readFileSync(f, "utf8") }));
}

/** Every .tsx that renders a PageContainer. */
function pageContainerCallers(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const d of ["app", "components"]) {
    for (const full of walk(path.join(REPO, d))) {
      if (!full.endsWith(".tsx")) continue;
      const r = rel(full);
      if (r === PAGE_CONTAINER) continue;
      const text = fs.readFileSync(full, "utf8");
      if (text.includes("<PageContainer")) out.push({ rel: r, text });
    }
  }
  return out;
}

/** PageContainer's named widths, read out of the component itself. */
export function namedWidths(): Map<string, string> {
  const src = fs.readFileSync(path.join(REPO, PAGE_CONTAINER), "utf8");
  const block = src.match(/const WIDTHS = \{([\s\S]*?)\} as const;/);
  if (!block) throw new Error("PageContainer's WIDTHS map is unreadable");
  const widths = new Map<string, string>();
  for (const m of block[1].matchAll(/(\w+):\s*"([^"]*)"/g)) {
    widths.set(m[1], m[2]);
  }
  return widths;
}

function widthVocabulary(): string {
  return [...namedWidths()]
    .map(([name, cls]) => `width="${name}" (${cls || "no cap"})`)
    .join(", ");
}

describe("page width convention (issue #794 cluster 9b)", () => {
  it("recognizes a page width policy but not a content measure", () => {
    expect(isPageWidthPolicy("mx-auto max-w-6xl")).toBe(true);
    expect(isPageWidthPolicy("mx-auto w-full max-w-6xl")).toBe(true);
    expect(isPageWidthPolicy("mx-auto min-h-screen max-w-3xl px-4 py-10")).toBe(
      true
    );
    expect(isPageWidthPolicy("mx-auto 3xl:max-w-[110rem]")).toBe(true);
    // Caps that do not center are content measures, not page measures.
    expect(isPageWidthPolicy("max-w-2xl rounded-xl border p-6")).toBe(false);
    expect(isPageWidthPolicy("grid max-w-3xl gap-6")).toBe(false);
    // Centering without a cap is just centering.
    expect(isPageWidthPolicy("mx-auto space-y-4 md:space-y-6")).toBe(false);
    // A near-miss token must not read as a cap.
    expect(isPageWidthPolicy("mx-auto max-width")).toBe(false);
  });

  it("extracts className literals in every shape the app writes", () => {
    expect(classNames('<div className="a b" />').map((c) => c.value)).toEqual([
      "a b",
    ]);
    expect(classNames("<div className={`a b`} />").map((c) => c.value)).toEqual(
      ["a b"]
    );
    expect(
      pageContainerClassNames(
        '<PageContainer\n  width="wide"\n  className="mx-auto"\n  data-testid={id}\n>'
      ).map((c) => c.value)
    ).toEqual(["mx-auto"]);
    // A className on a child element is not the container's.
    expect(
      pageContainerClassNames(
        '<PageContainer width="wide">\n  <div className="max-w-3xl" />'
      )
    ).toEqual([]);
  });

  it("no page or layout hand-writes its own width cap", () => {
    const offenders: string[] = [];
    for (const { rel: r, text } of routeRootFiles()) {
      if (PAGE_WIDTH_EXCEPTIONS.has(r)) continue;
      for (const { value, line } of classNames(text)) {
        if (isPageWidthPolicy(value))
          offenders.push(`${r}:${line} — "${value}"`);
      }
    }
    expect(
      offenders,
      "These center-and-cap their own content, which is the width policy " +
        `<PageContainer> owns. Use one of its named widths — ${widthVocabulary()} ` +
        "— and pass the rest (mx-auto, spacing) through className; register a " +
        "genuine one-off in PAGE_WIDTH_EXCEPTIONS with the reason:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("no caller launders a width through PageContainer's className", () => {
    const offenders: string[] = [];
    for (const { rel: r, text } of pageContainerCallers()) {
      for (const { value, line } of pageContainerClassNames(text)) {
        if (MAX_W.test(value)) offenders.push(`${r}:${line} — "${value}"`);
      }
    }
    expect(
      offenders,
      "These render <PageContainer> and then pass a max-w-* through its " +
        `className, routing around its own width prop. Use ${widthVocabulary()} ` +
        "instead:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("every registered exception still holds a width literal", () => {
    const stale: string[] = [];
    for (const r of PAGE_WIDTH_EXCEPTIONS.keys()) {
      const full = path.join(REPO, r);
      const held =
        fs.existsSync(full) &&
        classNames(fs.readFileSync(full, "utf8")).some((c) =>
          isPageWidthPolicy(c.value)
        );
      if (!held) stale.push(r);
    }
    expect(
      stale,
      `PAGE_WIDTH_EXCEPTIONS entries with nothing left to excuse — delete them ` +
        `so the allowlist keeps meaning what it says:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("the scan is not vacuous — PageContainer names widths and pages use them", () => {
    const widths = namedWidths();
    expect(widths.get("full")).toBe("");
    expect(widths.size).toBeGreaterThan(3);
    // Every named cap must be a real Tailwind max-w utility.
    for (const [name, cls] of widths) {
      if (name === "full") continue;
      expect(cls, `WIDTHS.${name}`).toMatch(/^max-w-/);
    }
    // And the route tree must actually consume them, or the guard above would
    // be protecting a component nobody renders.
    const users = routeRootFiles().filter((f) =>
      f.text.includes("<PageContainer")
    );
    expect(users.length).toBeGreaterThan(10);
  });
});

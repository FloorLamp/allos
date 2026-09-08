import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Route width ownership (#794, #3253): pages choose a PageContainer measure
// themselves or inherit one from a layout. Centered width caps belong there,
// except for the app shell. Content caps and fallback cards are outside scope.
// PageContainer requires width by type; ESLint rejects className overrides.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Route files that own a page's content width. */
const ROOT_FILES = new Set(["page.tsx", "layout.tsx"]);

// Existing pages without PageContainer in their route or ancestor layouts.
// New undeclared pages and stale entries fail; adopting one is a layout decision.
const UNDECLARED_PAGE_WIDTHS = new Set<string>([
  "app/(app)/appointments/page.tsx",
  "app/(app)/household/page.tsx",
  "app/(app)/immunizations/[vaccine]/page.tsx",
  "app/(app)/immunizations/print/page.tsx",
  "app/(app)/import/[id]/page.tsx",
  "app/(app)/integrations/fitbit-takeout/page.tsx",
  "app/(app)/integrations/page.tsx",
  "app/(app)/medications/print/page.tsx",
  "app/(app)/nutrition/page.tsx",
  "app/(app)/profile/page.tsx",
  "app/(app)/settings/audit/page.tsx",
  "app/(app)/settings/errors/page.tsx",
  "app/(app)/settings/family/page.tsx",
  "app/(app)/settings/logs/page.tsx",
  "app/(app)/settings/notify-log/page.tsx",
  "app/(app)/trends/page.tsx",
  "app/(app)/upcoming/page.tsx",
  "app/(auth)/forgot-password/page.tsx",
  "app/(auth)/login/page.tsx",
  "app/(auth)/set-password/page.tsx",
]);

const PAGE_WIDTH_EXCEPTIONS = new Set(["app/(app)/layout.tsx"]);

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

/**
 * The route layouts that wrap `rel`, nearest first. A layout's width covers every
 * page beneath it, which is how the whole /records and /results subtrees declare
 * theirs in one place.
 */
export function ancestorLayouts(rel: string): string[] {
  const out: string[] = [];
  let dir = path.posix.dirname(rel);
  for (;;) {
    out.push(`${dir}/layout.tsx`);
    if (dir === "app") return out;
    const parent = path.posix.dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/** Whether a page-level route declares a width — itself, or through a layout. */
function declaresWidth(rel: string): boolean {
  const declares = (file: string) => {
    const abs = path.join(REPO, file);
    return (
      fs.existsSync(abs) &&
      fs.readFileSync(abs, "utf8").includes("<PageContainer")
    );
  };
  return declares(rel) || ancestorLayouts(rel).some(declares);
}

/** The route ROOT files: app/**\/page.tsx and app/**\/layout.tsx. */
function routeRootFiles(): { rel: string; text: string }[] {
  return walk(path.join(REPO, "app"))
    .filter((f) => ROOT_FILES.has(path.basename(f)))
    .map((f) => ({ rel: rel(f), text: fs.readFileSync(f, "utf8") }));
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
        "<PageContainer> owns. Choose its width prop " +
        "— and pass the rest (mx-auto, spacing) through className; register a " +
        "genuine one-off in PAGE_WIDTH_EXCEPTIONS with the reason:\n" +
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

  it("every page-level route declares a width (#3253)", () => {
    const offenders: string[] = [];
    for (const { rel: r } of routeRootFiles()) {
      if (path.basename(r) !== "page.tsx") continue;
      if (UNDECLARED_PAGE_WIDTHS.has(r)) continue;
      if (!declaresWidth(r)) offenders.push(r);
    }
    expect(
      offenders,
      "These page-level routes declare no content width, so they inherit the " +
        "app shell's 110rem and their measure is whatever the monitor is. Wrap " +
        "the page in <PageContainer> with an explicit width prop — " +
        'width="full" is a real answer, it just has to be said:\n' +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the undeclared-width list only shrinks — no stale entries", () => {
    const stale: string[] = [];
    for (const r of UNDECLARED_PAGE_WIDTHS) {
      if (!fs.existsSync(path.join(REPO, r))) {
        stale.push(`${r} — the route is gone`);
      } else if (declaresWidth(r)) {
        stale.push(`${r} — it declares a width now`);
      }
    }
    expect(
      stale,
      "UNDECLARED_PAGE_WIDTHS is a ratchet: an entry that has since declared a " +
        "width (or been deleted) must come off the list, or the list stops " +
        `meaning what it says:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("a page covered only by an ancestor layout's width counts as declared", () => {
    // /records and /results cap their whole subtree from one layout; without this
    // the ratchet above would have had to name ten pages that are already capped.
    expect(
      ancestorLayouts("app/(app)/records/history/visits/page.tsx")
    ).toEqual([
      "app/(app)/records/history/visits/layout.tsx",
      "app/(app)/records/history/layout.tsx",
      "app/(app)/records/layout.tsx",
      "app/(app)/layout.tsx",
      "app/layout.tsx",
    ]);
    expect(declaresWidth("app/(app)/records/history/visits/page.tsx")).toBe(
      true
    );
    // And the shell's own hand-written cap does NOT count as a declaration, or
    // every page in the app would pass for free.
    expect(
      fs
        .readFileSync(path.join(REPO, "app/(app)/layout.tsx"), "utf8")
        .includes("<PageContainer")
    ).toBe(false);
  });

  it("the declaration check can SEE an undeclared page, and the dashboard's cap", () => {
    // One real route in each state proves the declaration check is active.
    expect(declaresWidth("app/(app)/upcoming/page.tsx")).toBe(false);
    expect(declaresWidth("app/(app)/page.tsx")).toBe(true);
    expect(UNDECLARED_PAGE_WIDTHS.has("app/(app)/page.tsx")).toBe(false);
  });
});

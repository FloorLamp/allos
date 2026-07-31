import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the typed-internal-route convention (issue #285), in the
// repo's established source-scan idiom (`nav-routes.test.ts`,
// `notes-text.test.ts`, `telegram-chokepoint.test.ts`): read the app's own
// source as TEXT — no DB, no network, so it stays "pure" — and fail the build
// when an href-carrying field is typed `string` instead of `AppRoute`.
//
// WHY THIS EXISTS. #285 made the compiler the dead-link check: `AppRoute`
// (lib/hrefs.ts) resolves to Next's generated `Route`, so a consolidated-away
// page is a build error wherever its pathname is stored. That only holds while
// every href-carrying field IS `AppRoute` — and nothing checked. It drifted at
// exactly the seam #285 warned about: the query layer produced
// `RecentSessionSummary.href: AppRoute`, then the component that rendered it
// declared `recent[].href: string` and the guarantee stopped at the prop
// boundary. `nav-routes.test.ts` never sees this — it scans Nav.tsx literals
// against the route tree, not type annotations.
//
// THE RULE. A declaration whose name is `href`/`…Href`/`hrefs`/`…Hrefs` and
// whose type is string-shaped (`string`, `string | null`, `string[]`,
// `ReadonlySet<string>`, …) must instead be `AppRoute` — or carry an entry in
// EXTERNAL_OR_RUNTIME_HREFS below with the reason it genuinely holds something
// other than an internal app route.
//
// SCOPE, honestly stated. The scanner keys on the app's `href` NAMING
// convention, which is what makes it cheap and precise; a route smuggled into a
// field called something else is out of its reach. That is the trade #285
// already made — helpers and field names are the enforcement surface, not a
// value-flow analysis.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Where href-carrying models, props, and helpers live. */
const SCAN_DIRS = ["app", "components", "lib"];

/**
 * The declarations that legitimately hold a `string` under an href-ish name.
 * Keyed `<file>:<identifier>` — deliberately NOT by line number, so an unrelated
 * edit above never invalidates an entry, and a NEW href field in the same file
 * still fails. Every entry states what non-route thing the value is.
 */
const EXTERNAL_OR_RUNTIME_HREFS = new Map<string, string>([
  [
    "lib/hrefs.ts:href",
    "currentPathHref's parameter — the documented escape hatch whose whole job " +
      "is to take a LIVE usePathname() string (a real route at runtime, only a " +
      "string to the compiler) and widen it to AppRoute in one auditable place",
  ],
  [
    "lib/maps-link.ts:href",
    "MapsLink.href is an EXTERNAL maps-provider deep link (google.com/maps, " +
      "maps.apple.com, geo:) — never an app route, so AppRoute would be wrong",
  ],
  [
    "lib/nav.ts:href",
    "isRouteActive / isNavLeafVisible are path-SHAPE predicates: one side is a " +
      "live usePathname() value and the fixtures exercise historical paths, so " +
      "the parameters are plain strings. The destinations they are fed in " +
      "production are AppRoute at their source (Nav's entries)",
  ],
  [
    "lib/nav.ts:childHrefs",
    "isGroupActive's argument — the same path-shape predicate over a group's " +
      "child paths (see lib/nav.ts:href)",
  ],
  [
    "lib/nav.ts:restrictedHrefs",
    "the age-gate lookup set isNavLeafVisible probes with a leaf path; a Set " +
      "membership test over path shapes, not a link destination",
  ],
]);

/**
 * An href-ish DECLARATION: a name ending in href/hrefs (any case for the first
 * letter of that suffix, so `href`, `actionHref`, `childHrefs` all match)
 * followed by a type annotation. The `\??` admits optional members/params, and
 * the look-behind stops the name from matching the tail of a longer identifier.
 */
const HREF_DECLARATION =
  /(?<![\w$."'`])((?:[A-Za-z_$][\w$]*)?[Hh]refs?)\s*\??\s*:\s*/;

/**
 * The annotation itself, cut out of the rest of the line at the first `;`, `,`
 * or `)` that is not nested inside `<>`, `()`, `[]` or `{}`. That is what keeps
 * a parameter's annotation (`childHrefs: string[], pathname: string): boolean`)
 * from swallowing its neighbours and its return type, while leaving a generic's
 * own commas alone (`Record<string, string>`).
 */
function cutAnnotation(rest: string): string {
  const OPEN: Record<string, string> = {
    "<": ">",
    "(": ")",
    "[": "]",
    "{": "}",
  };
  const stack: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (stack.length === 0 && (c === ";" || c === "," || c === ")")) {
      return rest.slice(0, i).trim();
    }
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (stack.length > 0 && c === stack[stack.length - 1]) stack.pop();
  }
  return rest.trim();
}

/**
 * Every href-ish declaration on a line, with its annotation. Value positions in
 * object literals (`href: someHelper(id)`, `href: "/x"`) match too and fall out
 * in isStringShaped below, which is why no JSX/AST parsing is needed.
 */
function hrefDeclarations(line: string): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = [];
  const re = new RegExp(HREF_DECLARATION.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push({ name: m[1], type: cutAnnotation(line.slice(re.lastIndex)) });
  }
  return out;
}

/**
 * True when an annotation is `string` under any number of the wrappers the repo
 * actually uses for href collections/nullability. Everything else — `AppRoute`,
 * `Route<…>`, a union with a literal, or a VALUE that merely followed a colon —
 * is not our business.
 */
export function isStringShaped(annotation: string): boolean {
  let t = annotation.trim();
  // Peel nullability, then collection wrappers, until nothing changes.
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(/\|\s*(null|undefined)\b/g, "").trim();
    t = t.replace(/^(null|undefined)\s*\|/g, "").trim();
    t = t.replace(/^readonly\s+/, "").trim();
    t = t.replace(/\[\]$/, "").trim();
    const wrapped = t.match(
      /^(?:Readonly(?:Set|Array)|Set|Array|Iterable)<([\s\S]*)>$/
    );
    if (wrapped) t = wrapped[1].trim();
    if (t === before) break;
  }
  return t === "string";
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so prose about `href: string` (this file's own siblings, the
 *  lib/hrefs.ts header) can't trip the scanner — only real code counts. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (/__tests__|__db_tests__|__action_tests__|\.test\.tsx?$/.test(rel)) {
        continue;
      }
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

/** Every string-shaped href declaration in the app, as `<file>:<identifier>`. */
function stringTypedHrefs(): { key: string; where: string }[] {
  const hits: { key: string; where: string }[] = [];
  for (const { rel, text } of sourceFiles()) {
    stripComments(text)
      .split("\n")
      .forEach((line, i) => {
        for (const { name, type } of hrefDeclarations(line)) {
          if (!isStringShaped(type)) continue;
          hits.push({ key: `${rel}:${name}`, where: `${rel}:${i + 1}` });
        }
      });
  }
  return hits;
}

/** Href declarations that ARE AppRoute — the non-vacuity signal for the scan. */
function appRouteHrefCount(): number {
  let n = 0;
  for (const { text } of sourceFiles()) {
    stripComments(text)
      .split("\n")
      .forEach((line) => {
        for (const { type } of hrefDeclarations(line)) {
          if (/^AppRoute\b/.test(type.trim())) n++;
        }
      });
  }
  return n;
}

describe("typed internal-route props (issue #285)", () => {
  it("classifies the annotation shapes the app actually writes", () => {
    expect(isStringShaped("string")).toBe(true);
    expect(isStringShaped("string | null")).toBe(true);
    expect(isStringShaped("string | undefined")).toBe(true);
    expect(isStringShaped("string[]")).toBe(true);
    expect(isStringShaped("readonly string[]")).toBe(true);
    expect(isStringShaped("ReadonlySet<string>")).toBe(true);
    expect(isStringShaped("AppRoute")).toBe(false);
    expect(isStringShaped("AppRoute | null")).toBe(false);
    expect(isStringShaped("Route<`/import/${number}`>")).toBe(false);
    // A VALUE that merely follows a colon is not an annotation.
    expect(isStringShaped('"/training"')).toBe(false);
    expect(isStringShaped("journalActivityHref(id)")).toBe(false);
  });

  it("finds href declarations under every name shape the app uses", () => {
    expect(hrefDeclarations("  href?: string;")).toEqual([
      { name: "href", type: "string" },
    ]);
    expect(hrefDeclarations("  householdHref: AppRoute;")).toEqual([
      { name: "householdHref", type: "AppRoute" },
    ]);
    // A parameter list: the annotation stops before the next parameter and
    // before the return type.
    expect(
      hrefDeclarations("function f(childHrefs: string[], p: string): boolean {")
    ).toEqual([{ name: "childHrefs", type: "string[]" }]);
    expect(
      hrefDeclarations(
        "export function currentPathHref(href: string): AppRoute {"
      )
    ).toEqual([{ name: "href", type: "string" }]);
    // A generic's own comma is not a terminator.
    expect(hrefDeclarations("  hrefs: Record<string, string>;")).toEqual([
      { name: "hrefs", type: "Record<string, string>" },
    ]);
    // A JSX attribute is an assignment, not a declaration.
    expect(hrefDeclarations("<Link href={x} />")).toEqual([]);
  });

  it("no href-carrying field is typed string instead of AppRoute", () => {
    const offenders = stringTypedHrefs().filter(
      (h) => !EXTERNAL_OR_RUNTIME_HREFS.has(h.key)
    );
    expect(
      offenders.map((o) => `${o.where} (${o.key})`),
      "These hold an href but are typed `string`, so a removed page stays a " +
        "silent dead link instead of a build error. Type them `AppRoute` " +
        "(lib/hrefs.ts) — widening a dynamic route through the helpers there — " +
        "or, if the value is genuinely external / a runtime pathname, register " +
        "it in EXTERNAL_OR_RUNTIME_HREFS with the reason:\n" +
        offenders.map((o) => `${o.where} (${o.key})`).join("\n")
    ).toEqual([]);
  });

  it("every registered exception still exists", () => {
    const live = new Set(stringTypedHrefs().map((h) => h.key));
    const stale = [...EXTERNAL_OR_RUNTIME_HREFS.keys()].filter(
      (k) => !live.has(k)
    );
    expect(
      stale,
      `EXTERNAL_OR_RUNTIME_HREFS entries with nothing left to excuse — delete ` +
        `them so the allowlist keeps meaning what it says:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("the scan is not vacuous — the app's href fields ARE typed AppRoute", () => {
    // If the extractor silently stopped matching, this collapses to 0 and the
    // "no offenders" assertion above would pass for the wrong reason.
    expect(appRouteHrefCount()).toBeGreaterThan(10);
  });

  it("AppRoute is still the alias the convention names", () => {
    const src = fs.readFileSync(path.join(REPO, "lib/hrefs.ts"), "utf8");
    expect(/export type AppRoute\s*=/.test(src)).toBe(true);
  });
});

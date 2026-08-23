import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments";
import { makeTmpDir } from "./tmp-dir";
import {
  DISCLOSURE_EXPANSIONS,
  DYNAMIC_ROUTES,
  HOVER_CAPTURES,
  HUB_VARIANTS,
  routeSlug,
} from "../../scripts/ux-census-routes.mjs";
import { NUTRITION_TABS } from "../hrefs";
import { TRAINING_TABS } from "../training-tabs";
import { TREND_METRIC_SLUGS } from "../trend-metrics";
import { TRENDS_TABS } from "../trends-tabs";
import { vaccineByCode } from "../immunization-catalog";

// Guard for the UX census's dynamic-route registry (#1544), in the repo's
// source-scan idiom — filesystem only, no DB, no network, so it stays pure.
//
// The census (`scripts/ux-walkthrough.mjs`, `pages` journey) enumerates
// app/(app)/**/page.tsx off the filesystem. Static routes therefore self-maintain;
// a `[param]` route cannot, because it needs an id. Before #1544 the walker just
// skipped them, so the all-pages audit covered zero detail pages and the #1510
// metrics probe recorded no detail-page rows at all.
//
// scripts/ux-census-routes.mjs closes that by naming ONE resolvable instance per
// pattern. This test is what keeps the registry honest between census runs: the
// census is a manual seeing tool that may not run for weeks, so a pattern added
// (or a literal slug renamed) in the meantime would otherwise silently un-census
// a route and nobody would notice until someone read a run's BLIND SPOT lines.
// The failures here are cheap and immediate instead.

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app", "(app)");

function walk(dir: string, route: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) {
      if (e.name === "page.tsx") out.push(route || "/");
      continue;
    }
    walk(path.join(dir, e.name), `${route}/${e.name}`, out);
  }
}

const allRoutes: string[] = [];
walk(appDir, "", allRoutes);
const dynamicRoutes = allRoutes.filter((r) => r.includes("["));
const staticRoutes = new Set(allRoutes.filter((r) => !r.includes("[")));

describe("ux census dynamic-route registry", () => {
  it("covers every dynamic app/(app) route", () => {
    const registered = new Set(DYNAMIC_ROUTES.map((d) => d.pattern));
    const missing = dynamicRoutes.filter((r) => !registered.has(r));
    expect(
      missing,
      `add a DYNAMIC_ROUTES entry in scripts/ux-census-routes.mjs, or the census cannot reach: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("registers no route that no longer exists", () => {
    const present = new Set(dynamicRoutes);
    const stale = DYNAMIC_ROUTES.map((d) => d.pattern).filter(
      (p) => !present.has(p)
    );
    expect(stale, `stale DYNAMIC_ROUTES entries: ${stale.join(", ")}`).toEqual(
      []
    );
  });

  it("gives each pattern exactly one entry", () => {
    const seen = new Set<string>();
    for (const d of DYNAMIC_ROUTES) {
      expect(seen.has(d.pattern), `duplicate entry for ${d.pattern}`).toBe(
        false
      );
      seen.add(d.pattern);
    }
  });

  it("resolves each instance to its own pattern", () => {
    for (const d of DYNAMIC_ROUTES) {
      if (d.strategy !== "literal") continue;
      // "/trends/metric/[kind]" + "/trends/metric/weight" — same shape, one
      // concrete segment where the param is.
      const patternParts = d.pattern.split("/");
      const instanceParts = d.instance!.split("/");
      expect(instanceParts.length, d.pattern).toBe(patternParts.length);
      for (const [i, part] of patternParts.entries()) {
        if (part.startsWith("[")) expect(instanceParts[i]).toBeTruthy();
        else expect(instanceParts[i]).toBe(part);
      }
    }
  });

  it("pins literal slugs to the enums they claim to come from", () => {
    const byPattern = new Map(DYNAMIC_ROUTES.map((d) => [d.pattern, d]));
    const metric = byPattern.get("/trends/metric/[kind]");
    expect(metric?.slug).toBeTruthy();
    expect(
      (TREND_METRIC_SLUGS as readonly string[]).includes(metric!.slug!),
      `${metric!.slug} is no longer a TREND_METRIC_SLUGS member`
    ).toBe(true);

    const vaccine = byPattern.get("/immunizations/[vaccine]");
    expect(vaccine?.slug).toBeTruthy();
    expect(
      vaccineByCode(vaccine!.slug!),
      `${vaccine!.slug} is no longer a vaccine catalog code`
    ).toBeDefined();
  });

  it("follows only index routes that still exist", () => {
    for (const d of DYNAMIC_ROUTES) {
      if (d.strategy !== "follow") continue;
      expect(
        d.from!.length,
        `${d.pattern} has no index candidates`
      ).toBeGreaterThan(0);
      // A candidate may carry a query (a hub's list can live on a tab), so the
      // existence check is on the pathname.
      for (const from of d.from!)
        expect(
          staticRoutes.has(from.split("?")[0]),
          `${d.pattern} follows ${from}, which is not an app/(app) route`
        ).toBe(true);
    }
  });

  it("matches a plausible detail href with each follow pattern", () => {
    for (const d of DYNAMIC_ROUTES) {
      if (d.strategy !== "follow") continue;
      const sample = d.pattern.replace(/\[[^\]]+\]/, "7");
      expect(
        d.match!.test(sample),
        `${d.pattern}: match regex rejects ${sample}`
      ).toBe(true);
      // …and does not swallow the index route it follows, which would make the
      // census screenshot the list instead of the detail page.
      for (const from of d.from!)
        expect(
          d.match!.test(from.split("?")[0]),
          `${d.pattern}: match regex accepts ${from}`
        ).toBe(false);
    }
  });

  it("keys captures by pattern, filesystem-safely", () => {
    expect(routeSlug("/")).toBe("home");
    expect(routeSlug("/medications/[id]")).toBe("medications-id");
    expect(routeSlug("/trends/metric/[kind]")).toBe("trends-metric-kind");
    const slugs = allRoutes.map(routeSlug);
    expect(new Set(slugs).size, "two routes share a capture slug").toBe(
      slugs.length
    );
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
  });
});

// #2616: the disclosure-expansion registry. The route registry stays honest here;
// the manual census itself exercises the selectors against the rendered page.
describe("ux census disclosure-expansion registry", () => {
  it("registers only live static routes, once each", () => {
    const seen = new Set<string>();
    for (const e of DISCLOSURE_EXPANSIONS) {
      expect(
        staticRoutes.has(e.route),
        `${e.route} is not an app/(app) route`
      ).toBe(true);
      expect(seen.has(e.route), `duplicate entry for ${e.route}`).toBe(false);
      seen.add(e.route);
      expect(e.label, `${e.route} has no label`).toBeTruthy();
    }
  });
});

// #3489 deliverable 4: the hover-capture registry. Same job as the disclosure
// registry above — the census is a manual seeing tool that may not run for weeks,
// so a selector that stopped matching would otherwise cost a BLIND SPOT line
// nobody reads until the next run. The failure here is cheap and immediate.
//
// AND ONE MORE THING THIS PINS THAT THE DISCLOSURE GUARD DOES NOT: the markers the
// registry names must still EXIST in the tree. A hover registry is unusually
// exposed to a silent rename, because its whole subject is a state no other
// screenshot shows: if `standing-door` is renamed, every other check in this repo
// stays green, the census keeps running, and the only symptom is a shot that
// quietly stops being taken.
// THE MARKER CORPUS AND THE VERDICT OVER IT (#3600).
//
// The verdict used to be `corpus.includes(marker)` over every `.tsx`/`.ts`/`.css`
// file under `app/` and `components/` concatenated into one string. That answers
// "does this sequence of characters occur anywhere in the app's source", which is
// not the question. Measured 2026-08-23, renaming `standing-door` in the component
// that renders it left this file 14/14 green THREE separate ways:
//
//   * `standing-door` -> `standing-doorway` — a superstring still satisfies
//     `includes`, and suffixing a marker is the ordinary shape of a rename;
//   * `standing-door` -> `family-door` with `app/globals.css` untouched — four
//     orphan `.standing-door` rules kept the dead token alive;
//   * the same rename WITH `app/globals.css` renamed too — because
//     `app/(app)/household/page.tsx:289` says "The standing-door convention is the
//     chevron (#3253)" in a JSX comment. That sentence landed after #3600 was filed
//     and closed the last direction the guard could still see.
//
// So membership is three things, and each closes one of those:
//
//   1. THE CORPUS IS MARKUP, NOT STYLE. A selector here is run against the rendered
//      DOM by `scripts/ux-walkthrough.mjs`, and only markup puts a class or a testid
//      on an element — a stylesheet rule cannot make one exist. `app/globals.css` is
//      read SEPARATELY, and never to satisfy the verdict: a marker that survives
//      only there is an orphan rule, which the failure message says out loud so the
//      reader is sent to the right file. Dropping the stylesheet from the corpus
//      entirely would have thrown that away; keeping it in the same string was what
//      let it answer a question about markup.
//   2. COMMENTS ARE BLANKED. Prose in this tree quotes the tokens it explains, and
//      a guard that reads its own documentation as evidence is the #3509 shape
//      inverted — here it does not cry wolf, it goes quiet (#3595's stripper).
//   3. THE MATCH IS ON WHAT CONSTITUTES MEMBERSHIP. A testid marker must appear as
//      the ATTRIBUTE (`data-testid="marker"`), not as a bare token; a class marker
//      must appear as a whole token with no `[\w-]` either side.
//
// A testid built by interpolation (`data-testid={`symptom-${key}`}`) cannot satisfy
// rule 3 and would red this guard. That is deliberate and it fails CLOSED: a hover
// capture whose marker no scan can pin is exactly the entry that goes quietly stale,
// and the registry should name a static one.
describe("ux census hover-capture registry", () => {
  const appRoot = path.join(here, "..", "..", "app");
  const componentsRoot = path.join(here, "..", "..", "components");

  /**
   * Every source file under the given roots, split by what it can testify to:
   * `markup` (`.tsx`/`.ts`, comments blanked) is the only thing that can put a
   * marker on an element; `style` (`.css`) can only ever style one.
   */
  const readCorpus = (
    roots: readonly string[]
  ): { markup: { file: string; source: string }[]; style: { file: string; source: string }[] } => {
    const markup: { file: string; source: string }[] = [];
    const style: { file: string; source: string }[] = [];
    const collect = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".next") continue;
          collect(full);
          continue;
        }
        if (/\.(tsx|ts)$/.test(e.name))
          markup.push({
            file: full,
            source: stripComments(fs.readFileSync(full, "utf8")),
          });
        else if (/\.css$/.test(e.name))
          style.push({ file: full, source: fs.readFileSync(full, "utf8") });
      }
    };
    for (const d of roots) collect(d);
    return { markup, style };
  };

  const { markup, style } = readCorpus([appRoot, componentsRoot]);

  /**
   * THE FLOOR THE CORPUS MUST CLEAR, asserted before the verdict below — which is a
   * PRESENCE claim per marker and therefore fails loudly on an empty corpus, but
   * only after somebody has spent an afternoon hunting a marker that never moved.
   *
   * Measured 2026-08-23 at this head: 1,054 `.tsx`/`.ts` files under `app/` (548)
   * and `components/` (506), and 1 stylesheet (`app/globals.css`). Slack on
   * purpose — retiring a section of the app should not red this guard; a walk that
   * has stopped reaching the tree should.
   */
  const MARKUP_FLOOR = 500;

  /** A marker as it must be SPELLED to count as rendered. */
  type Marker = { kind: "testid" | "class"; name: string };

  /**
   * The identifying tokens a selector depends on: testid values and class names.
   * Element names, combinators and pseudo-classes are deliberately NOT checked —
   * `tbody td` renaming is not a thing, and a check that matched on them would be
   * noise. What is checked is the part somebody can rename in one commit.
   */
  const markersIn = (selector: string): Marker[] => [
    ...[...selector.matchAll(/data-testid="([^"]+)"/g)].map(
      (m): Marker => ({ kind: "testid", name: m[1] })
    ),
    ...[...selector.matchAll(/(?:^|[\s,>+~])\.?[a-z]*\.([a-zA-Z][\w-]*)/g)].map(
      (m): Marker => ({ kind: "class", name: m[1] })
    ),
  ];

  const escape = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /**
   * How a marker must be written to count as RENDERED.
   *
   * A testid is matched as the attribute itself, in the two spellings this tree
   * uses for a static value (`data-testid="x"` — 2,213 occurrences — and
   * `data-testid={"x"}`). A class is matched as a whole token, which is what kills
   * the superstring rename: `standing-doorway` no longer answers for
   * `standing-door`.
   */
  const renderedPattern = (marker: Marker): RegExp =>
    marker.kind === "testid"
      ? new RegExp(`data-testid=(?:"${escape(marker.name)}"|\\{\\s*["']${escape(marker.name)}["']\\s*\\})`)
      : new RegExp(`(?<![\\w-])${escape(marker.name)}(?![\\w-])`);

  /** Files that put the marker on an element, by name. */
  const renderedIn = (marker: Marker): string[] =>
    markup
      .filter((f) => renderedPattern(marker).test(f.source))
      .map((f) => path.relative(path.join(here, "..", ".."), f.file));

  /** Files that merely STYLE the token — never evidence that anything renders it. */
  const styledIn = (marker: Marker): string[] =>
    style
      .filter((f) =>
        new RegExp(`(?<![\\w-])${escape(marker.name)}(?![\\w-])`).test(f.source)
      )
      .map((f) => path.relative(path.join(here, "..", ".."), f.file));

  it("registers only live static routes, once each, with a ruling named", () => {
    const seen = new Set<string>();
    for (const e of HOVER_CAPTURES) {
      expect(
        staticRoutes.has(e.route),
        `${e.route} is not an app/(app) route`
      ).toBe(true);
      expect(seen.has(e.route), `duplicate entry for ${e.route}`).toBe(false);
      seen.add(e.route);
      expect(e.label, `${e.route} has no label`).toBeTruthy();
      expect(e.target, `${e.route} has no hover target`).toBeTruthy();
      // The ruling is not decoration: a hover capture only earns its place in the
      // contact sheet if a reader can see WHY this surface's information lives on
      // hover at all. #3253 decision 2 and #3375 are the two today.
      expect(
        e.ruling,
        `${e.route} does not name the ruling it captures`
      ).toMatch(/#\d+/);
    }
  });

  it("keys each hover shot to a distinct capture slug", () => {
    const slugs = HOVER_CAPTURES.map((e) => `${routeSlug(e.route)}-hover`);
    expect(new Set(slugs).size, "two hover entries share a shot filename").toBe(
      slugs.length
    );
  });

  it("reads the corpus it is about to pronounce healthy", () => {
    expect(
      markup.length,
      `The walk read ${markup.length} markup files under app/ and components/, below ` +
        `the floor of ${MARKUP_FLOOR}. Either it has stopped reaching them (a root ` +
        "renamed, an extension filter that no longer matches) or the app really " +
        "shrank — check which before lowering this number."
    ).toBeGreaterThanOrEqual(MARKUP_FLOOR);

    // Per root, because the total clears the floor while one root has silently
    // dropped out — `app/` alone would carry it.
    for (const [name, root] of [
      ["app", appRoot],
      ["components", componentsRoot],
    ] as const)
      expect(
        markup.filter((f) => f.file.startsWith(root + path.sep)).length,
        `No markup file at all under \`${name}/\`. That root is either gone from ` +
          "the tree or gone from this walk, and the second one is silent."
      ).toBeGreaterThan(0);

    // The stylesheet half is read too — not to satisfy the verdict, but so the
    // failure message below can tell a reader that a dead token is still styled.
    expect(
      style.length,
      "No stylesheet under app/ or components/. An orphan rule could then never be " +
        "named in a failure message, and the reader would be sent hunting."
    ).toBeGreaterThan(0);
  });

  /** The orphan-rule sentence, when a dead token is still styled somewhere. */
  const orphanHint = (marker: Marker): string => {
    const styled = styledIn(marker);
    return styled.length
      ? ` It DOES still appear in ${styled.join(", ")} — an orphan rule with ` +
          "nothing rendering it, which is the half of a rename people leave " +
          "behind. That stylesheet is read separately and can never answer for " +
          "markup."
      : "";
  };

  it("names markers that are still RENDERED in the tree", () => {
    for (const e of HOVER_CAPTURES) {
      const selectors = [e.target, e.reveals, e.openFirst].filter(
        Boolean
      ) as string[];
      for (const sel of selectors) {
        const markers = markersIn(sel);
        expect(
          markers.length,
          `${e.route}: \`${sel}\` names no testid or class this guard can pin. ` +
            `A selector built only from element names cannot be checked for a ` +
            `rename, which is the failure this registry is most exposed to.`
        ).toBeGreaterThan(0);
        for (const marker of markers) {
          const rendered = renderedIn(marker);
          const hint = orphanHint(marker);
          expect(
            rendered,
            `${e.route}: \`${marker.name}\` (from \`${sel}\`) is no longer ` +
              `${marker.kind === "testid" ? 'written as `data-testid="' + marker.name + '"`' : "rendered as a class token"} ` +
              `by any markup under app/ or components/. The hover capture for ` +
              `"${e.label}" would stop being taken and only a BLIND SPOT line in a ` +
              `census run nobody has done yet would say so.${hint}`
          ).not.toEqual([]);
        }
      }
    }
  });
});

// Everything above proves the MATCH can be spelled. None of it proves the WALK can
// reach a file, or that the three holes measured on #3600 are actually closed —
// those are claims about a corpus, and the corpus this file reads is one that
// already complies. So the same reader is run over sources authored to break it.
//
// A CORPUS OF ITS OWN, never the live tree: vitest runs test files concurrently and
// several other guards walk `app/` and `components/` and read them a moment later,
// so a create-then-unlink there kills unrelated tests with ENOENT (measured on
// #3557's tap-floor census). `makeTmpDir` keeps this file out of the temp-dir
// census's findings (#3248).
describe("the hover-marker reader over a corpus authored to break it", () => {
  const base = makeTmpDir("hover-marker-corpus");

  const write = (rel: string, source: string): void => {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source, "utf8");
  };

  // A corpus with a SHAPE, so the readings below are not two empties agreeing: one
  // seed under each root, one in a SUBDIRECTORY so the walk has to recurse, and a
  // stylesheet that carries every token the markup does not.
  write(
    "app/(app)/seed/page.tsx",
    'export default function P() {\n  return <div data-testid="schedule-grid-tip" className="standing-row" />;\n}\n'
  );
  write(
    "components/dashboard/Seed.tsx",
    'export const S = () => <span data-testid={"standing-door"} className="live-class" />;\n'
  );
  // Both halves of the superstring rename: a class token that CONTAINS the marker,
  // and a testid attribute whose value does.
  write(
    "components/Superstring.tsx",
    'export const T = () => <b data-testid="schedule-grid-tips" className="standing-doorway" />;\n'
  );
  write(
    "components/Prose.tsx",
    "export const U = () => (\n  <div>\n    {/* The comment-only-marker convention is the chevron. */}\n    <span />\n  </div>\n);\n"
  );
  write(
    "app/globals.css",
    ".standing-row .css-only-marker {\n  opacity: 0;\n}\n.orphan-rule {\n  opacity: 1;\n}\n"
  );

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  // The reader under test, pointed at the planted roots. Deliberately a re-run of
  // the same walk rather than a re-implementation of the match.
  const corpus = (): {
    rendered: (kind: "testid" | "class", name: string) => string[];
    styled: (name: string) => string[];
    markupCount: number;
  } => {
    const markupFiles: string[] = [];
    const styleFiles: string[] = [];
    const collect = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          collect(full);
          continue;
        }
        if (/\.(tsx|ts)$/.test(e.name)) markupFiles.push(full);
        else if (/\.css$/.test(e.name)) styleFiles.push(full);
      }
    };
    for (const d of ["app", "components"]) collect(path.join(base, d));
    const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const token = (name: string) => new RegExp(`(?<![\\w-])${esc(name)}(?![\\w-])`);
    return {
      markupCount: markupFiles.length,
      rendered: (kind, name) =>
        markupFiles
          .filter((f) => {
            const src = stripComments(fs.readFileSync(f, "utf8"));
            return kind === "testid"
              ? new RegExp(
                  `data-testid=(?:"${esc(name)}"|\\{\\s*["']${esc(name)}["']\\s*\\})`
                ).test(src)
              : token(name).test(src);
          })
          .map((f) => path.relative(base, f)),
      styled: (name) =>
        styleFiles
          .filter((f) => token(name).test(fs.readFileSync(f, "utf8")))
          .map((f) => path.relative(base, f)),
    };
  };

  it("reads back the corpus it wrote, in both roots and into a subdirectory", () => {
    // Every reading below would be empty if the walk had stopped walking, and they
    // would all agree — which is the shape of a broken walk, not of a passing test.
    expect(corpus().markupCount).toBe(4);
    expect(corpus().rendered("testid", "schedule-grid-tip")).toEqual([
      "app/(app)/seed/page.tsx",
    ]);
    expect(corpus().rendered("testid", "standing-door")).toEqual([
      "components/dashboard/Seed.tsx",
    ]);
    expect(corpus().rendered("class", "standing-row")).toEqual([
      "app/(app)/seed/page.tsx",
    ]);
  });

  it("refuses a SUPERSTRING rename — measurement M-A on #3600", () => {
    // `standing-doorway` contains `standing-door`, and suffixing a marker is the
    // ordinary shape of a rename. Under `corpus.includes(marker)` this was green.
    expect(corpus().rendered("class", "standing-doorway")).not.toEqual([]);
    expect(
      corpus().rendered("class", "standing-door"),
      "a superstring answered for the marker: the class match has lost its token " +
        "boundary and every rename that appends is invisible again."
    ).toEqual(["components/dashboard/Seed.tsx"]);
  });

  it("refuses a marker that survives only as a STYLESHEET rule — M-B", () => {
    // Four orphan `.standing-door` rules in app/globals.css kept the dead token
    // alive for as long as the stylesheet was concatenated into the same string.
    expect(corpus().rendered("class", "css-only-marker")).toEqual([]);
    expect(corpus().rendered("class", "orphan-rule")).toEqual([]);
    // …and the stylesheet IS read, so the failure message can say where the dead
    // token still lives. Excluding it would have thrown that away.
    expect(corpus().styled("orphan-rule")).toEqual(["app/globals.css"]);
  });

  it("refuses a marker that survives only in a COMMENT — M-C", () => {
    // The direction that closed at this head: `app/(app)/household/page.tsx:289`
    // gained a JSX comment naming `standing-door` after #3600 was filed, and it made
    // the FULL rename green too.
    expect(corpus().rendered("class", "comment-only-marker")).toEqual([]);
  });

  it("refuses a testid whose value is a superstring of the marker", () => {
    // `[data-testid="schedule-grid-tip"]` -> `schedule-grid-tips` is the same M-A
    // shape on the other registered capture, and it was green too.
    expect(corpus().rendered("testid", "schedule-grid-tips")).toEqual([
      "components/Superstring.tsx",
    ]);
    expect(corpus().rendered("testid", "schedule-grid-tip")).toEqual([
      "app/(app)/seed/page.tsx",
    ]);
  });

  it("refuses a testid that is only ever a bare token, never the attribute", () => {
    // A class named `standing-doorway` is not `data-testid="standing-doorway"`, and
    // a registry entry that names a testid is claiming the attribute.
    expect(corpus().rendered("testid", "standing-doorway")).toEqual([]);
    expect(corpus().rendered("class", "standing-doorway")).toEqual([
      "components/Superstring.tsx",
    ]);
  });

  it("accepts the `{\"x\"}` spelling of a static testid", () => {
    // 575 of this tree's testids are written `data-testid={…}`. A static one in
    // braces is the same claim as a quoted one and must not read as a rename.
    expect(corpus().rendered("testid", "standing-door")).toEqual([
      "components/dashboard/Seed.tsx",
    ]);
  });
});

describe("ux census hub variants", () => {
  it("registers live hubs with unique targets and slugs", () => {
    expect(new Set(HUB_VARIANTS.map((entry) => entry.target)).size).toBe(
      HUB_VARIANTS.length
    );
    expect(new Set(HUB_VARIANTS.map((entry) => entry.slug)).size).toBe(
      HUB_VARIANTS.length
    );
    for (const entry of HUB_VARIANTS) {
      expect(staticRoutes.has(entry.route), entry.route).toBe(true);
      expect(entry.target).toMatch(
        new RegExp(`^${entry.route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?`)
      );
      expect(entry.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("covers every non-default tab on the tab-first hubs", () => {
    const values = (route: string, key: string) =>
      HUB_VARIANTS.filter((entry) => entry.route === route).map((entry) =>
        new URL(entry.target, "https://allos.test").searchParams.get(key)
      );

    expect(values("/training", "tab")).toEqual(TRAINING_TABS.slice(1));
    expect(values("/trends", "tab")).toEqual(TRENDS_TABS.slice(1));
    expect(values("/nutrition", "tab")).toEqual(NUTRITION_TABS.slice(1));
    expect(values("/data", "section")).toEqual([
      "review",
      "coverage",
      "manage",
      "trash",
    ]);
  });
});

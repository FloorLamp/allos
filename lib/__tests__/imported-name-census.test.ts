import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CENSUS_ROOTS,
  blankComments,
  cssCasingClassSites,
  cssCasingOverNameHits,
  nameCasingHits,
  nameRenderSites,
} from "@/lib/imported-name-census";

// The no-display-casing-pass census (#3480). Half of the imported-name doctrine is
// "the cleaning happens at the import boundary"; the other half is "and NOT at the
// display boundary", and this is what keeps the second half true.
//
// IT IS AN ABSENCE ASSERTION, so it fails OPEN — the sweep goes green the moment it
// stops finding anything to examine, and that is the failure #3509 is standing on.
// Three defences, all of them here:
//   1. FLOORS. How many files did it read, how many name renders did it see, how
//      many casing classes did it see. A scan that breaks drops to near zero and
//      reds instead of passing.
//   2. A NAMED SUBJECT. One file that MUST contain a name render, so a floor met by
//      244 sites in the wrong places still cannot hide a rule that stopped matching
//      the shape it was written for.
//   3. SYNTHETIC OFFENDERS. Sources authored to break the rule, which it must flag —
//      and benign neighbours it must stay silent on.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Floors, measured 2026-08-22 on this tree: 855 .tsx files under app/ + components/,
// 244 name render sites, 56 casing-markup sites (54 casing classes plus the two
// `className={expr}` spellings the widened rule now reaches). Each floor sits a little under its
// measurement so ordinary deletion churn does not red the build, while the failure
// this test exists for — a rule that quietly stops matching, which takes the count to
// single digits — cannot get past it.
const FILE_FLOOR = 800;
const NAME_RENDER_FLOOR = 220;
const CSS_CASING_FLOOR = 45;

// The named subject. /medications renders a medication's name as its heading, in
// brand colour, which is the exact site #3480 was filed about. If this file stops
// registering a name render, the rule has stopped seeing the thing it is for,
// whatever the totals say.
const NAMED_SUBJECT = "app/(app)/medications/MedicationRow.tsx";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(p, out);
    } else if (entry.name.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

function censusFiles(): string[] {
  return CENSUS_ROOTS.flatMap((root) => walk(path.join(REPO, root)));
}

describe("no display surface casings a stored name", () => {
  const files = censusFiles();

  it("read enough of the tree for the sweep to mean anything", () => {
    expect(
      files.length,
      `the census read ${files.length} .tsx files under ${CENSUS_ROOTS.join(
        " + "
      )} — below the ${FILE_FLOOR} floor, so a clean sweep is more likely to mean ` +
        `the walk broke than that the tree complies`
    ).toBeGreaterThanOrEqual(FILE_FLOOR);
  });

  it("found the name renders it is meant to be examining", () => {
    const total = files.reduce(
      (n, f) => n + nameRenderSites(fs.readFileSync(f, "utf8")).length,
      0
    );
    expect(
      total,
      `the census saw ${total} name render sites — below the ` +
        `${NAME_RENDER_FLOOR} floor. An absence assertion over nothing passes; ` +
        `this is the floor that stops it`
    ).toBeGreaterThanOrEqual(NAME_RENDER_FLOOR);
  });

  it("still sees the surface the issue was filed about", () => {
    const source = fs.readFileSync(path.join(REPO, NAMED_SUBJECT), "utf8");
    const sites = nameRenderSites(source);
    expect(
      sites.map((s) => s.text),
      `${NAMED_SUBJECT} renders the medication name #3480 is about; the census ` +
        `must see it there specifically, not merely somewhere`
    ).toContain("med.name");
  });

  it("finds no casing transform on a rendered name", () => {
    const offenders = files.flatMap((f) =>
      nameCasingHits(fs.readFileSync(f, "utf8")).map(
        (h) => `${path.relative(REPO, f)}:${h.line}  {${h.text}}`
      )
    );
    expect(
      offenders,
      "a name reaches the DOM through a casing transform. Clean the name at the " +
        "import boundary where a person confirms it (lib/imported-name.ts), never " +
        "on the way to the screen — a casing pass cannot tell a route code from a " +
        "word, and rewrites text nobody agreed to change"
    ).toEqual([]);
  });

  it("found the casing classes it is meant to be examining", () => {
    const total = files.reduce(
      (n, f) => n + cssCasingClassSites(fs.readFileSync(f, "utf8")).length,
      0
    );
    expect(total).toBeGreaterThanOrEqual(CSS_CASING_FLOOR);
  });

  it("finds no casing class over a rendered name", () => {
    const offenders = files.flatMap((f) =>
      cssCasingOverNameHits(fs.readFileSync(f, "utf8")).map(
        (h) => `${path.relative(REPO, f)}:${h.line}  ${h.text}`
      )
    );
    expect(
      offenders,
      "an element carrying `uppercase`/`lowercase`/`capitalize` renders a name. " +
        "That is a display casing pass with no JavaScript in it, and the doctrine " +
        "covers it too"
    ).toEqual([]);
  });
});

// ── The rule's own proof ─────────────────────────────────────────────────────
//
// A green sweep over a COMPLYING tree says nothing about what the sweep can see.

describe("the census rule can see an offender", () => {
  const OFFENDERS: [string, string][] = [
    [
      "an upper-cased name as a text child",
      `<span data-testid="medication-name">{med.name.toUpperCase()}</span>`,
    ],
    ["a locale-cased name", `<h2>{item.source_name.toLocaleUpperCase()}</h2>`],
    ["a title-case helper", `<span>{titleCase(item.name)}</span>`],
    [
      "a capitalize helper, spelled either way",
      `<span>{capitalise(row.provider_name)}</span>`,
    ],
    ["a lower-cased name", `<div>{c.name.toLowerCase()}</div>`],
    [
      "a cased name in an accessible label",
      `<button aria-label={med.name.toUpperCase()}>x</button>`,
    ],
    [
      "a cased name behind an optional chain",
      `<span>{med?.name?.toUpperCase()}</span>`,
    ],
  ];

  for (const [what, source] of OFFENDERS) {
    it(`flags ${what}`, () => {
      expect(
        nameCasingHits(source).length,
        `the census must SEE ${JSON.stringify(source)} — a guard that cannot ` +
          `see the spelling somebody would actually reach for is worse than no ` +
          `guard, because it turns "nobody has done this" into "nobody can"`
      ).toBeGreaterThan(0);
    });
  }

  // THE MARKUP HALF, and these four are the shapes review had to find because the
  // rule could not. Each was planted on the exact heading #3480 names.
  const MARKUP_OFFENDERS: [string, string][] = [
    [
      "a casing class over a name render",
      `<span className="text-xs uppercase">{med.name}</span>`,
    ],
    [
      "an inline textTransform over a name render",
      `<span style={{ textTransform: "uppercase" }}>{med.name}</span>`,
    ],
    [
      "a casing class reached through a ternary",
      `<span className={current ? "uppercase" : "normal-case"}>{med.name}</span>`,
    ],
    [
      "a casing class whose element wraps a NESTED tag before the name",
      `<b className="uppercase"><i>·</i>{med.name}</b>`,
    ],
  ];

  for (const [what, source] of MARKUP_OFFENDERS) {
    it(`flags ${what}`, () => {
      expect(
        cssCasingOverNameHits(source).length,
        `the census must SEE ${JSON.stringify(source)} — the markup half is the ` +
          `half with no JavaScript in it, so nothing else in the tree can catch it`
      ).toBeGreaterThan(0);
    });
  }
});

describe("the census rule stays quiet on the benign neighbours", () => {
  // Every one of these is a SHIPPED shape in this tree. #3325's lesson: a census
  // that cried wolf on the correct neighbours would be deleted within a week, and it
  // would take the real rule with it.
  const QUIET: [string, string][] = [
    [
      "a name lowercased to COMPARE",
      `const hit = p.name.toLowerCase() === q.trim().toLowerCase();`,
    ],
    [
      "a name lowercased as a SORT key",
      `sort: { value: (im) => (im.provider_name ?? "").toLowerCase() },`,
    ],
    [
      "a name lowercased as a MAP key",
      `SUPPLEMENT_CATALOG.map((c) => [c.name.toLowerCase(), c])`,
    ],
    [
      "a name lowercased inside a filter callback body",
      `.filter((p) => { return p.name.toLowerCase().includes(needle); })`,
    ],
    [
      "a name rendered as stored — the correct shape",
      `<span data-testid="medication-name">{med.name}</span>`,
    ],
    [
      "a casing class on text that is not a name",
      `<span className="text-xs uppercase">{unitLabel}</span>`,
    ],
    [
      "a non-name value cased for display",
      `<span>{status.toUpperCase()}</span>`,
    ],
    [
      "an inline textTransform on text that is not a name",
      `<span style={{ textTransform: "uppercase" }}>{unitLabel}</span>`,
    ],
    [
      "a ternary casing class on text that is not a name",
      `<span className={active ? "uppercase" : "normal-case"}>{tabLabel}</span>`,
    ],
    [
      "a name rendered in the SIBLING after a cased element",
      // The window is depth-aware, so this element's own `</span>` ends it. Without
      // that, every eyebrow in the tree would drag the next name in and the rule
      // would be deleted for crying wolf.
      `<span className="uppercase">Dose</span><span>{med.name}</span>`,
    ],
  ];

  for (const [what, source] of QUIET) {
    it(`stays quiet on ${what}`, () => {
      expect(
        [...nameCasingHits(source), ...cssCasingOverNameHits(source)],
        `the census must stay QUIET on ${JSON.stringify(source)} — it is the ` +
          `rule working correctly, and a guard that flags it gets deleted`
      ).toEqual([]);
    });
  }
});

describe("comments are blanked before the scan", () => {
  it("does not read prose as code", () => {
    // The brief's own trap: an e2e-hygiene census flagged `.first()` written in an
    // English sentence, and Tailwind compiled a class because a comment mentioned it.
    const source = [
      `// A comment mentioning <span>{med.name.toUpperCase()}</span> on purpose.`,
      `/* And a block one: {item.name.toLocaleUpperCase()} */`,
      `<span>{med.name}</span>`,
    ].join("\n");
    expect(nameCasingHits(source)).toEqual([]);
    expect(nameRenderSites(source).map((h) => h.text)).toEqual(["med.name"]);
  });

  it("leaves string literals alone", () => {
    // A `//` inside a URL is not a comment, and a regex-based blanker eats the rest
    // of the line — taking real code with it and shrinking the census silently.
    const source = [
      `const doc = "https://rxnav.nlm.nih.gov/REST"; // trailing comment`,
      `<span>{med.name.toUpperCase()}</span>`,
    ].join("\n");
    expect(blankComments(source)).toContain("https://rxnav.nlm.nih.gov/REST");
    expect(nameCasingHits(source).length).toBe(1);
  });

  it("preserves line numbers", () => {
    const source = [`/* one`, `   two */`, `<span>{med.name}</span>`].join(
      "\n"
    );
    expect(nameRenderSites(source)[0].line).toBe(3);
  });
});

// DB INTEGRATION TIER — issue #2772: the scanner both child-link guards share must
// FAIL on a CHILD_LINKS registry it cannot read, not report zero pairs.
//
// THE DEFECT CLASS. `linkLiterals()` recognises one shape,
// `{ table: "…", column: "…" }` with string literals. Every registry in the tree
// uses it, so nothing was broken — but a migration declaring the same links as
// tuples, template literals, or anything BUILT rather than spelled resolved to no
// pairs at all, and both guards then passed vacuously over a migration that deletes
// rows. #2444 was a guard naming columns that never existed; this is the same thing
// with no misspelling to find, only an absence, which is harder to notice.
//
// A delete-guarding census answering "nothing to check" is indistinguishable from
// one answering "everything checks out", and the consequence of getting it wrong is
// deleted health records with no recoverable copy (#2702).
//
// WHY THESE CASES. Each source below is fed to the scanner as text rather than
// written into `lib/migrations/versions/` — a scratch migration there would need an
// index.ts entry and a manifest hash, and would be a shipped migration for
// immutability purposes. The tuple case is the one the issue names; the others are
// the neighbouring forms an author reaches for next.
//
// SYNTHETIC ONLY: invented table and column names. No PHI.

import { describe, expect, it } from "vitest";
import {
  assertRegistriesReadable,
  linkLiterals,
  scanMigrationSource,
  scanMigrationVersions,
} from "./migration-link-scan";

const FILE = "29990101-scratch.ts";

/** The literal shape, which must keep resolving. The control for every case below. */
const LITERAL = `
const CHILD_LINKS: readonly { table: string; column: string }[] = [
  { table: "care_plan_items", column: "record_id" },
];
export function up(): void {
  void CHILD_LINKS;
}
`;

describe("the pair matcher still reads the shape every migration uses", () => {
  it("resolves an object-literal registry and reports no gap", () => {
    const scan = scanMigrationSource(FILE, LITERAL);
    expect(scan.links).toEqual([
      { file: FILE, table: "care_plan_items", column: "record_id" },
    ]);
    expect(scan.unreadable).toEqual([]);
  });

  it("sees through `as const` and `satisfies`", () => {
    const scan = scanMigrationSource(
      FILE,
      `const CHILD_LINKS = [{ table: "t_one", column: "c_one" }] as const;
       const MORE_CHILD_LINKS = ([
         { table: "t_two", column: "c_two" },
       ]) satisfies readonly { table: string; column: string }[];`
    );
    expect(scan.unreadable).toEqual([]);
    expect(scan.links.map((l) => `${l.table}.${l.column}`)).toEqual([
      "t_one.c_one",
      "t_two.c_two",
    ]);
  });
});

// Each case is a registry the OLD scan resolved to zero pairs and said nothing
// about. The assertion is on `unreadable`, because "links is empty" was already
// true before the fix and is therefore not evidence of anything.
const UNREADABLE: { why: string; src: string; contains: string }[] = [
  {
    why: "tuples — the form the issue names",
    src: `const CHILD_LINKS = [["care_plan_items", "record_id"]] as const;`,
    contains: `["care_plan_items", "record_id"]`,
  },
  {
    why: "template literals in place of string literals",
    src:
      "const PREFIX = `care_plan`;\n" +
      "const CHILD_LINKS = [{ table: `${PREFIX}_items`, column: `record_id` }];",
    contains: "{ table: `${PREFIX}_items`, column: `record_id` }",
  },
  {
    why: "built by a helper rather than spelled",
    src: `const CHILD_LINKS = buildLinks("care_plan_items", ["record_id"]);`,
    contains: `buildLinks("care_plan_items", ["record_id"])`,
  },
  {
    why: "spread from another module",
    src:
      `import { SHARED } from "../shared-links";\n` +
      `const CHILD_LINKS = [...SHARED, { table: "t_one", column: "c_one" }];`,
    contains: "...SHARED",
  },
  {
    why: "a column name computed from a variable",
    src:
      `const col = "record_id";\n` +
      `const CHILD_LINKS = [{ table: "care_plan_items", column: col }];`,
    contains: '{ table: "care_plan_items", column: col }',
  },
  {
    why: "declared with no initializer and assigned later",
    src: `let CHILD_LINKS: { table: string; column: string }[];`,
    contains: "CHILD_LINKS",
  },
];

describe("a registry the scan cannot read is a failure, not a zero (#2772)", () => {
  for (const c of UNREADABLE) {
    it(`refuses ${c.why}`, () => {
      const scan = scanMigrationSource(FILE, c.src);
      expect(
        scan.unreadable.map((u) => u.text),
        "this registry resolved to no pairs and said nothing about it — both " +
          "guards then pass vacuously over the migration that declared it"
      ).toContainEqual(expect.stringContaining(c.contains));
      expect(scan.unreadable[0].file).toBe(FILE);
      expect(scan.unreadable[0].name).toContain("CHILD_LINKS");
      expect(scan.unreadable[0].line).toBeGreaterThan(0);
    });
  }

  it("holds a renamed registry to the same shape", () => {
    const scan = scanMigrationSource(
      FILE,
      `const RECORD_CHILD_LINKS = [["t_one", "c_one"]] as const;`
    );
    expect(scan.unreadable.map((u) => u.name)).toEqual(["RECORD_CHILD_LINKS"]);
  });

  it("throws on the path linkLiterals() takes, naming the file", () => {
    // `assertRegistriesReadable` is the line linkLiterals() runs before returning;
    // the real tree is clean, so it is driven here with the tuple case instead of
    // by planting a scratch file in versions/ (which would need an index.ts entry
    // and a manifest hash, i.e. a shipped migration).
    const scan = scanMigrationSource(FILE, UNREADABLE[0].src);
    expect(() => assertRegistriesReadable(scan)).toThrow(
      /29990101-scratch\.ts/
    );
    expect(() => assertRegistriesReadable(scan)).toThrow(/#2772/);
    expect(() => assertRegistriesReadable(scan)).toThrow(/pass VACUOUSLY/);
  });

  it("lets a clean scan through", () => {
    expect(() =>
      assertRegistriesReadable(scanMigrationSource(FILE, LITERAL))
    ).not.toThrow();
  });
});

describe("the guards' own input is clean and non-empty", () => {
  it("every shipped migration's registry is readable", () => {
    const { unreadable } = scanMigrationVersions();
    expect(
      unreadable.map((u) => `${u.file}:${u.line} ${u.name} — ${u.text}`),
      "a shipped migration declares child links in a shape the guards cannot " +
        "read, so both cover nothing for it (#2772)"
    ).toEqual([]);
  });

  it("linkLiterals() still returns the pairs it always did", () => {
    expect(linkLiterals().length).toBeGreaterThan(0);
  });
});

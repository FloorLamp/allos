import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import {
  dateStrInTz,
  isRealIsoDate,
  lastNDates,
  shiftDateStr,
  startOfWeekStr,
  toUtcInstant,
  utcInstant,
  utcMinute,
  utcSqlString,
  zonedDateParts,
} from "../date";
import { fhirSourceTime, sourceDay, sourceInstant } from "../source-time";
import { activityClockHHMM } from "../activity-meta";
import type {
  BareInstant,
  CanonicalInstant,
  LocalDay,
  LocalTime,
} from "../temporal-types";

// The temporal type vocabulary (#2899). Three things are pinned: that every minter
// produces its brand with no cast at the call site, that the brands are NOT
// interchangeable (grain and serialization are separate axes), and that the cast ban
// in eslint.config.mjs refuses every spelling of `x as LocalDay` the 2026-09-05
// falsifying pass found while leaving a DB row shape alone.
//
// The ban is a ratchet over SHAPES, so what it cannot see is pinned here beside what
// it refuses (`namedLimits` below). That list is the honest reading of the rule, and
// callers cite it rather than claiming "a cast is refused" (#5914). It has THREE
// causes, and the tables below keep them apart because collapsing them into one is how
// the list went stale before: a NAME to resolve, a VALUE to follow, and a DECISION.
//
// The type-level half uses `@ts-expect-error`: an assignment the vocabulary must
// refuse is written out, and `npm run typecheck` fails if it ever starts compiling.

describe("temporal brands: minters produce the brand without a cast", () => {
  it("isRealIsoDate narrows to LocalDay by validating the calendar", () => {
    const v: string = "2026-02-28";
    if (!isRealIsoDate(v)) throw new Error("unreachable");
    const day: LocalDay = v;
    expect(day).toBe("2026-02-28");
    expect(isRealIsoDate("2026-02-30")).toBe(false);
  });

  it("the day constructors mint LocalDay", () => {
    const d: LocalDay = dateStrInTz("UTC", new Date("2026-03-01T12:00:00Z"));
    const shifted: LocalDay = shiftDateStr(d, -1);
    const week: LocalDay = startOfWeekStr(d, 1);
    const window: LocalDay[] = lastNDates(d, 3);
    const parts: { date: LocalDay; hhmm: LocalTime } = zonedDateParts(
      "UTC",
      new Date("2026-03-01T12:34:00Z")
    );
    expect([d, shifted, week, ...window, parts.date, parts.hhmm]).toEqual([
      "2026-03-01",
      "2026-02-28",
      "2026-02-23",
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-01",
      "12:34",
    ]);
  });

  it("the instant constructors mint each serialization's own brand", () => {
    const at = new Date("2026-07-15T20:02:03.456Z");
    const canonical: CanonicalInstant = utcInstant(at);
    const minute: CanonicalInstant = utcMinute(at);
    const rewritten: CanonicalInstant | null = toUtcInstant(
      "2026-07-15 20:02:03"
    );
    const bare: BareInstant = utcSqlString(at);
    expect([canonical, minute, rewritten, bare]).toEqual([
      "2026-07-15T20:02:03Z",
      "2026-07-15T20:02:00Z",
      "2026-07-15T20:02:03Z",
      "2026-07-15 20:02:03",
    ]);
  });

  it("the ingest boundary carries the brands out through its readers", () => {
    const t = fhirSourceTime("2026-01-01T00:30:00+09:00");
    const day: LocalDay | null = sourceDay(t);
    const instant: CanonicalInstant | null = sourceInstant(t);
    expect(day).toBe("2026-01-01");
    expect(instant).toBe("2025-12-31T15:30:00Z");
  });

  it("activityClockHHMM mints LocalTime only for an in-range clock", () => {
    const clock: LocalTime | null = activityClockHHMM("2026-08-01T14:30:00Z");
    expect(clock).toBe("14:30");
    expect(activityClockHHMM("25:00")).toBeNull();
  });
});

describe("temporal brands: the axes do not collapse", () => {
  // A plain string is never a brand.
  const plain: string = "2026-08-05";
  // @ts-expect-error a plain string is not a LocalDay: it was never validated
  const notADay: LocalDay = plain;
  // @ts-expect-error a plain string is not a CanonicalInstant: it was never constructed
  const notAnInstant: CanonicalInstant = plain;

  // The two instant serializations are distinct types: SQLite compares them
  // lexically, so a value on one convention must not typecheck as the other.
  const canonical = utcInstant(new Date(0));
  const bare = utcSqlString(new Date(0));
  // @ts-expect-error a canonical instant is not a bare one
  const notBare: BareInstant = canonical;
  // @ts-expect-error a bare instant is not a canonical one
  const notCanonical: CanonicalInstant = bare;

  // Grain is a separate axis from serialization: a day is not an instant and a
  // clock reading is not a day.
  const day = dateStrInTz("UTC", new Date(0));
  const clock = zonedDateParts("UTC", new Date(0)).hhmm;
  // @ts-expect-error a LocalDay is not a CanonicalInstant
  const dayAsInstant: CanonicalInstant = day;
  // @ts-expect-error a LocalTime is not a LocalDay
  const clockAsDay: LocalDay = clock;

  it("every brand is still a string, so branding a return breaks no caller", () => {
    const asString: string[] = [day, clock, canonical, bare];
    expect(asString).toHaveLength(4);
    // The refused assignments above exist for the compiler only.
    void [
      notADay,
      notAnInstant,
      notBare,
      notCanonical,
      dayAsInstant,
      clockAsDay,
    ];
  });
});

describe("temporal brands: the cast ban", () => {
  // The repo's own flat config, so the test fails if the rule is removed or its
  // selectors drift from the exported names.
  const eslint = new ESLint({ cwd: process.cwd() });
  const lint = async (code: string) => {
    const [result] = await eslint.lintText(code, {
      filePath: "lib/__brand_probe__.ts",
    });
    return result.messages.filter((m) => m.ruleId === "no-restricted-syntax");
  };
  const header = [
    `import type { LocalDay, CanonicalInstant } from "./temporal-types";`,
    `import type * as TT from "./temporal-types";`,
    `declare const s: string;`,
    `declare const get: () => unknown;`,
    ``,
  ].join("\n");

  // Every spelling the 2026-09-05 falsifying pass found that a plain-string cast
  // could hide behind. Each is one message: the brand reference is matched once.
  const refused: Record<string, string> = {
    direct: `s as LocalDay`,
    throughUnknown: `s as unknown as LocalDay`,
    angleBracket: `<LocalDay>s`,
    parenthesised: `s as (LocalDay)`,
    union: `s as CanonicalInstant | null`,
    array: `[s] as LocalDay[]`,
    qualified: `s as TT.LocalDay`,
    importType: `s as import("./temporal-types").LocalDay`,
    intersection: `s as LocalDay & {}`,
    intersectionInUnion: `s as (LocalDay & string) | null`,
    nonNullable: `s as NonNullable<LocalDay>`,
    readonly: `s as Readonly<LocalDay>`,
    arrayGeneric: `[s] as Array<LocalDay>`,
    readonlyArray: `[s] as readonly LocalDay[]`,
    arrayOfUnion: `[s] as (LocalDay | null)[]`,
    tuple: `[s] as [LocalDay]`,
  };

  for (const [name, expr] of Object.entries(refused)) {
    it(`refuses ${name}: ${expr}`, async () => {
      const messages = await lint(`${header}export const v = ${expr};\n`);
      expect(messages.map((m) => m.message)).toEqual([
        expect.stringContaining("Do not cast or re-alias to a temporal brand"),
      ]);
    });
  }

  // #5914 — the row-shape exemption ends where the cast is read STRAIGHT back out.
  // `({ d: s } as { d: LocalDay }).d` type-checked and linted clean before this, which
  // made a brand out of a plain string on a production path with nothing to say so.
  // The cast's type has to BE the row here, which is what keeps the idiom below out of
  // it; each of these takes the value off the cast node itself.
  const refusedReadThrough: Record<string, string> = {
    propertyOffTheCast: `({ d: s } as { d: LocalDay }).d`,
    methodOffTheCast: `(s as unknown as { toString(): LocalDay }).toString()`,
    nonNullOffTheCast: `({ d: s } as { d: LocalDay })!.d`,
    optionalRowOffTheCast: `(get() as { d: LocalDay } | undefined)!.d`,
    satisfiesOffTheCast: `(get() as any satisfies { d: LocalDay }).d`,
  };

  for (const [name, expr] of Object.entries(refusedReadThrough)) {
    it(`refuses reading a brand back out of a row-shape cast: ${name}`, async () => {
      const messages = await lint(`${header}export const v = ${expr};\n`);
      expect(messages.map((m) => m.message)).toEqual([
        expect.stringContaining("Do not cast or re-alias to a temporal brand"),
      ]);
    });
  }

  it("refuses a row-shape cast destructured instead of read", async () => {
    const messages = await lint(
      `${header}const { d } = { d: s } as { d: LocalDay };\nexport const v = d;\n`
    );
    expect(messages.map((m) => m.message)).toEqual([
      expect.stringContaining("Do not cast or re-alias to a temporal brand"),
    ]);
  });

  // THE IDIOM THE EXEMPTION EXISTS FOR, and the reason the selector matches the row
  // literal directly rather than a brand anywhere under the cast's type: casting a
  // query result to an array of branded rows and mapping it reaches the brand only
  // through a BOUND row inside the callback, and `.length` is not a member of the row
  // at all. Both of these reddened on the first cut of this rule (#5914).
  const protectedIdiom: Record<string, string> = {
    arrayCastMapped: `(get() as { d: LocalDay }[]).map((r) => r.d)`,
    arrayCastLength: `(get() as { d: LocalDay }[]).length`,
    arrayCastFiltered: `(get() as { d: LocalDay }[]).filter((r) => !!r.d)`,
    readonlyArrayCastMapped: `(get() as readonly { d: LocalDay }[]).map((r) => r.d)`,
    arrayGenericCastMapped: `(get() as Array<{ d: LocalDay }>).map((r) => r.d)`,
    promiseCastThen: `(get() as unknown as Promise<{ d: LocalDay }>).then((r) => r.d)`,
    tupleCastLength: `(get() as [{ d: LocalDay }]).length`,
  };

  for (const [name, expr] of Object.entries(protectedIdiom)) {
    it(`leaves the row-shape idiom alone: ${name}`, async () => {
      const messages = await lint(`${header}export const v = ${expr};\n`);
      expect(messages).toHaveLength(0);
    });
  }

  // What the read-through selector refuses WITHOUT a brand being minted. ONE cause: a
  // selector cannot match the read NAME against the branded member's name, so any read
  // off a cast whose type is the branded row literal is refused. Measured rather than
  // estimated — across a 33-shape matrix this is the whole of it, two shapes (four
  // spellings, counting the destructured and nested-literal forms of each).
  const overApproximated: Record<string, string> = {
    otherFieldOffTheCast: `(get() as { d: LocalDay; n: number }).n`,
    fieldWhoseTypeMerelyContainsTheBrand: `(get() as { row: { d: LocalDay } }).row`,
  };

  for (const [name, expr] of Object.entries(overApproximated)) {
    it(`refuses ${name}, which mints nothing — the cost of not matching the read name`, async () => {
      const messages = await lint(`${header}export const v = ${expr};\n`);
      expect(messages).toHaveLength(1);
    });
  }

  // An alias that mentions a brand outside an object shape exists only to cast around
  // the rule; each is refused at the declaration, so `s as D` never needs matching.
  const refusedAliases: Record<string, string> = {
    bare: `type D = LocalDay`,
    unionWithNever: `type D = LocalDay | never`,
    intersection: `type D = LocalDay & {}`,
    nonNullable: `type D = NonNullable<LocalDay>`,
    array: `type Ds = LocalDay[]`,
    functionReturn: `type Mint = (d: Date) => LocalDay`,
    typeParameterDefault: `type G<T = LocalDay> = T`,
  };

  for (const [name, decl] of Object.entries(refusedAliases)) {
    it(`refuses the alias ${name}: ${decl}`, async () => {
      const messages = await lint(`${header}export ${decl};\n`);
      expect(messages).toHaveLength(1);
    });
  }

  // Renaming a brand takes its name out of every selector above, so the rename
  // itself is refused — on the specifier's line, never on the later cast.
  const refusedRenames: Record<string, string> = {
    importAs: `import type { LocalDay as LD } from "./temporal-types";`,
    importStringLiteral: `import type { "LocalDay" as LD } from "./temporal-types";`,
    importEquals: `import * as TT from "./temporal-types";\nimport LD = TT.LocalDay;`,
  };

  for (const [name, decl] of Object.entries(refusedRenames)) {
    it(`refuses renaming a brand: ${name}`, async () => {
      const messages = await lint(
        `${decl}\ndeclare const s: string;\nexport const v = s as LD;\n`
      );
      const specifierLine = decl.split("\n").length;
      expect(messages.map((m) => m.line)).toEqual([specifierLine]);
    });
  }

  const refusedExportRenames: Record<string, string> = {
    exportAs: `export type { LocalDay as Day } from "./temporal-types";`,
    exportStringLiteral: `export type { "LocalDay" as Day } from "./temporal-types";`,
    exportLocalAs: `${header}export type { LocalDay as Day };`,
  };

  for (const [name, decl] of Object.entries(refusedExportRenames)) {
    it(`refuses renaming a brand at export: ${name}`, async () => {
      const messages = await lint(`${decl}\n`);
      expect(messages).toHaveLength(1);
    });
  }

  // The row-shape exemption, and casts that are none of this rule's business.
  const allowed: Record<string, string> = {
    rowShape: `get() as { date: LocalDay; n: number }[]`,
    nestedRowShape: `get() as { d: { date: LocalDay } }`,
    optionalRow: `get() as { date: LocalDay } | undefined`,
    unrelatedCast: `s as "x" | "y"`,
    brandOnExpressionSide: `(get as unknown as <T>() => T)<LocalDay>() as string`,
  };

  for (const [name, expr] of Object.entries(allowed)) {
    it(`leaves ${name} alone: ${expr}`, async () => {
      const messages = await lint(`${header}export const v = ${expr};\n`);
      expect(messages).toHaveLength(0);
    });
  }

  const allowedDeclarations: Record<string, string> = {
    rowAlias: `type Row = { date: LocalDay; n: number }`,
    unionOfRowShapes: `type Row = { date: LocalDay } | { at: CanonicalInstant }`,
    sourceTimeShape: `type T = { grain: "day"; date: LocalDay } | { grain: "instant"; date: LocalDay; instant: CanonicalInstant }`,
    rowInterface: `interface Row { date: LocalDay }`,
    unrenamedImport: `type { LocalDay as LocalDay } from "./temporal-types"`,
  };

  for (const [name, decl] of Object.entries(allowedDeclarations)) {
    it(`leaves the declaration ${name} alone`, async () => {
      const code =
        name === "unrenamedImport"
          ? `import ${decl};\n`
          : `${header}export ${decl};\n`;
      const messages = await lint(code);
      expect(messages).toHaveLength(0);
    });
  }

  // The rule is a ratchet over spellings and says so (lib/temporal-types.ts): these
  // launder a string through what a name RESOLVES to rather than by naming a brand in
  // a cast target, alias or specifier, and are review's, as for every other type.
  // Pinned so the documented limit and the rule cannot drift apart silently.
  //
  // MOST OF THEM ARE CASTS (#5914), which is why nothing may claim that the rule
  // refuses a cast. Each was executed past `eslint` AND `tsc` against the write brand,
  // so every entry here is a working forge and not a theoretical one. They split by
  // WHY the selector misses them, and the reason matters because it is what says
  // whether the entry could ever move:
  //
  //   A NAME TO RESOLVE — the brand is never spelled in the cast. Unreachable
  //   syntactically, and the row types themselves are legitimate.
  //   A VALUE TO FOLLOW — the brand IS spelled in the cast, but it is reached through
  //   something the cast produced. Needs types, not syntax.
  //   A DECISION — matchable today, left open on purpose; the comment in
  //   eslint.config.mjs gives the reason.
  const namedLimits: Record<string, string> = {
    // a name to resolve
    namedRowReadThrough: `type Row = { d: LocalDay }; export const v = ({ d: s } as Row).d`,
    indexedAccessIntoRow: `type Row = { d: LocalDay }; export const v = s as Row["d"]`,
    interfaceHeritage: `interface Ds extends Array<LocalDay> {} export const v = ([s] as Ds)[0]`,
    // a value to follow
    elementOfCastArray: `export const v = (get() as { d: LocalDay }[])[0].d`,
    awaitedCastPromise: `export const v = async () => (await (get() as unknown as Promise<{ d: LocalDay }>)).d`,
    castFunctionReturn: `export const v = (get as unknown as () => { d: LocalDay })().d`,
    spreadCopyOfCast: `export const v = { ...(get() as { d: LocalDay }) }.d`,
    boundRowThenRead: `const row = get() as { d: LocalDay }; export const v = row.d`,
    // a decision
    genericLaunderer: `declare function id<T>(x: unknown): T; export const v = id<LocalDay>(s)`,
    // neither — these launder through what a name resolves to, as for any other type
    lyingPredicate: `function isDay(x: string): x is LocalDay { return true }`,
    asAny: `declare function f(d: LocalDay): void; f(s as any)`,
  };

  for (const [name, code] of Object.entries(namedLimits)) {
    it(`does not refuse ${name}`, async () => {
      const messages = await lint(`${header}${code};\n`);
      expect(messages).toHaveLength(0);
    });
  }

  it("honours a minter's disable line", async () => {
    const minted = await lint(
      `${header}// eslint-disable-next-line no-restricted-syntax -- LocalDay minter: probe\nexport const m = s as LocalDay;\n`
    );
    expect(minted).toHaveLength(0);
  });
});

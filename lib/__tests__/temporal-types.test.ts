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

  // An alias that mentions a brand outside an object shape exists only to cast around
  // the rule; each is refused at the declaration, so `s as D` never needs matching.
  const refusedAliases: Record<string, string> = {
    bare: `type D = LocalDay`,
    unionWithNever: `type D = LocalDay | never`,
    intersection: `type D = LocalDay & {}`,
    nonNullable: `type D = NonNullable<LocalDay>`,
    array: `type Ds = LocalDay[]`,
    functionReturn: `type Mint = (d: Date) => LocalDay`,
  };

  for (const [name, decl] of Object.entries(refusedAliases)) {
    it(`refuses the alias ${name}: ${decl}`, async () => {
      const messages = await lint(`${header}export ${decl};\n`);
      expect(messages).toHaveLength(1);
    });
  }

  it("refuses renaming a brand at import, which takes its name out of every selector", async () => {
    const messages = await lint(
      `import type { LocalDay as LD } from "./temporal-types";\ndeclare const s: string;\nexport const v = s as LD;\n`
    );
    expect(messages.map((m) => m.line)).toEqual([1]);
  });

  it("refuses renaming a brand at export", async () => {
    const messages = await lint(
      `export type { LocalDay as Day } from "./temporal-types";\n`
    );
    expect(messages).toHaveLength(1);
  });

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

  // The rule is syntactic and says so (lib/temporal-types.ts): these launder a string
  // without NAMING a brand as a cast target, and are review's, as for every other
  // type. Pinned so the documented limit and the rule cannot drift apart silently.
  const namedLimits: Record<string, string> = {
    indexedAccessIntoRow: `type Row = { d: LocalDay }; export const v = s as Row["d"]`,
    lyingPredicate: `function isDay(x: string): x is LocalDay { return true }`,
    genericLaunderer: `declare function id<T>(x: unknown): T; export const v = id<LocalDay>(s)`,
    asAny: `declare function f(d: LocalDay): void; f(s as any)`,
  };

  for (const [name, code] of Object.entries(namedLimits)) {
    it(`cannot see ${name}, by design`, async () => {
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

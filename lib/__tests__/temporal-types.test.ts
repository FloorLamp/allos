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
import {
  dayMidnightAnchor,
  vendorInstant,
  type BareInstant,
  type CanonicalInstant,
  type LocalDay,
  type LocalTime,
  type MetricSampleInstant,
} from "../temporal-types";

// The temporal type vocabulary (#2899). Three things are pinned: that every minter
// produces its brand with no cast at the call site, that the brands are NOT
// interchangeable (grain and serialization are separate axes), and that the cast ban
// in eslint.config.mjs refuses `x as LocalDay` while leaving a DB row shape alone.
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

describe("temporal brands: the metric_samples union is modeled, never cast", () => {
  it("dayMidnightAnchor constructs from a LocalDay", () => {
    const v: string = "2026-08-05";
    if (!isRealIsoDate(v)) throw new Error("unreachable");
    const anchor: MetricSampleInstant = dayMidnightAnchor(v);
    expect(anchor).toBe("2026-08-05T00:00:00");
  });

  it("vendorInstant validates by toISOString round-trip", () => {
    const ok: MetricSampleInstant | null = vendorInstant(
      "2026-08-05T06:12:00.000Z"
    );
    expect(ok).toBe("2026-08-05T06:12:00.000Z");
    // Second resolution, zoneless, bare and garbage are all refused: none is the
    // shape the integrations write.
    expect(vendorInstant("2026-08-05T06:12:00Z")).toBeNull();
    expect(vendorInstant("2026-08-05T06:12:00")).toBeNull();
    expect(vendorInstant("2026-08-05 06:12:00")).toBeNull();
    expect(vendorInstant("not a time")).toBeNull();
    expect(vendorInstant(null)).toBeNull();
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
  // @ts-expect-error a canonical instant is not a metric_samples value: that column is never branded canonical
  const canonicalAsSample: MetricSampleInstant = canonical;

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
    void canonicalAsSample;
  });
});

describe("temporal brands: the cast ban", () => {
  // The repo's own flat config, so the test fails if the rule is removed or its
  // selector drifts from the exported names.
  const eslint = new ESLint({ cwd: process.cwd() });
  const lint = async (code: string) => {
    const [result] = await eslint.lintText(code, {
      filePath: "lib/__brand_probe__.ts",
    });
    return result.messages.filter((m) => m.ruleId === "no-restricted-syntax");
  };
  const header = `import type { LocalDay, CanonicalInstant } from "./temporal-types";\ndeclare const s: string;\n`;

  it("refuses a direct cast, a union cast and an array cast to a brand", async () => {
    const direct = await lint(`${header}export const a = s as LocalDay;\n`);
    const union = await lint(
      `${header}export const b = s as CanonicalInstant | null;\n`
    );
    const array = await lint(`${header}export const c = [s] as LocalDay[];\n`);
    expect(direct.map((m) => m.message)).toEqual([
      expect.stringContaining("Do not cast to a temporal brand"),
    ]);
    expect(union).toHaveLength(1);
    expect(array).toHaveLength(1);
  });

  it("leaves a DB row shape and an unrelated cast alone", async () => {
    const row = await lint(
      `${header}declare const get: () => unknown;\nexport const r = get() as { date: LocalDay; n: number }[];\n`
    );
    const other = await lint(`${header}export const o = s as "x" | "y";\n`);
    expect(row).toHaveLength(0);
    expect(other).toHaveLength(0);
  });

  it("names every minter on a disable line, so the inventory is greppable", async () => {
    const minted = await lint(
      `${header}// eslint-disable-next-line no-restricted-syntax -- LocalDay minter: probe\nexport const m = s as LocalDay;\n`
    );
    expect(minted).toHaveLength(0);
  });
});

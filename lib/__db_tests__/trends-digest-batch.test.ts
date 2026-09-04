// The Trends digest reads its biomarkers in ONE batch (#5012).
//
// `biomarkerPlots` was written for this and hoists every read that is not per-analyte:
// the series (one `IN (…)` over the families) and the three demographic reads. The
// digest asked it one name at a time, which takes `getBiomarkerSeriesFor`'s single-name
// short-circuit, so a profile with N canonical names in use paid N deduped per-family
// reads on every Trends render — 307 of them on the snapshot #5012 was found on, 0.53 s
// of SQLite between them. The request cache cannot help: it keys on (profile,
// canonical) and every name is distinct.
//
// WHAT THIS FILE MEASURES. Equivalence between the batched and unbatched answers is
// already `biomarker-plot-batch.test.ts`'s subject, and it is the reason this change is
// safe. What no test could see is whether the digest TAKES the batch — a refactor that
// quietly kept the per-name path passes every existing assertion.
//
// SO THE ASSERTION IS A SCALING ONE, NOT A NUMBER. Two profiles, one with six biomarker
// families and one with twelve, and the deduped read must run the SAME number of times
// for both. A fixed budget would have to be re-measured whenever anything else on the
// digest's path gained a query, and re-measuring a budget is how the number stops
// meaning anything; a count that must not GROW with the fixture cannot be satisfied by
// the per-name path at any constant. On the old code these are 6 and 12.
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { buildBiomarkerSeries, buildDigestSeries } from "@/lib/trends-series";
import { shiftDateStr } from "@/lib/date";

const FAMILIES = [
  ["LDL Cholesterol", "mg/dL", 130],
  ["HDL Cholesterol", "mg/dL", 52],
  ["Triglycerides", "mg/dL", 95],
  ["Thyroid-Stimulating Hormone (TSH)", "mIU/L", 2.1],
  ["Ferritin", "ng/mL", 80],
  ["Vitamin B12", "pg/mL", 420],
  ["Alanine Aminotransferase (ALT)", "U/L", 22],
  ["Aspartate Aminotransferase (AST)", "U/L", 20],
  ["Creatinine", "mg/dL", 0.9],
  ["Albumin", "g/dL", 4.4],
  ["Sodium", "mmol/L", 140],
  ["Potassium", "mmol/L", 4.2],
] as const;

let loginId: number;
/** [six-family profile, twelve-family profile] */
let profiles: [number, number];

/** How many DEDUPED biomarker series reads ran — batched or per-name, both counted. */
function dedupedReadCounter() {
  let runs = 0;
  const realPrepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const statement = realPrepare(sql);
    const flat = sql.replace(/\s+/g, " ").trim();
    // The series read, in either shape: the batched one projects `series_family`, the
    // per-name one does not, and counting BOTH is what makes the comparison below a
    // statement about how many series reads happen rather than about which path ran.
    const isSeriesRead =
      flat.includes("WITH deduped") && flat.includes("FROM medical_records");
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (
          typeof value === "function" &&
          ["get", "all", "run", "iterate"].includes(String(property))
        ) {
          return (...args: unknown[]) => {
            if (isSeriesRead) runs += 1;
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.prepare);
  return () => runs;
}

function seedProfile(name: string, familyCount: number): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  const insert = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
  );
  // Three readings each, so every family windows to a plottable series.
  for (const [analyte, unit, base] of FAMILIES.slice(0, familyCount)) {
    for (let i = 0; i < 3; i++) {
      const date = shiftDateStr(today(profileId), -(i * 30 + 5));
      const value = base + i;
      insert.run(profileId, date, analyte, String(value), unit, analyte, value);
    }
  }
  return profileId;
}

beforeAll(() => {
  loginId = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', 'admin')"
      )
      .run(`digest_${process.pid}`).lastInsertRowid
  );
  profiles = [
    seedProfile("TRENDS DIGEST SIX", 6),
    seedProfile("TRENDS DIGEST TWELVE", 12),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const range = (profileId: number) => ({
  from: shiftDateStr(today(profileId), -365),
  to: today(profileId),
});

describe("buildDigestSeries", () => {
  it("costs the same number of series reads at six families and at twelve", () => {
    const [six, twelve] = profiles;
    const countSix = dedupedReadCounter();
    buildDigestSeries(six, loginId, range(six));
    const atSix = countSix();
    vi.restoreAllMocks();

    const countTwelve = dedupedReadCounter();
    buildDigestSeries(twelve, loginId, range(twelve));
    const atTwelve = countTwelve();

    expect(atSix).toBeGreaterThan(0); // the meter is reading something
    expect(atTwelve).toBe(atSix);
  });

  it("still builds a series for every family it read", () => {
    const [, twelve] = profiles;
    const labels = buildDigestSeries(twelve, loginId, range(twelve))
      .filter((s) => s.kind === "biomarker")
      .map((s) => s.label);
    for (const [analyte] of FAMILIES) expect(labels).toContain(analyte);
    // No family is built twice: the batch is keyed by the requested name.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("gives the batched digest the same series as the per-name path", () => {
    // The equivalence that makes the batch safe, asserted here on the digest's OWN
    // output rather than trusted from biomarker-plot-batch.test.ts: every biomarker
    // series the digest emits must match what building that one name alone produces.
    const [, twelve] = profiles;
    const digest = buildDigestSeries(twelve, loginId, range(twelve)).filter(
      (s) => s.kind === "biomarker"
    );
    // At least the twelve seeded families; `getUsedCanonicalNamesWithDerived` also
    // yields the DERIVED names those readings imply, and those are series too.
    expect(digest.length).toBeGreaterThanOrEqual(FAMILIES.length);
    for (const series of digest) {
      const alone = buildBiomarkerSeries(twelve, series.label, range(twelve));
      expect(alone).not.toBeNull();
      expect(series.points).toEqual(alone!.points);
      expect(series.range).toEqual(alone!.range);
      expect(series.unit).toBe(alone!.unit);
    }
  });
});

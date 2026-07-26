import { describe, expect, it } from "vitest";
import {
  classifyTakeoutEntry,
  isHealthConnectRoundTrip,
  parseTakeoutCsv,
  csvNum,
  localDate,
  parseWeightCsv,
  parseBodyFatCsv,
  parseDailyRestingHrCsv,
  parseDailyVitalCsv,
  parseVendorScoreCsv,
  FITBIT_SLEEP_SCORE_METRIC,
  FITBIT_READINESS_SCORE_METRIC,
  NEVER_READ,
} from "@/lib/integrations/fitbit-takeout";

// Every fixture below is the REAL header/row shape of a Fitbit Takeout export
// (`Takeout/Google Health/…`), with synthetic values — the formats are what the
// parser has to survive, and they are not uniform.

const TZ = "America/New_York";
const P = "Takeout/Google Health";

describe("classifyTakeoutEntry", () => {
  it("never reads the two bulk ML directories", () => {
    // ~81% of a real archive's bytes. The point of classifying by PATH is that the
    // walker can skip these without reading a byte.
    for (const seg of NEVER_READ) {
      expect(
        classifyTakeoutEntry(`${P}/Health Fitness Data_GoogleData/${seg}_1.csv`)
      ).toBeNull();
    }
  });

  it("skips the JSON twins of CSV-preferred families", () => {
    // Global Export Data carries a second copy of steps/distance/calories/HR in
    // local-wall-time JSON. Parsing both would double-count.
    for (const f of ["steps", "distance", "calories", "heart_rate"]) {
      expect(
        classifyTakeoutEntry(`${P}/Global Export Data/${f}-2026-06-09.json`)
      ).toBeNull();
    }
  });

  it("still reads the families that exist ONLY as JSON", () => {
    expect(
      classifyTakeoutEntry(`${P}/Global Export Data/sleep-2026-06-09.json`)
    ).toBe("sleep");
    expect(
      classifyTakeoutEntry(`${P}/Global Export Data/exercise-0.json`)
    ).toBe("exercise");
  });

  it("resolves the dated and undated CSV families", () => {
    const cases: [string, string][] = [
      ["Physical Activity_GoogleData/weight.csv", "weight"],
      ["Physical Activity_GoogleData/body_fat_2018-06-01.csv", "body_fat"],
      [
        "Physical Activity_GoogleData/daily_resting_heart_rate.csv",
        "daily_resting_heart_rate",
      ],
      [
        "Physical Activity_GoogleData/daily_respiratory_rate.csv",
        "daily_respiratory_rate",
      ],
      [
        "Physical Activity_GoogleData/daily_oxygen_saturation.csv",
        "daily_oxygen_saturation",
      ],
      ["Physical Activity_GoogleData/daily_readiness.csv", "daily_readiness"],
      [
        "Temperature/Computed Temperature - 2026-06-10.csv",
        "computed_temperature",
      ],
      ["Sleep Score/sleep_score.csv", "sleep_score"],
    ];
    for (const [rel, fam] of cases) {
      expect(classifyTakeoutEntry(`${P}/${rel}`), rel).toBe(fam);
    }
  });

  it("skips readmes, foreign roots, and anything unrecognized", () => {
    expect(
      classifyTakeoutEntry(`${P}/Biometrics/Biometrics Readme.txt`)
    ).toBeNull();
    expect(classifyTakeoutEntry("Takeout/YouTube/history.json")).toBeNull();
    expect(classifyTakeoutEntry(`${P}/Discover/something-new.csv`)).toBeNull();
  });
});

describe("isHealthConnectRoundTrip", () => {
  // Fitbit re-exports rows it INGESTED from Health Connect. Allos already holds
  // those under the health-connect provider; taking them again would store one
  // measurement twice under two sources.
  it("matches any vendor prefix on the ' Health Connect' tail", () => {
    for (const s of [
      "Phone Health Connect",
      "Garmin Connect Health Connect",
      "Strava Health Connect",
      "Unknown Health Connect",
      "Life Fitness Health Connect",
    ]) {
      expect(isHealthConnectRoundTrip(s), s).toBe(true);
    }
  });

  it("does not match Fitbit's own first-party sources", () => {
    for (const s of [
      "Radiance",
      "Fitbit App",
      "Renpho Fitbit 3P Web API",
      null,
    ]) {
      expect(isHealthConnectRoundTrip(s), String(s)).toBe(false);
    }
  });
});

describe("parseTakeoutCsv + csvNum", () => {
  it("treats the 'no data' sentinel as empty, not as a row", () => {
    // Glucose ships as 230 files each containing exactly this.
    expect(parseTakeoutCsv("no data")).toBeNull();
    expect(parseTakeoutCsv("  no data \n")).toBeNull();
  });

  it("treats a header-only file as empty", () => {
    expect(parseTakeoutCsv("timestamp,value,data source")).toBeNull();
  });

  it("drops a row whose field count disagrees with the header", () => {
    const r = parseTakeoutCsv("a,b\n1,2\n3\n4,5")!;
    expect(r.rows).toEqual([
      { a: "1", b: "2" },
      { a: "4", b: "5" },
    ]);
  });

  it("reads Fitbit's literal NaN as absent, never as 0", () => {
    expect(csvNum("NaN")).toBeNull();
    expect(csvNum("")).toBeNull();
    expect(csvNum(undefined)).toBeNull();
    expect(csvNum("33.336")).toBe(33.336);
  });
});

describe("localDate — three timestamp formats in one archive", () => {
  it("converts an absolute instant through the profile zone", () => {
    // 02:11Z is the previous evening in New York.
    expect(localDate("2026-07-26T02:11:30Z", TZ)).toBe("2026-07-25");
  });

  it("takes a BARE day verbatim (daily_readiness)", () => {
    // Through new Date() this is UTC midnight → 2026-06-15 in New York, an
    // off-by-one on every readiness score.
    expect(localDate("2026-06-16", TZ)).toBe("2026-06-16");
  });

  it("takes an offset-less wall time's date part verbatim", () => {
    // Parsing this would make the answer depend on the SERVER's timezone.
    expect(localDate("2026-06-11T00:00:00", TZ)).toBe("2026-06-11");
    expect(localDate("2026-06-10T22:13", TZ)).toBe("2026-06-10");
  });

  it("rejects unparseable input", () => {
    expect(localDate("", TZ)).toBeNull();
    expect(localDate("not-a-date", TZ)).toBeNull();
    expect(localDate(undefined, TZ)).toBeNull();
  });
});

describe("body composition — the archive's uniquely deep data", () => {
  const WEIGHT = [
    "timestamp,weight grams,data source",
    "2018-05-28T13:30:12Z,62400,Renpho Fitbit 3P Web API",
    "2026-07-26T10:12:44Z,64900,Renpho Fitbit 3P Web API",
  ].join("\n");

  it("converts grams to canonical kg, one row per local day", () => {
    const out = parseWeightCsv(WEIGHT, TZ);
    expect(out.bodyMetrics).toEqual([
      { date: "2018-05-28", weight_kg: 62.4 },
      { date: "2026-07-26", weight_kg: 64.9 },
    ]);
    expect(out.skipped).toBe(0);
  });

  it("keeps the LAST reading of a day", () => {
    const out = parseWeightCsv(
      [
        "timestamp,weight grams,data source",
        "2026-07-26T08:00:00Z,64900,Fitbit App",
        "2026-07-26T20:00:00Z,65300,Fitbit App",
      ].join("\n"),
      TZ
    );
    expect(out.bodyMetrics).toEqual([{ date: "2026-07-26", weight_kg: 65.3 }]);
  });

  it("drops a Health-Connect round-trip row and counts it separately", () => {
    const out = parseWeightCsv(
      [
        "timestamp,weight grams,data source",
        "2026-07-26T08:00:00Z,64900,Phone Health Connect",
      ].join("\n"),
      TZ
    );
    expect(out.bodyMetrics).toEqual([]);
    expect(out.roundTripSkipped).toBe(1);
    // NOT counted as a malformed skip — "you already have this" is a different fact.
    expect(out.skipped).toBe(0);
  });

  it("drops a physiologically impossible weight (#132)", () => {
    const out = parseWeightCsv(
      [
        "timestamp,weight grams,data source",
        "2026-07-26T08:00:00Z,5000000,Fitbit App",
      ].join("\n"),
      TZ
    );
    expect(out.bodyMetrics).toEqual([]);
    expect(out.skipped).toBe(1);
  });

  it("reads body fat percent under its real column name", () => {
    const out = parseBodyFatCsv(
      [
        "timestamp,body fat percentage,data source",
        "2018-06-01T13:16:20Z,11.6,Renpho Fitbit 3P Web API",
      ].join("\n"),
      TZ
    );
    expect(out.bodyMetrics).toEqual([
      { date: "2018-06-01", body_fat_pct: 11.6 },
    ]);
  });
});

describe("daily vitals", () => {
  it("rounds fractional resting HR to a whole bpm", () => {
    const out = parseDailyRestingHrCsv(
      [
        "timestamp,beats per minute,data source",
        "2026-06-10T00:00:00Z,66.876,Fitbit App",
      ].join("\n"),
      TZ
    );
    // 00:00Z is the previous evening in New York.
    expect(out.bodyMetrics).toEqual([{ date: "2026-06-09", resting_hr: 67 }]);
  });

  it("maps respiratory rate to the SAME canonical the HC parser writes", () => {
    const out = parseDailyVitalCsv(
      [
        "timestamp,breaths per minute,data source",
        "2026-06-11T12:00:00Z,13.8,Fitbit App",
      ].join("\n"),
      TZ,
      "respiratory_rate"
    );
    expect(out.vitals).toEqual([
      {
        external_id: "fitbit-takeout:Respiratory Rate:2026-06-11T12:00:00Z",
        date: "2026-06-11",
        category: "vitals",
        name: "Respiratory Rate",
        canonical: "Respiratory Rate",
        value_num: 13.8,
        unit: "breaths/min",
      },
    ]);
  });

  it("takes the daily SpO2 aggregate", () => {
    const out = parseDailyVitalCsv(
      [
        "timestamp,average percentage,lower bound percentage,upper bound percentage,baseline percentage,standard deviation percentage,data source",
        "2026-06-11T12:00:00Z,94.8,93.2,96.5,0.0,0.0,Radiance",
      ].join("\n"),
      TZ,
      "oxygen_saturation"
    );
    expect(out.vitals[0]).toMatchObject({
      canonical: "Oxygen Saturation",
      value_num: 94.8,
      unit: "%",
    });
  });
});

describe("vendor daily scores (extends #1069)", () => {
  it("stores Fitbit's sleep score under a VENDOR-PREFIXED kind", () => {
    const out = parseVendorScoreCsv(
      [
        "sleep_log_entry_id,timestamp,overall_score,composition_score,revitalization_score,duration_score,deep_sleep_in_minutes,resting_heart_rate,restlessness",
        "53134724310,2026-07-26T12:00:00Z,48,,48,,58,63,0.152",
      ].join("\n"),
      TZ,
      "sleep_score"
    );
    expect(out.samples).toEqual([
      {
        metric: FITBIT_SLEEP_SCORE_METRIC,
        date: "2026-07-26",
        start_time: "2026-07-26T00:00:00.000Z",
        end_time: "2026-07-26T00:00:00.000Z",
        value: 48,
      },
    ]);
    // The kind must never be a bare "sleep_score" — that namespace is the app's.
    expect(FITBIT_SLEEP_SCORE_METRIC).toBe("fitbit_sleep_score");
  });

  it("reads readiness from its BARE-DAY timestamp without shifting the day", () => {
    const out = parseVendorScoreCsv(
      [
        "timestamp,score,type,readiness level,sleep readiness,heart rate variability readiness,resting heart rate readiness,data source",
        "2026-06-16,76,HIGH,TYPE_UNSPECIFIED,VERY_HIGH,HIGH,HIGH,Fitbit App",
      ].join("\n"),
      TZ,
      "daily_readiness"
    );
    expect(out.samples).toEqual([
      {
        metric: FITBIT_READINESS_SCORE_METRIC,
        date: "2026-06-16",
        start_time: "2026-06-16T00:00:00.000Z",
        end_time: "2026-06-16T00:00:00.000Z",
        value: 76,
      },
    ]);
  });

  it("drops an out-of-range score rather than storing a bogus one", () => {
    const out = parseVendorScoreCsv(
      ["timestamp,score,data source", "2026-06-16,410,Fitbit App"].join("\n"),
      TZ,
      "daily_readiness"
    );
    expect(out.samples).toEqual([]);
    expect(out.skipped).toBe(1);
  });
});

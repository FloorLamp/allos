import { describe, expect, it } from "vitest";
import {
  CARDIO_ACTIVITIES,
  RECOVERY_ACTIVITIES,
  SPORTS,
} from "@/lib/activities-catalog";
import { zonedDateParts } from "@/lib/date";
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
  parseComputedTemperatureCsv,
  parseExerciseJson,
  fitbitActivityIdentity,
  fitbitComponentName,
  parseSleepJson,
  hhmmToMinutes,
  minutesToHhmm,
  parseHeartRateCsv,
  parseIntradaySumCsv,
  foldHrBuckets,
  foldDailySums,
  finalizeHrBuckets,
  finalizeDailySums,
  intradaySumMetric,
  type HrBucketAcc,
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
  it("rounds fractional resting HR, and keeps the day Fitbit LABELLED", () => {
    const out = parseDailyRestingHrCsv(
      [
        "timestamp,beats per minute,data source",
        "2026-06-10T00:00:00Z,66.876,Fitbit App",
      ].join("\n"),
      TZ
    );
    // Midnight UTC is a LABEL for the day, not the instant of a measurement.
    // Converting it through New York would walk it back to 06-09 — the exact
    // one-day offset that showed up against the same readings from Health Connect.
    expect(out.bodyMetrics).toEqual([{ date: "2026-06-10", resting_hr: 67 }]);
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

describe("intraday: heart rate", () => {
  // ~1.6M rows across 47 files in a real archive, sampled every few seconds. Bucketed
  // inside the per-file parse so nothing ever holds them all.
  const HR = [
    "timestamp,beats per minute,data source",
    "2026-06-10T16:37:52Z,133.0,Radiance",
    "2026-06-10T16:37:54Z,137.0,Radiance",
    "2026-06-10T16:38:02Z,120.0,Radiance",
  ].join("\n");

  it("buckets on the sample's own UTC minute with sum/n/min/max", () => {
    const { buckets, skipped, roundTrip } = parseHeartRateCsv(HR, TZ);
    expect(skipped).toBe(0);
    expect(roundTrip).toBe(0);
    // 16:37Z is 12:37 in New York.
    expect(buckets).toEqual([
      { ts: "2026-06-10T16:37:00Z", sum: 270, n: 2, min: 133, max: 137 },
      { ts: "2026-06-10T16:38:00Z", sum: 120, n: 1, min: 120, max: 120 },
    ]);
  });

  it("folds a minute split across two files instead of overwriting it", () => {
    // A day-boundary minute appears in both days' files; averaging an average or
    // taking the last write would both be wrong.
    const acc = new Map<string, HrBucketAcc>();
    foldHrBuckets(acc, [
      { ts: "2026-06-10T23:59", sum: 120, n: 2, min: 58, max: 62 },
    ]);
    foldHrBuckets(acc, [
      { ts: "2026-06-10T23:59", sum: 200, n: 4, min: 45, max: 55 },
    ]);
    expect(finalizeHrBuckets(acc)).toEqual([
      { ts: "2026-06-10T23:59", bpm: 320 / 6, bpm_min: 45, bpm_max: 62, n: 6 },
    ]);
  });

  it("drops an implausible bpm and counts it, keeping the rest of the minute", () => {
    const { buckets, skipped } = parseHeartRateCsv(
      [
        "timestamp,beats per minute,data source",
        "2026-06-10T16:37:52Z,900,Radiance",
        "2026-06-10T16:37:54Z,70,Radiance",
      ].join("\n"),
      TZ
    );
    expect(skipped).toBe(1);
    expect(buckets).toEqual([
      { ts: "2026-06-10T16:37:00Z", sum: 70, n: 1, min: 70, max: 70 },
    ]);
  });
});

describe("intraday: the summable daily streams", () => {
  it("sums steps per LOCAL day and drops the phone's round-trip rows", () => {
    // The phone counts the same steps the watch does. Those rows are already held
    // under health-connect, so keeping them would double the day AND duplicate the
    // provider — a real archive carries ~9k of them against ~11.5k watch rows.
    const { perDay, roundTrip, skipped } = parseIntradaySumCsv(
      [
        "timestamp,steps,data source",
        "2026-07-20T16:39:00Z,34,Radiance",
        "2026-07-20T16:40:00Z,66,Radiance",
        "2026-07-20T16:39:18.008Z,30,Phone Health Connect",
      ].join("\n"),
      TZ,
      "intraday_steps"
    );
    expect(roundTrip).toBe(1);
    expect(skipped).toBe(0);
    expect([...perDay]).toEqual([["2026-07-20", 100]]);
  });

  it("converts the distance column from metres to canonical km", () => {
    const { perDay } = parseIntradaySumCsv(
      [
        "timestamp,distance,data source",
        "2026-07-20T16:39:00Z,1500.0,Radiance",
        "2026-07-20T16:40:00Z,500.0,Radiance",
      ].join("\n"),
      TZ,
      "intraday_distance"
    );
    expect([...perDay]).toEqual([["2026-07-20", 2]]);
  });

  it("attributes a row to the PROFILE's day, not the UTC day", () => {
    // 2026-07-21T02:00Z is still the evening of 07-20 in New York. Bucketing on the
    // UTC date prefix would move it to the next day.
    const { perDay } = parseIntradaySumCsv(
      ["timestamp,steps,data source", "2026-07-21T02:00:00Z,500,Radiance"].join(
        "\n"
      ),
      TZ,
      "intraday_steps"
    );
    expect([...perDay]).toEqual([["2026-07-20", 500]]);
  });

  it("folds a day that spans two files, then finalizes one sample per day", () => {
    const acc = new Map<string, number>();
    foldDailySums(acc, new Map([["2026-07-20", 4000]]));
    foldDailySums(
      acc,
      new Map([
        ["2026-07-20", 3005],
        ["2026-07-21", 900],
      ])
    );
    const out = finalizeDailySums(acc, "steps");
    expect(out).toEqual([
      {
        metric: "steps",
        date: "2026-07-20",
        start_time: "2026-07-20T00:00:00.000Z",
        end_time: "2026-07-20T23:59:59.999Z",
        value: 7005,
      },
      {
        metric: "steps",
        date: "2026-07-21",
        start_time: "2026-07-21T00:00:00.000Z",
        end_time: "2026-07-21T23:59:59.999Z",
        value: 900,
      },
    ]);
  });

  it("maps each summable family to its canonical metric", () => {
    expect(intradaySumMetric("intraday_steps")).toBe("steps");
    expect(intradaySumMetric("intraday_distance")).toBe("distance_km");
    expect(intradaySumMetric("active_energy")).toBe("active_kcal");
  });
});

describe("intraday classification", () => {
  it("routes the intraday CSVs to their families", () => {
    const c = (f: string) =>
      classifyTakeoutEntry(`${P}/Physical Activity_GoogleData/${f}`);
    expect(c("heart_rate-2026-06-10.csv")).toBe("heart_rate");
    expect(c("steps_2026-06-01.csv")).toBe("intraday_steps");
    expect(c("distance_2026-05-01.csv")).toBe("intraday_distance");
    expect(c("active_energy_burned_2026-06-01.csv")).toBe("active_energy");
  });

  it("REFUSES total calories — the CSV omits resting minutes", () => {
    // Measured: CSV 1,268 kcal over 956 rows against the JSON twin's 2,811 over
    // 1,440. Basal burn never stops, so summing the sparse stream would store ~45%
    // of a day as the whole day. Health Connect already supplies the real total.
    expect(
      classifyTakeoutEntry(
        `${P}/Physical Activity_GoogleData/calories_2026-06-01.csv`
      )
    ).toBeNull();
  });

  it("REFUSES height — a self-reported profile field, not a measurement", () => {
    // Unlike the families below, height HAS a home; it is refused on quality. The
    // real archive carries two rows disagreeing by 6 mm, the signature of a profile
    // field written by two apps. Height feeds BMI and the growth percentiles, so a
    // wrong value propagates quietly into derived numbers — and the user already
    // owns the manual entry. Refused at CLASSIFY time, so the walk never inflates
    // it (measured on the real archive: 75 entries read before, 74 after, with every
    // record count unchanged).
    for (const f of ["height.csv", "height-2026-06-01.csv"]) {
      expect(
        classifyTakeoutEntry(`${P}/Physical Activity_GoogleData/${f}`),
        f
      ).toBeNull();
    }
  });

  it("skips the vendor-classification families with no metric home", () => {
    for (const f of [
      "activity_level_2026-06-01.csv",
      "time_in_heart_rate_zones-2026-06-10.csv",
      "resting_heart_rate-2026-06-09.csv",
    ]) {
      expect(
        classifyTakeoutEntry(`${P}/Physical Activity_GoogleData/${f}`),
        f
      ).toBeNull();
    }
  });
});

describe("computed (nightly) temperature", () => {
  // Real column set and real shapes; values synthetic.
  const HDR =
    "type,sleep_start,sleep_end,temperature_samples,nightly_temperature," +
    "baseline_relative_sample_sum,baseline_relative_sample_sum_of_squares," +
    "baseline_relative_nightly_standard_deviation,baseline_relative_sample_standard_deviation";

  it("derives the mean baseline-relative deviation and dates it to the WAKE day", () => {
    const out = parseComputedTemperatureCsv(
      [
        HDR,
        "IDT,2026-07-25T23:14:30,2026-07-26T06:11:30,404,34.07,189.768,419.6,0.279,0.956",
      ].join("\n"),
      TZ
    );
    // 189.768 / 404 = 0.4697..., stored at the metric's 2dp precision. The night is
    // the one that ENDED on 07-26, matching how sleep totals are attributed.
    expect(out.samples).toEqual([
      {
        metric: "skin_temp_delta_c",
        date: "2026-07-26",
        start_time: "2026-07-26T00:00:00.000Z",
        end_time: "2026-07-26T00:00:00.000Z",
        value: 0.47,
      },
    ]);
    expect(out.skipped).toBe(0);
  });

  it("keeps a NEGATIVE deviation — the normal cool night", () => {
    const out = parseComputedTemperatureCsv(
      [
        HDR,
        "IDT,2026-07-24T22:57:30,2026-07-25T05:22,384,33.54,-25.305,300.5,0.264,0.949",
      ].join("\n"),
      TZ
    );
    expect(out.samples[0].value).toBe(-0.07);
  });

  it("SKIPS a night whose baseline is NaN, never storing it as zero", () => {
    // Fitbit writes literal NaN for the first nights of a device's life, before it
    // has a baseline. Zero would read as a perfectly average night.
    const out = parseComputedTemperatureCsv(
      [
        HDR,
        "IDT,2026-06-10T22:13,2026-06-11T05:41:30,444,33.33,NaN,NaN,NaN,NaN",
      ].join("\n"),
      TZ
    );
    expect(out.samples).toEqual([]);
    expect(out.skipped).toBe(1);
  });

  it("skips a row with no samples rather than dividing by zero", () => {
    const out = parseComputedTemperatureCsv(
      [
        HDR,
        "IDT,2026-07-01T23:00,2026-07-02T06:00,0,33.3,12.0,1.0,0.2,0.9",
      ].join("\n"),
      TZ
    );
    expect(out.samples).toEqual([]);
    expect(out.skipped).toBe(1);
  });

  it("does NOT store the absolute nightly temperature", () => {
    // ~33 °C of wrist temperature is dominated by room and bedding; without a
    // baseline it is not interpretable, which is why both Fitbit and Health Connect
    // surface the delta instead.
    const out = parseComputedTemperatureCsv(
      [
        HDR,
        "IDT,2026-07-25T23:14:30,2026-07-26T06:11:30,404,34.07,189.768,419.6,0.279,0.956",
      ].join("\n"),
      TZ
    );
    expect(out.samples.every((s) => s.metric === "skin_temp_delta_c")).toBe(
      true
    );
    expect(out.samples.map((s) => s.value)).not.toContain(34.07);
  });

  it("writes the SAME metric the Health Connect path does, so they share one series", () => {
    const out = parseComputedTemperatureCsv(
      [
        HDR,
        "IDT,2026-07-25T23:14:30,2026-07-26T06:11:30,404,34.07,189.768,419.6,0.279,0.956",
      ].join("\n"),
      TZ
    );
    expect(out.samples[0].metric).toBe("skin_temp_delta_c");
  });
});

describe("daily aggregates are dated by their LABEL, not by conversion", () => {
  // The bug this pins: Fitbit stamps per-day and per-night aggregates at midnight
  // UTC. That is a label for the day, not an instant. Converting it through a
  // western zone dates every one of them a day early — found by noticing that the
  // Takeout and Health Connect series for respiratory rate were identical but offset
  // by exactly one day (HC dates from a real sleep-end instant, so HC was right).
  const MIDNIGHT_UTC = "2026-06-11T00:00:00Z";

  it("resting HR, respiratory rate and SpO2 all keep the labelled day", () => {
    expect(
      parseDailyRestingHrCsv(
        [
          "timestamp,beats per minute,data source",
          `${MIDNIGHT_UTC},60,Fitbit App`,
        ].join("\n"),
        TZ
      ).bodyMetrics[0].date
    ).toBe("2026-06-11");

    expect(
      parseDailyVitalCsv(
        [
          "timestamp,breaths per minute,data source",
          `${MIDNIGHT_UTC},13.8,Fitbit App`,
        ].join("\n"),
        TZ,
        "respiratory_rate"
      ).vitals[0].date
    ).toBe("2026-06-11");

    expect(
      parseDailyVitalCsv(
        [
          "timestamp,average percentage,data source",
          `${MIDNIGHT_UTC},94.8,Radiance`,
        ].join("\n"),
        TZ,
        "oxygen_saturation"
      ).vitals[0].date
    ).toBe("2026-06-11");
  });

  it("the vendor scores keep it too", () => {
    expect(
      parseVendorScoreCsv(
        ["timestamp,overall_score", `${MIDNIGHT_UTC},48`].join("\n"),
        TZ,
        "sleep_score"
      ).samples[0].date
    ).toBe("2026-06-11");
  });

  it("but a genuine INSTANT still converts — a weigh-in is not a day label", () => {
    // 02:11Z really is the previous evening in New York, and a weigh-in belongs on
    // the day it happened.
    expect(
      parseWeightCsv(
        [
          "timestamp,weight grams,data source",
          "2026-07-26T02:11:30Z,64900,Fitbit App",
        ].join("\n"),
        TZ
      ).bodyMetrics[0].date
    ).toBe("2026-07-25");
  });
});

describe("the archive's TWO timestamp conventions", () => {
  // Getting this backwards is silent, so both halves are pinned.
  it("reads a US-ordered exercise stamp as UTC, converting to the local day", () => {
    // 01:07 UTC is 21:07 the PREVIOUS evening in New York. Read as local it was
    // filed under the 15th — four hours out and on the wrong day.
    const out = parseExerciseJson(
      JSON.stringify([
        {
          logId: 77411312255,
          activityName: "Swim",
          startTime: "06/15/26 01:07:21",
          activeDuration: 1024000,
        },
      ]),
      TZ
    );
    expect(out.activities[0].date).toBe("2026-06-14");
    expect(out.activities[0].start_time).toBe("21:07");
  });

  it("derives an end clock from start + duration, wrapping past midnight", () => {
    const out = parseExerciseJson(
      JSON.stringify([
        {
          logId: 1,
          activityName: "Outdoor Bike",
          startTime: "06/13/26 13:05:01",
          activeDuration: 125 * 60000,
        },
      ]),
      TZ
    );
    // 13:05 UTC -> 09:05 local, + 125 min -> 11:10. Without an end there is no
    // window for the duplicate detector's high-confidence overlap path.
    expect(out.activities[0].start_time).toBe("09:05");
    expect(out.activities[0].end_time).toBe("11:10");
  });

  it("adds one canonical component to each Fitbit exercise summary", () => {
    const out = parseExerciseJson(
      JSON.stringify([
        {
          logId: 1,
          activityName: "Walk",
          startTime: "06/13/26 13:05:01",
          activeDuration: 20 * 60000,
        },
        {
          logId: 2,
          activityName: "Outdoor Bike",
          startTime: "06/13/26 14:05:01",
          activeDuration: 40 * 60000,
          distance: 10,
          distanceUnit: "Kilometer",
        },
        {
          logId: 3,
          activityName: "Swim",
          startTime: "06/13/26 15:05:01",
          activeDuration: 15 * 60000,
          distance: 500,
          distanceUnit: "Meter",
        },
        {
          logId: 4,
          activityName: "Spinning",
          startTime: "06/13/26 16:05:01",
          activeDuration: 50 * 60000,
        },
      ]),
      TZ
    );

    expect(out.activities.map((a) => a.components)).toEqual([
      [
        {
          name: "Walking",
          type: "cardio",
          distance_km: null,
          duration_min: 20,
        },
      ],
      [
        {
          name: "Cycling",
          type: "cardio",
          distance_km: 10,
          duration_min: 40,
        },
      ],
      [
        {
          name: "Swimming",
          type: "cardio",
          distance_km: 0.5,
          duration_min: 15,
        },
      ],
      [
        {
          name: "Stationary Bike",
          type: "cardio",
          distance_km: null,
          duration_min: 50,
        },
      ],
    ]);
  });

  it("keeps an unknown Fitbit label intact as its component name", () => {
    expect(fitbitComponentName("Snowshoe Adventure")).toBe(
      "Snowshoe Adventure"
    );
    expect(fitbitComponentName("Spinning")).toBe("Stationary Bike");
  });

  it("classifies every curated activity through the shared taxonomy", () => {
    for (const name of CARDIO_ACTIVITIES) {
      expect(fitbitActivityIdentity(name), name).toEqual({
        name,
        type: "cardio",
      });
    }
    for (const name of SPORTS) {
      expect(fitbitActivityIdentity(name), name).toEqual({
        name,
        type: "sport",
      });
    }
    for (const name of RECOVERY_ACTIVITIES) {
      expect(fitbitActivityIdentity(name), name).toEqual({
        name,
        type: "recovery",
      });
    }
  });

  it("normalizes Fitbit-specific cardio and broad strength labels", () => {
    expect(fitbitActivityIdentity("Indoor Cycling")).toEqual({
      name: "Stationary Bike",
      type: "cardio",
    });
    expect(fitbitActivityIdentity("Stairclimber")).toEqual({
      name: "Stair Climber",
      type: "cardio",
    });
    expect(fitbitActivityIdentity("Jumping rope")).toEqual({
      name: "Jump Rope",
      type: "cardio",
    });
    expect(fitbitActivityIdentity("Rowing Machine")).toEqual({
      name: "Rowing",
      type: "cardio",
    });
    expect(fitbitActivityIdentity("Tabata Workout")).toEqual({
      name: "HIIT",
      type: "cardio",
    });
    expect(fitbitActivityIdentity("Roller blading")).toEqual({
      name: "Rollerblading",
      type: "cardio",
    });
    for (const name of ["Weights", "Weight Training", "Strength Training"]) {
      expect(fitbitActivityIdentity(name), name).toEqual({
        name: "Weight Training",
        type: "strength",
      });
    }
    expect(fitbitActivityIdentity("Bench Press")).toEqual({
      name: "Bench Press",
      type: "strength",
    });
    expect(fitbitActivityIdentity("TRX")).toEqual({
      name: "TRX",
      type: "strength",
    });
  });

  it("uses free-text keywords and keeps truly unknown labels conservative", () => {
    expect(fitbitActivityIdentity("Snowshoe Adventure")).toEqual({
      name: "Snowshoe Adventure",
      type: "cardio",
    });
    expect(fitbitActivityIdentity("Mystery Motion")).toEqual({
      name: "Mystery Motion",
      type: "sport",
    });
  });

  it("routes Fitbit meditation to wellness instead of training", () => {
    const out = parseExerciseJson(
      JSON.stringify([
        {
          logId: 5,
          activityName: "Meditating",
          startTime: "06/13/26 17:05:01",
          activeDuration: 30 * 60000,
        },
      ]),
      TZ
    );
    expect(out.activities).toEqual([]);
    expect(out.practices).toEqual([
      {
        external_id: "fitbit-takeout:5",
        practice: "Meditation",
        date: "2026-06-13",
        time: "13:05",
        duration_min: 30,
      },
    ]);
  });

  it("resolves the LOCAL sleep stamp into the instant it denotes (#2096)", () => {
    // 23:14:30 matches the 23:23 LOCAL onset Health Connect reports for the same
    // night — the wall clock really is local, which is exactly why it has to be
    // interpreted in the profile zone rather than stored raw. Stored raw, every read
    // path resolved it against the SERVER's zone, so the moment it denoted moved with
    // the container. New York is UTC−4 on that July date, so 23:14:30 local is
    // 03:14:30Z the next day.
    const out = parseSleepJson(
      JSON.stringify([
        {
          logId: 1,
          dateOfSleep: "2026-07-26",
          startTime: "2026-07-25T23:14:30.000",
          endTime: "2026-07-26T06:11:30.000",
          duration: 25020000,
          levels: { summary: { deep: { minutes: 58 } } },
        },
      ]),
      TZ
    );
    const total = out.samples.find((x) => x.metric === "sleep_min")!;
    // The wake day is `dateOfSleep`, stated by the vendor, and must NOT start moving.
    expect(total.date).toBe("2026-07-26");
    expect(total.start_time).toBe("2026-07-26T03:14:30.000Z");
    expect(total.end_time).toBe("2026-07-26T10:11:30.000Z");
    // …and reading it back in the profile zone returns the clock Fitbit wrote,
    // seconds included: the conversion is lossless, not a truncation to the minute.
    expect(zonedDateParts(TZ, new Date(total.start_time))).toMatchObject({
      date: "2026-07-25",
      hhmm: "23:14",
    });
  });

  it("parses to the same instant whatever the SERVER's timezone is", () => {
    // The assertion the bug fails, and the one that matters operationally: the
    // container's TZ is not a property of the data. Production is Docker (UTC);
    // a developer's machine is not.
    const log = JSON.stringify([
      {
        logId: 1,
        dateOfSleep: "2026-07-26",
        startTime: "2026-07-25T23:14:30.000",
        endTime: "2026-07-26T06:11:30.000",
        duration: 25020000,
      },
    ]);
    const prev = process.env.TZ;
    try {
      const under = (serverTz: string) => {
        process.env.TZ = serverTz;
        const s = parseSleepJson(log, TZ).samples[0];
        return [s.start_time, s.end_time, s.date];
      };
      expect(under("UTC")).toEqual(under("America/New_York"));
      expect(under("UTC")).toEqual(under("Asia/Tokyo"));
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it("carries the SAME instant into the stage rows' dedupe key", () => {
    // Stage rows key on `<start>#<stage>`; if the total converted and the stages
    // didn't, one night's rows would split across two start_times.
    const out = parseSleepJson(
      JSON.stringify([
        {
          logId: 1,
          dateOfSleep: "2026-07-26",
          startTime: "2026-07-25T23:14:30.000",
          endTime: "2026-07-26T06:11:30.000",
          duration: 25020000,
          type: "stages",
          levels: { summary: { deep: { minutes: 58 } } },
        },
      ]),
      TZ
    );
    const deep = out.samples.find((x) => x.metric === "sleep_deep_min")!;
    expect(deep.start_time).toBe("2026-07-26T03:14:30.000Z#deep");
    expect(deep.end_time).toBe("2026-07-26T10:11:30.000Z");
  });

  it("refuses an unresolvable boundary instead of guessing one", () => {
    const out = parseSleepJson(
      JSON.stringify([
        {
          logId: 1,
          dateOfSleep: "2026-07-26",
          startTime: "not a timestamp",
          endTime: "2026-07-26T06:11:30.000",
          duration: 25020000,
        },
      ]),
      TZ
    );
    expect(out.samples).toEqual([]);
    expect(out.skipped).toBe(1);
  });

  it("normalizes an already-absolute stamp rather than passing it through", () => {
    // Fitbit does not write one today, but if it ever does the stored key must be the
    // same canonical string either shape produces — otherwise one night lands twice.
    const out = parseSleepJson(
      JSON.stringify([
        {
          logId: 1,
          dateOfSleep: "2026-07-26",
          startTime: "2026-07-25T23:14:30.000-04:00",
          endTime: "2026-07-26T06:11:30.000-04:00",
          duration: 25020000,
        },
      ]),
      TZ
    );
    expect(out.samples[0].start_time).toBe("2026-07-26T03:14:30.000Z");
  });

  it("wraps an end clock past midnight rather than rolling the date", () => {
    expect(minutesToHhmm(hhmmToMinutes("23:30") + 90)).toBe("01:00");
    expect(minutesToHhmm(hhmmToMinutes("09:05") + 125)).toBe("11:10");
  });
});

describe("classic (unstaged) sleep logs", () => {
  // Fitbit scores naps and older-tracker sessions as `classic`, whose summary uses
  // restless / awake / asleep — a different vocabulary from deep / light / rem /
  // wake. Mapping by shared key name would take `awake` and drop the other two.
  const CLASSIC = JSON.stringify([
    {
      logId: 1,
      dateOfSleep: "2026-06-13",
      startTime: "2026-06-13T13:20:00.000",
      endTime: "2026-06-13T14:34:00.000",
      duration: 74 * 60000,
      type: "classic",
      mainSleep: false,
      levels: {
        summary: {
          restless: { minutes: 12 },
          awake: { minutes: 2 },
          asleep: { minutes: 60 },
        },
      },
    },
  ]);

  it("takes the TOTAL but refuses the incomparable breakdown", () => {
    const out = parseSleepJson(CLASSIC, TZ);
    expect(out.samples).toEqual([
      {
        metric: "sleep_min",
        date: "2026-06-13",
        start_time: "2026-06-13T17:20:00.000Z",
        end_time: "2026-06-13T18:34:00.000Z",
        value: 74,
      },
    ]);
    // Specifically NOT an awake-only breakdown with nothing behind it.
    expect(out.samples.some((x) => x.metric === "sleep_awake_min")).toBe(false);
  });

  it("still takes the full breakdown from a stage-scored log", () => {
    const out = parseSleepJson(
      JSON.stringify([
        {
          logId: 2,
          dateOfSleep: "2026-07-26",
          startTime: "2026-07-25T23:14:30.000",
          endTime: "2026-07-26T06:11:30.000",
          duration: 417 * 60000,
          type: "stages",
          levels: {
            summary: {
              deep: { minutes: 58 },
              wake: { minutes: 91 },
              light: { minutes: 245 },
              rem: { minutes: 23 },
            },
          },
        },
      ]),
      TZ
    );
    const stages = out.samples.filter((x) => x.metric !== "sleep_min");
    expect(stages.map((x) => x.metric).sort()).toEqual([
      "sleep_awake_min",
      "sleep_deep_min",
      "sleep_light_min",
      "sleep_rem_min",
    ]);
    // The breakdown sums to the session it belongs to.
    expect(stages.reduce((a, x) => a + x.value, 0)).toBe(417);
  });
});

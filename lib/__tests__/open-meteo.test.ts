import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseOpenMeteoHourly,
  parseOpenMeteoDaily,
  parseOpenMeteoAirQuality,
  mergeDailyRows,
  chooseEndpoint,
  ARCHIVE_LAG_DAYS,
  AIR_QUALITY_FORECAST_DAYS,
  airQualityEndDate,
  openMeteoFetchDaily,
  openMeteoFetch,
} from "../integrations/open-meteo";

// A synthetic Open-Meteo hourly response (both forecast + archive share this shape).
const FIXTURE = {
  latitude: 40.7,
  longitude: -74,
  timezone: "America/New_York",
  hourly: {
    time: ["2026-07-20T10:00", "2026-07-20T11:00", "2026-07-20T12:00"],
    uv_index: [3.2, 6.1, 7.4],
    uv_index_clear_sky: [3.5, 6.4, 7.8],
    shortwave_radiation: [420.0, 610.0, 720.0],
    direct_radiation: [300.0, 480.0, 560.0],
    diffuse_radiation: [120.0, 130.0, 160.0],
    precipitation: [0.0, 2.4, 0.1],
  },
};

describe("parseOpenMeteoHourly", () => {
  it("parses time + all UV/irradiance/precipitation columns into rows", () => {
    const rows = parseOpenMeteoHourly(FIXTURE);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({
      hourTs: "2026-07-20T11:00",
      uvIndex: 6.1,
      uvIndexClearSky: 6.4,
      shortwaveRadiation: 610.0,
      directRadiation: 480.0,
      diffuseRadiation: 130.0,
      precipitationMm: 2.4,
    });
  });

  it("normalizes the time to a top-of-hour key", () => {
    const rows = parseOpenMeteoHourly({
      hourly: { time: ["2026-07-20T11:30"], uv_index: [5] },
    });
    expect(rows[0].hourTs).toBe("2026-07-20T11:00");
  });

  it("tolerates a missing variable array (field → null)", () => {
    const rows = parseOpenMeteoHourly({
      hourly: { time: ["2026-07-20T10:00"], uv_index: [4] },
    });
    expect(rows[0].uvIndex).toBe(4);
    expect(rows[0].uvIndexClearSky).toBeNull();
    expect(rows[0].shortwaveRadiation).toBeNull();
    // Precipitation (#1967) degrades the same way: a hour the provider didn't return it
    // for is null, and the wet-park description then renders no timing at all.
    expect(rows[0].precipitationMm).toBeNull();
  });

  it("returns [] for a body with no hourly.time", () => {
    expect(parseOpenMeteoHourly({})).toEqual([]);
    expect(parseOpenMeteoHourly(null)).toEqual([]);
    expect(parseOpenMeteoHourly({ hourly: {} })).toEqual([]);
  });

  it("skips a non-numeric UV value as null (keeps the row)", () => {
    const rows = parseOpenMeteoHourly({
      hourly: { time: ["2026-07-20T10:00"], uv_index: [null] },
    });
    expect(rows[0].uvIndex).toBeNull();
  });
});

describe("chooseEndpoint — archive vs forecast by date", () => {
  const today = "2026-07-20";
  it("uses the forecast endpoint for recent/future dates", () => {
    expect(chooseEndpoint(today, today)).toBe("forecast");
    expect(chooseEndpoint("2026-07-25", today)).toBe("forecast");
    // Within the archive lag → still forecast (archive doesn't have it yet).
    expect(chooseEndpoint("2026-07-16", today)).toBe("forecast");
  });

  it("uses the historical archive for dates older than the lag", () => {
    // 10 days ago is safely older than ARCHIVE_LAG_DAYS.
    expect(ARCHIVE_LAG_DAYS).toBeGreaterThan(0);
    expect(chooseEndpoint("2026-07-01", today)).toBe("archive");
  });
});

// ---- The DAILY substrate (#1726) ---------------------------------------------------

// A synthetic daily response: the `daily` block the forecast/archive endpoints publish,
// plus the hourly `pressure_msl` column the parser means per local day (Open-Meteo has
// no daily pressure aggregate).
const DAILY_FIXTURE = {
  daily: {
    time: ["2026-07-20", "2026-07-21"],
    temperature_2m_max: [33.4, 29.1],
    temperature_2m_min: [21.0, 19.5],
    precipitation_sum: [0, 4.2],
    weather_code: [0, 61],
    uv_index_max: [8.1, 4.4],
  },
  hourly: {
    time: [
      "2026-07-20T00:00",
      "2026-07-20T12:00",
      "2026-07-21T00:00",
      "2026-07-21T12:00",
    ],
    pressure_msl: [1012, 1016, 1000, 1004],
  },
};

// The air-quality endpoint is a separate host with hourly-only variables; the parser
// reduces each day to its PEAK, because "was pollen high that day" is a question about
// the day's worst hour.
const AIR_FIXTURE = {
  hourly: {
    time: ["2026-07-20T08:00", "2026-07-20T15:00", "2026-07-21T08:00"],
    us_aqi: [42, 118, 30],
    birch_pollen: [10, 12, 0],
    alder_pollen: [95, 20, 0],
    grass_pollen: [3, 8, 1],
    ragweed_pollen: [0, 0, 0],
    mugwort_pollen: [null, null, null],
  },
};

describe("parseOpenMeteoDaily (#1726)", () => {
  it("parses the daily block and means hourly pressure per local day", () => {
    const rows = parseOpenMeteoDaily(DAILY_FIXTURE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: "2026-07-20",
      tempMaxC: 33.4,
      tempMinC: 21.0,
      precipitationMm: 0,
      weatherCode: 0,
      uvIndexMax: 8.1,
    });
    // (1012 + 1016) / 2 and (1000 + 1004) / 2 — a MEAN, so one gusty hour can't read as
    // a front passing through.
    expect(rows[0].pressureMslHpa).toBe(1014);
    expect(rows[1].pressureMslHpa).toBe(1002);
  });

  it("tolerates a body with only one of the two blocks", () => {
    expect(
      parseOpenMeteoDaily({ daily: DAILY_FIXTURE.daily })[0].pressureMslHpa
    ).toBeNull();
    const pressureOnly = parseOpenMeteoDaily({ hourly: DAILY_FIXTURE.hourly });
    expect(pressureOnly).toHaveLength(2);
    expect(pressureOnly[0].tempMaxC).toBeNull();
  });

  it("returns nothing for an empty or malformed body", () => {
    expect(parseOpenMeteoDaily({})).toEqual([]);
    expect(parseOpenMeteoDaily(null)).toEqual([]);
    expect(parseOpenMeteoDaily({ daily: { time: "nope" } })).toEqual([]);
  });

  it("skips a non-date row rather than emitting a junk key", () => {
    const rows = parseOpenMeteoDaily({
      daily: {
        time: ["2026-07-20", "not-a-date"],
        temperature_2m_max: [30, 31],
      },
    });
    expect(rows.map((r) => r.date)).toEqual(["2026-07-20"]);
  });
});

describe("parseOpenMeteoAirQuality (#1726)", () => {
  it("reduces hourly readings to the day's peak, per pollen FAMILY", () => {
    const rows = parseOpenMeteoAirQuality(AIR_FIXTURE);
    expect(rows.map((r) => r.date)).toEqual(["2026-07-20", "2026-07-21"]);
    expect(rows[0].aqi).toBe(118);
    // Tree = max(birch, alder, olive) across the day → alder's 95, not birch's 12.
    expect(rows[0].pollenTree).toBe(95);
    expect(rows[0].pollenGrass).toBe(8);
    // Every weed species reported zero — a real reading of zero, not absence.
    expect(rows[0].pollenWeed).toBe(0);
  });

  it("leaves a family null when the provider reported nothing for it", () => {
    const rows = parseOpenMeteoAirQuality({
      hourly: { time: ["2026-07-20T08:00"], us_aqi: [55] },
    });
    expect(rows[0].aqi).toBe(55);
    expect(rows[0].pollenTree).toBeNull();
    expect(rows[0].pollenGrass).toBeNull();
    expect(rows[0].pollenWeed).toBeNull();
  });

  it("returns nothing for an empty body", () => {
    expect(parseOpenMeteoAirQuality({})).toEqual([]);
  });
});

describe("mergeDailyRows (#1726)", () => {
  it("merges the two halves without either overwriting the other's fields", () => {
    const merged = mergeDailyRows(
      parseOpenMeteoDaily(DAILY_FIXTURE),
      parseOpenMeteoAirQuality(AIR_FIXTURE)
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      date: "2026-07-20",
      tempMaxC: 33.4,
      aqi: 118,
      pollenTree: 95,
    });
  });

  it("still yields a row for a date present in only one half", () => {
    const merged = mergeDailyRows(parseOpenMeteoDaily(DAILY_FIXTURE), [
      {
        date: "2026-07-22",
        tempMaxC: null,
        tempMinC: null,
        pressureMslHpa: null,
        precipitationMm: null,
        weatherCode: null,
        uvIndexMax: null,
        aqi: 90,
        pollenTree: null,
        pollenGrass: null,
        pollenWeed: null,
      },
    ]);
    expect(merged.map((r) => r.date)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
    ]);
    expect(merged[2].aqi).toBe(90);
    expect(merged[2].tempMaxC).toBeNull();
  });
});

// ── The two endpoints do not share a horizon (#3007) ────────────────────────
//
// `runWeatherSync` computes ONE window end (today + WEATHER_FORECAST_DAYS = today + 7,
// which the outdoor-viability scan needs) and the source sent it to BOTH endpoints. The
// weather host publishes 16 days and answered; the air-quality host publishes 7
// COUNTING TODAY — last valid end_date today + 6 — and answered 400, deterministically,
// on every run since the daily half shipped. Nothing said so, because an air-quality
// failure degrades rather than failing the run, so the AQI/pollen columns were empty
// from the day they were added and every predicate over them was silently dataless.

describe("airQualityEndDate (#3007)", () => {
  it("clamps a window that reaches past the air-quality ceiling to today + 6", () => {
    // The exact production shape: today + 7 asked, today + 6 is the ceiling.
    expect(airQualityEndDate("2026-08-23", "2026-08-16")).toBe("2026-08-22");
  });

  it("is a CLAMP, not an assignment — a shorter window keeps its own end", () => {
    // The acceptance criterion that stops this becoming a widening: an archival
    // backfill whose window ends in the past must not be pushed forward to the ceiling.
    expect(airQualityEndDate("2026-08-18", "2026-08-16")).toBe("2026-08-18");
    expect(airQualityEndDate("2026-01-04", "2026-08-16")).toBe("2026-01-04");
  });

  it("leaves the ceiling day itself alone (the boundary is inclusive)", () => {
    expect(airQualityEndDate("2026-08-22", "2026-08-16")).toBe("2026-08-22");
  });

  it("crosses a month end correctly", () => {
    expect(airQualityEndDate("2026-09-07", "2026-08-31")).toBe("2026-09-06");
  });

  it("the ceiling is 7 days COUNTING TODAY", () => {
    const today = "2026-08-16";
    expect(airQualityEndDate("2030-01-01", today)).toBe("2026-08-22");
    expect(AIR_QUALITY_FORECAST_DAYS).toBe(7);
  });
});

describe("openMeteoFetchDaily sends each endpoint its OWN end_date (#3007)", () => {
  const OK_BODY = { daily: { time: [] }, hourly: { time: [] } };

  function stubJsonFetch(): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify(OK_BODY), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    return urls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks weather for today+7 and air quality for today+6 — the regression fixture", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-16T09:00:00Z"));
    const urls = stubJsonFetch();

    return openMeteoFetchDaily(
      40.7,
      -74,
      "2026-08-03",
      "2026-08-23",
      "America/New_York"
    ).then((res) => {
      expect(res.ok).toBe(true);
      expect(urls).toHaveLength(2);

      const weather = new URL(urls[0]);
      expect(weather.host).toBe("api.open-meteo.com");
      // The weather half is UNCHANGED: the planning surfaces genuinely use +7.
      expect(weather.searchParams.get("end_date")).toBe("2026-08-23");
      expect(weather.searchParams.get("start_date")).toBe("2026-08-03");

      const air = new URL(urls[1]);
      expect(air.host).toBe("air-quality-api.open-meteo.com");
      // …and this one is the day that was always out of range.
      expect(air.searchParams.get("end_date")).toBe("2026-08-22");
      // Same start: the air-quality archive reaches back to 2013, so only the
      // forward edge was ever the problem.
      expect(air.searchParams.get("start_date")).toBe("2026-08-03");
    });
  });

  it("carries the air-quality half's status without rendering it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-16T09:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("air-quality")
          ? new Response("nope", { status: 400 })
          : new Response(JSON.stringify(OK_BODY), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
      )
    );
    const res = await openMeteoFetchDaily(
      40.7,
      -74,
      "2026-08-03",
      "2026-08-23",
      "America/New_York"
    );
    // Still not a run failure — the degradation posture is unchanged.
    expect(res.ok).toBe(true);
    // The status is carried so the sync can tell a deterministic 4xx from a
    // transient 5xx instead of promising a retry that cannot help. It is NOT
    // rendered (#3639) — the two halves of that sentence are the whole rule.
    expect(res.ok && res.partialStatus).toBe(400);
    expect(res.ok && res.partial).not.toMatch(/\d/);
  });

  // ── The vendor's own sentence survives the rejection — IN THE LOG (#3007/#3639) ──
  //
  // #3007: a rejected air-quality request reduced to a bare status is why eight
  // production runs said nothing about WHY, and why the cause needed a hand-run curl.
  // Open-Meteo's own `reason` names the parameter, the rule and the CURRENT ceiling, so
  // the next time that ceiling moves the failure diagnoses itself.
  //
  // #3639 then ruled that no HTTP status and no upstream body may reach a user-facing
  // surface at all — the `.details` note included. Both halves of #3007 are therefore
  // kept and MOVED: every assertion below reads the LOG, and the rendered line is
  // asserted to carry neither the number nor the body. The location scrubbing is
  // load-bearing exactly as before, because home location must never be written to any
  // log either (lib/settings/location.ts).
  describe("a rejected request sends what the host said to the log", () => {
    // Captures console.error for the duration of one fetch, so the assertions can
    // read the diagnosis where it now lives. Returns the fetch result beside it.
    async function stubAirQualityFailure(status: number, body: BodyInit) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-16T09:00:00Z"));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          String(url).includes("air-quality")
            ? new Response(body, { status })
            : new Response(JSON.stringify(OK_BODY), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
        )
      );
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
      try {
        const res = await openMeteoFetchDaily(
          40.7,
          -74,
          "2026-08-03",
          "2026-08-23",
          "America/New_York"
        );
        return { res, logged: lines.join("\n") };
      } finally {
        spy.mockRestore();
      }
    }

    function stubTotalFailure(reason: string) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-16T09:00:00Z"));
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: true, reason }), {
              status: 400,
            })
        )
      );
    }

    it("logs Open-Meteo's `reason` and renders neither it nor the status", async () => {
      // The verbatim body shape the live host returns for an out-of-range window.
      const { res, logged } = await stubAirQualityFailure(
        400,
        JSON.stringify({
          error: true,
          reason:
            "Parameter 'end_date' is out of allowed range from 2013-01-01 to 2026-08-22",
        })
      );
      expect(res.ok).toBe(true); // still a partial, not a run failure
      expect(logged).toContain(
        "Parameter 'end_date' is out of allowed range from 2013-01-01 to 2026-08-22"
      );
      expect(logged).toContain("400");
      // The rendered fragment says which half is missing and nothing else.
      expect(res.ok && res.partial).toBe(
        "the air-quality data didn't come back"
      );
    });

    // The reason's SHAPE — vendor JSON, a raw page, an empty body, and the four ways a
    // middlebox echoes the request URI back — decided what reached the card before
    // #3639 and decides what reaches the log now. One table, because these cases
    // differ only in the body that went in and the text that must (or must not) come
    // out the other side.
    it.each([
      {
        what: "falls back to the raw body when it isn't Open-Meteo's JSON",
        status: 502,
        body: "x".repeat(400),
        present: ["xxxx"],
        absent: [] as string[],
      },
      {
        what: "drops a URL a middlebox echoed back, keeping its sentence",
        status: 503,
        body: "Squid error: unable to forward https://air-quality-api.open-meteo.com/v1/air-quality?latitude=40.7&longitude=-74&hourly=us_aqi to the origin",
        present: ["Squid error: unable to forward to the origin"],
        absent: ["40.7", "-74"],
      },
      {
        what: "drops the coordinates even when the echo carries no scheme",
        status: 502,
        body: "Bad gateway while requesting /v1/air-quality?latitude=40.7&longitude=-74&hourly=us_aqi",
        present: ["Bad gateway while requesting"],
        absent: ["40.7", "-74"],
      },
      {
        what: "drops a PERCENT-ENCODED echo of the URI",
        status: 502,
        body: "Bad gateway: could not reach https%3A%2F%2Fair-quality-api.open-meteo.com%2Fv1%2Fair-quality%3Flatitude%3D40.7128%26longitude%3D-74.006",
        present: ["could not reach"],
        absent: ["40.7128", "-74.006"],
      },
      {
        // With a scheme, a URL pattern would catch the whole thing whatever the
        // encoding. This is the shape where the DECODING is what saves it: no
        // `https://` to match, and `latitude%3D` is not `latitude=`.
        what: "drops a percent-encoded echo that carries no scheme either",
        status: 502,
        body: "Bad gateway while requesting %2Fv1%2Fair-quality%3Flatitude%3D40.7128%26longitude%3D-74.006",
        present: ["Bad gateway while requesting"],
        absent: ["40.7128", "-74.006"],
      },
      {
        // The instructive one: a URL pattern that runs first eats the trailing
        // `…?latitude=` and publishes the bare value with no key left to match on.
        // So the parameter strip runs BEFORE the URL strip, and tolerates the break.
        what: "keeps a coordinate bound to its key when the echoed URI WRAPS a line",
        status: 503,
        body: "Squid error: unable to forward\nhttps://air-quality-api.open-meteo.com/v1/air-quality?latitude=\n40.7128&longitude=-74.006\nto the origin",
        present: ["unable to forward"],
        absent: ["40.7128", "-74.006"],
      },
      {
        // The most realistic of the four. A Kong/APIM-style gateway answers with its
        // own JSON — valid, and with no top-level `reason`, so it falls to the raw
        // path where `"latitude":` is not `latitude=`.
        what: "drops coordinates a gateway echoed as JSON FIELDS, not parameters",
        status: 400,
        body: JSON.stringify({
          error: "upstream rejected the request",
          query: { latitude: 40.7128, longitude: -74.006, hourly: "us_aqi" },
        }),
        present: ["upstream rejected the request"],
        absent: ["40.7128", "-74.006"],
      },
      {
        // The value class has to END somewhere. Bounded only by whitespace and `&`, a
        // minified JSON body offers neither after the last parameter, so the match ran
        // to the end of the document and took the diagnosis with it — on exactly the
        // bodies this fallback was added to preserve.
        what: "does not swallow the sentence off the end of a minified body",
        status: 400,
        body: `{"request":{"url":"/v1/air-quality?latitude=40.7128&longitude=-74.006"},"reason":"Parameter 'end_date' is out of allowed range","trace":"${"q".repeat(5000)}"}`,
        present: ["Parameter 'end_date' is out of allowed range"],
        absent: ["40.7128", "-74.006"],
      },
      {
        // The JSON path is deliberately untouched by the stripping above: the sentence
        // #3007 needed is the whole point, and Open-Meteo echoes a parameter only when
        // that parameter is invalid.
        what: "still prefers the vendor's own `reason` over the body around it",
        status: 400,
        body: JSON.stringify({
          error: true,
          reason: "Parameter 'end_date' is out of allowed range",
          generationtime_ms: "z".repeat(400),
        }),
        present: ["Parameter 'end_date' is out of allowed range"],
        absent: ["zzzz"],
      },
      {
        what: "an empty body leaves the log with the status alone",
        status: 400,
        body: "",
        present: ["air-quality fetch rejected"],
        absent: [] as string[],
      },
    ])("$what", async ({ status, body, present, absent }) => {
      const { res, logged } = await stubAirQualityFailure(status, body);
      for (const text of present) expect(logged).toContain(text);
      for (const text of absent) expect(logged).not.toContain(text);
      // WHATEVER the host said, the rendered fragment is the same plain clause: no
      // status, no body, nothing for a person to look up (#3639).
      expect(res.ok && res.partial).toBe(
        "the air-quality data didn't come back"
      );
    });

    it("reads only a bounded prefix of a huge error page", async () => {
      // `res.text()` buffers the WHOLE body before anything is capped: a 64 MB
      // page behind a 502 cost 64 MB of heap to produce 200 characters, on a path
      // that read no body at all before this change. Bound the read, not just the
      // stored string.
      const CHUNK = "x".repeat(20_000);
      const CHUNKS = 500; // ~10 MB if it is all pulled
      let pulled = 0;
      const encoder = new TextEncoder();
      const huge = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= CHUNKS) {
            controller.close();
            return;
          }
          pulled++;
          controller.enqueue(encoder.encode(CHUNK));
        },
      });

      const { logged } = await stubAirQualityFailure(502, huge);
      // The stored reason is still capped, so the log line stays a line.
      expect(logged.length).toBeLessThan(600);
      // THE ASSERTION: the stream was abandoned, not drained.
      expect(pulled).toBeLessThan(10);
    });

    it("the WEATHER half's rejection is the same rule — that one fails the run", async () => {
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
      try {
        stubTotalFailure("Parameter 'daily' has an invalid value");
        const res = await openMeteoFetchDaily(
          40.7,
          -74,
          "2026-08-03",
          "2026-08-23",
          "America/New_York"
        );
        expect(res.ok).toBe(false);
        expect(res.ok === false && res.error).toBe(
          "the daily forecast didn't come back"
        );
        expect(res.ok === false && res.status).toBe(400);
        expect(lines.join("\n")).toContain(
          "Parameter 'daily' has an invalid value"
        );
      } finally {
        spy.mockRestore();
      }
    });

    // THE HOURLY HALF GOT HERE FIRST (#3618). Its failure IS the run's failure, so
    // anything it put on `error` became the sentence the integration card, the "Sync
    // now" toast and the morning digest showed a person — a diagnosis, none of it
    // theirs to act on. It has carried no `error` at all since: the STATUS travels to
    // weather-sync, which writes the house sentence, and #3007's point survives in the
    // log line below. #3639 is the daily half joining it.
    it("the HOURLY fetch sends the host's sentence to the log, not to a reader", async () => {
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
      try {
        stubTotalFailure("Parameter 'hourly' has an invalid value");
        const res = await openMeteoFetch(
          40.7,
          -74,
          "2026-08-03",
          "2026-08-23",
          "America/New_York"
        );
        expect(res.ok).toBe(false);
        expect(res.error).toBeUndefined();
        expect(res.status).toBe(400);
        expect(lines.join("\n")).toContain(
          "Parameter 'hourly' has an invalid value"
        );
      } finally {
        spy.mockRestore();
      }
    });
  });
});

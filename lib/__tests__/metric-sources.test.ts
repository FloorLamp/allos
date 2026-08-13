import { describe, expect, it } from "vitest";
import { DOCUMENTS_SOURCE_CLASS } from "@/lib/metric-source-priority";
import {
  pickOneSourcePerDay,
  pickRowsOneOriginPerSourceDay,
  pickRowsOneSourcePerDay,
  pickRowsOneSourcePerWindow,
  SOURCE_PREFERENCE,
  type SourceSelection,
} from "@/lib/metric-sources";

describe("pickRowsOneOriginPerSourceDay", () => {
  const pick = (
    rows: {
      date: string;
      source: string;
      origin: string | null;
      value: number;
    }[]
  ) =>
    pickRowsOneOriginPerSourceDay(
      rows,
      (row) => row.date,
      (row) => row.source,
      (row) => row.origin,
      (row) => row.value
    );

  it("keeps the largest origin subtotal within one source/day", () => {
    const rows = [
      {
        date: "2026-07-20",
        source: "health-connect",
        origin: "garmin",
        value: 470,
      },
      {
        date: "2026-07-20",
        source: "health-connect",
        origin: "fitbit",
        value: 32.4,
      },
    ];
    expect(pick(rows)).toEqual([rows[0]]);
  });

  it("keeps independent days/sources and treats null origin as a normal group", () => {
    const rows = [
      {
        date: "2026-07-20",
        source: "health-connect",
        origin: null,
        value: 100,
      },
      {
        date: "2026-07-20",
        source: "health-connect",
        origin: "fitbit",
        value: 90,
      },
      {
        date: "2026-07-21",
        source: "health-connect",
        origin: "fitbit",
        value: 50,
      },
      { date: "2026-07-20", source: "strava", origin: null, value: 25 },
    ];
    expect(pick(rows)).toEqual([rows[0], rows[2], rows[3]]);
  });
});

describe("pickOneProviderPerDay", () => {
  it("keeps a single provider per day instead of summing across sources", () => {
    // A day with both Health Connect and Strava active calories must not sum.
    const out = pickOneSourcePerDay(
      [
        { date: "2026-06-15", source: "strava", value: 300 },
        { date: "2026-06-15", source: "health-connect", value: 500 },
      ],
      SOURCE_PREFERENCE
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 500 }]);
  });

  it("falls back to Strava when Health Connect is absent", () => {
    const out = pickOneSourcePerDay(
      [{ date: "2026-06-15", source: "strava", value: 300 }],
      SOURCE_PREFERENCE
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 300 }]);
  });

  it("sums multiple rows from the same chosen provider on a day", () => {
    const out = pickOneSourcePerDay(
      [
        { date: "2026-06-15", source: "strava", value: 300 },
        { date: "2026-06-15", source: "strava", value: 150 },
      ],
      SOURCE_PREFERENCE
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 450 }]);
  });

  it("picks the largest single source when no preferred provider is present", () => {
    const out = pickOneSourcePerDay(
      [
        { date: "2026-06-15", source: "other-a", value: 100 },
        { date: "2026-06-15", source: "other-b", value: 250 },
      ],
      SOURCE_PREFERENCE
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 250 }]);
  });

  it("handles independent days", () => {
    const out = pickOneSourcePerDay(
      [
        { date: "2026-06-15", source: "health-connect", value: 500 },
        { date: "2026-06-16", source: "strava", value: 200 },
      ],
      SOURCE_PREFERENCE
    ).sort((a, b) => a.date.localeCompare(b.date));
    expect(out).toEqual([
      { date: "2026-06-15", value: 500 },
      { date: "2026-06-16", value: 200 },
    ]);
  });
});

describe("default provider preference", () => {
  it("prefers health-connect over strava", () => {
    expect(SOURCE_PREFERENCE.indexOf("health-connect")).toBeLessThan(
      SOURCE_PREFERENCE.indexOf("strava")
    );
  });

  it("prefers a manual entry over any provider, and health-connect over oura", () => {
    expect(SOURCE_PREFERENCE.indexOf("manual")).toBe(0);
    expect(SOURCE_PREFERENCE.indexOf("health-connect")).toBeLessThan(
      SOURCE_PREFERENCE.indexOf("oura")
    );
  });
});

describe("pickOneProviderPerDay — issue #14 additions", () => {
  it("a per-profile primary source prepended to the preference wins the day", () => {
    const out = pickOneSourcePerDay(
      [
        { date: "2026-06-15", source: "oura", value: 300 },
        { date: "2026-06-15", source: "health-connect", value: 500 },
      ],
      ["oura", ...SOURCE_PREFERENCE]
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 300 }]);
  });

  it("treats a NULL source as manual (which the defaults prefer)", () => {
    const out = pickOneSourcePerDay(
      [
        { date: "2026-06-15", source: null, value: 410 },
        { date: "2026-06-15", source: "health-connect", value: 500 },
      ],
      SOURCE_PREFERENCE
    );
    expect(out).toEqual([{ date: "2026-06-15", value: 410 }]);
  });
});

describe("pickRowsOneSourcePerDay", () => {
  interface Row {
    date: string;
    source: string | null;
    v: number;
  }
  const dateOf = (r: Row) => r.date;
  const sourceOf = (r: Row) => r.source;

  it("keeps only the preferred source's rows per day, preserving order", () => {
    const rows: Row[] = [
      { date: "2026-06-15", source: "oura", v: 1 },
      { date: "2026-06-15", source: "health-connect", v: 2 },
      { date: "2026-06-15", source: "health-connect", v: 3 },
      { date: "2026-06-16", source: "oura", v: 4 },
    ];
    expect(
      pickRowsOneSourcePerDay(rows, SOURCE_PREFERENCE, dateOf, sourceOf)
    ).toEqual([
      { date: "2026-06-15", source: "health-connect", v: 2 },
      { date: "2026-06-15", source: "health-connect", v: 3 },
      { date: "2026-06-16", source: "oura", v: 4 }, // lone source passes through
    ]);
  });

  it("without a preference hit, keeps the source with the most weight", () => {
    const rows: Row[] = [
      { date: "2026-06-15", source: "vendor-a", v: 10 },
      { date: "2026-06-15", source: "vendor-b", v: 1 },
      { date: "2026-06-15", source: "vendor-b", v: 1 },
    ];
    expect(
      pickRowsOneSourcePerDay(rows, SOURCE_PREFERENCE, dateOf, sourceOf)
    ).toEqual([
      { date: "2026-06-15", source: "vendor-b", v: 1 },
      { date: "2026-06-15", source: "vendor-b", v: 1 },
    ]);
    // Explicit weight function: vendor-a's single heavy row now wins.
    expect(
      pickRowsOneSourcePerDay(
        rows,
        SOURCE_PREFERENCE,
        dateOf,
        sourceOf,
        (r) => r.v
      )
    ).toEqual([{ date: "2026-06-15", source: "vendor-a", v: 10 }]);
  });

  it("breaks exact ties deterministically (lexicographic)", () => {
    const rows: Row[] = [
      { date: "2026-06-15", source: "vendor-b", v: 1 },
      { date: "2026-06-15", source: "vendor-a", v: 1 },
    ];
    expect(
      pickRowsOneSourcePerDay(rows, SOURCE_PREFERENCE, dateOf, sourceOf)
    ).toEqual([{ date: "2026-06-15", source: "vendor-a", v: 1 }]);
  });

  it("picks independently per day", () => {
    const rows: Row[] = [
      { date: "2026-06-15", source: "health-connect", v: 1 },
      { date: "2026-06-15", source: "oura", v: 2 },
      { date: "2026-06-16", source: "oura", v: 3 },
    ];
    expect(
      pickRowsOneSourcePerDay(rows, SOURCE_PREFERENCE, dateOf, sourceOf)
    ).toEqual([
      { date: "2026-06-15", source: "health-connect", v: 1 },
      { date: "2026-06-16", source: "oura", v: 3 },
    ]);
  });
});

describe("the documents class in the day resolvers (issue #1640)", () => {
  const withClass = {
    order: [DOCUMENTS_SOURCE_CLASS, ...SOURCE_PREFERENCE],
    strict: false,
  };

  it("elects EVERY document — the day a scan exists is the scan's day", () => {
    const out = pickOneSourcePerDay(
      [
        { date: "2026-01-10", source: "document:5", value: 21.4 },
        { date: "2026-01-10", source: "withings", value: 23.9 },
        { date: "2026-02-10", source: "document:7", value: 19.8 },
        { date: "2026-02-10", source: "withings", value: 23.1 },
        // A day no report covers still falls back down the list (preference mode).
        { date: "2026-02-11", source: "withings", value: 23.0 },
      ],
      withClass
    );
    expect(out.sort((a, b) => (a.date < b.date ? -1 : 1))).toEqual([
      { date: "2026-01-10", value: 21.4 },
      { date: "2026-02-10", value: 19.8 },
      { date: "2026-02-11", value: 23.0 },
    ]);
  });

  it("keeps every member's ROWS for a day the class wins", () => {
    interface Row {
      date: string;
      source: string | null;
    }
    const rows: Row[] = [
      { date: "2026-01-10", source: "document:5" },
      { date: "2026-01-10", source: "document:7" },
      { date: "2026-01-10", source: "withings" },
    ];
    expect(
      pickRowsOneSourcePerDay(
        rows,
        withClass,
        (r) => r.date,
        (r) => r.source
      )
    ).toEqual([
      { date: "2026-01-10", source: "document:5" },
      { date: "2026-01-10", source: "document:7" },
    ]);
  });

  it("without the class, two documents stay two competing sources (#533)", () => {
    interface Row {
      date: string;
      source: string | null;
    }
    const rows: Row[] = [
      { date: "2026-01-10", source: "document:5" },
      { date: "2026-01-10", source: "document:7" },
    ];
    // Neither is in the default preference, so the deterministic lexicographic
    // tie-break picks ONE of them — they are not one source.
    expect(
      pickRowsOneSourcePerDay(
        rows,
        SOURCE_PREFERENCE,
        (r) => r.date,
        (r) => r.source
      )
    ).toEqual([{ date: "2026-01-10", source: "document:5" }]);
  });
});

describe("strict mode in the day resolvers (issue #1642)", () => {
  const strictDocs = { order: [DOCUMENTS_SOURCE_CLASS], strict: true };

  it("drops the days the strict source didn't cover — honest gaps, not fallback", () => {
    const out = pickOneSourcePerDay(
      [
        { date: "2026-01-10", source: "document:5", value: 21.4 },
        { date: "2026-01-10", source: "withings", value: 23.9 },
        { date: "2026-01-11", source: "withings", value: 23.8 },
        { date: "2026-01-12", source: "withings", value: 23.7 },
      ],
      strictDocs
    );
    expect(out).toEqual([{ date: "2026-01-10", value: 21.4 }]);
  });

  it("the same day in PREFERENCE mode keeps the fallback (the contrast)", () => {
    const out = pickOneSourcePerDay(
      [{ date: "2026-01-11", source: "withings", value: 23.8 }],
      { order: [DOCUMENTS_SOURCE_CLASS, ...SOURCE_PREFERENCE], strict: false }
    );
    expect(out).toEqual([{ date: "2026-01-11", value: 23.8 }]);
  });

  it("a strict single source yields no rows at all on days it missed", () => {
    interface Row {
      date: string;
      source: string | null;
    }
    const rows: Row[] = [
      { date: "2026-01-10", source: "oura" },
      { date: "2026-01-11", source: "health-connect" },
    ];
    expect(
      pickRowsOneSourcePerDay(
        rows,
        { order: ["oura"], strict: true },
        (r) => r.date,
        (r) => r.source
      )
    ).toEqual([{ date: "2026-01-10", source: "oura" }]);
  });

  it("a bare preference list is preference mode — passthrough is unchanged", () => {
    expect(
      pickOneSourcePerDay(
        [{ date: "2026-01-11", source: "vendor-x", value: 5 }],
        SOURCE_PREFERENCE
      )
    ).toEqual([{ date: "2026-01-11", value: 5 }]);
  });
});

// The bucket is the whole question (#2552). Two sources on one wake-day are a
// duplicate when they describe the same window and two events when they do not, and
// only the overlap can tell those apart — the calendar day sees "two sources on
// 2026-07-15" either way and drops one of them whole.
describe("pickRowsOneSourcePerWindow", () => {
  interface Row {
    source: string | null;
    start: string;
    end: string;
    v: number;
  }
  const pick = (rows: Row[], selection: SourceSelection = SOURCE_PREFERENCE) =>
    pickRowsOneSourcePerWindow(
      rows,
      selection,
      (r) => r.start,
      (r) => r.end,
      (r) => r.source,
      (r) => r.v
    );

  const night: Row = {
    source: "oura",
    start: "2026-07-14T23:00:00Z",
    end: "2026-07-15T06:00:00Z",
    v: 420,
  };
  const nap: Row = {
    source: "health-connect",
    start: "2026-07-15T13:00:00Z",
    end: "2026-07-15T13:45:00Z",
    v: 45,
  };

  it("keeps BOTH when the windows do not overlap, whatever the preference says", () => {
    // health-connect outranks oura, and the day-grained election would have taken
    // the 7h overnight out of the read on the strength of a 45-minute nap.
    expect(pick([night, nap])).toEqual([night, nap]);
  });

  it("elects one source when the windows DO overlap", () => {
    const duplicate: Row = {
      source: "health-connect",
      start: "2026-07-14T22:50:00Z",
      end: "2026-07-15T05:40:00Z",
      v: 410,
    };
    expect(pick([night, duplicate])).toEqual([duplicate]);
  });

  it("elects per cluster, so one duplicated night does not decide the other events", () => {
    const duplicateNight: Row = {
      source: "health-connect",
      start: "2026-07-14T22:50:00Z",
      end: "2026-07-15T05:40:00Z",
      v: 410,
    };
    const ouraNap: Row = {
      source: "oura",
      start: "2026-07-15T16:00:00Z",
      end: "2026-07-15T16:30:00Z",
      v: 30,
    };
    // The night collapses to health-connect; the oura nap it does not overlap is
    // untouched, even though oura just lost the cluster next to it.
    expect(pick([night, duplicateNight, ouraNap])).toEqual([
      duplicateNight,
      ouraNap,
    ]);
  });

  it("touching endpoints are not an overlap — a session that starts when another ends is a second event", () => {
    const first: Row = {
      source: "oura",
      start: "2026-07-15T01:00:00Z",
      end: "2026-07-15T04:00:00Z",
      v: 180,
    };
    const second: Row = {
      source: "health-connect",
      start: "2026-07-15T04:00:00Z",
      end: "2026-07-15T06:00:00Z",
      v: 120,
    };
    expect(pick([first, second])).toEqual([first, second]);
  });

  it("falls back to the heaviest source in a cluster of unlisted sources", () => {
    const a: Row = {
      source: "vendor-a",
      start: "2026-07-15T01:00:00Z",
      end: "2026-07-15T05:00:00Z",
      v: 240,
    };
    const b: Row = {
      source: "vendor-b",
      start: "2026-07-15T02:00:00Z",
      end: "2026-07-15T04:00:00Z",
      v: 120,
    };
    expect(pick([a, b])).toEqual([a]);
  });

  it("STRICT keeps no rows in a cluster the selector never covers (#1642)", () => {
    expect(pick([night, nap], { order: ["oura"], strict: true })).toEqual([
      night,
    ]);
  });

  it("keeps a row whose window will not parse — this filter de-duplicates, it does not validate", () => {
    const broken: Row = { source: "withings", start: "", end: "", v: 0 };
    expect(pick([night, broken, nap])).toEqual([night, broken, nap]);
  });
});

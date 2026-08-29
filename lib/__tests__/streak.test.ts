import { describe, expect, it } from "vitest";
import { dateStrInTz } from "../date";
import { currentStreak } from "../streak";

// currentStreak is the ONLY streak computation left in the app (#1935/#1936/#1937/
// #1939). Its rest-tolerant siblings — flexibleStreak and the activityStreak that
// wrapped it — were deleted with the last user-facing streak they fed. What remains
// answers the coaching overtraining question ("you've trained N days in a row —
// take a rest day"), which is the app telling you to STOP, so its cliff is the
// point rather than a flaw.

describe("currentStreak", () => {
  it("is 0 with no active dates", () => {
    expect(currentStreak("2024-03-10", [])).toBe(0);
  });

  it("counts consecutive days anchored on today", () => {
    const dates = ["2024-03-10", "2024-03-09", "2024-03-08"];
    expect(currentStreak("2024-03-10", dates)).toBe(3);
  });

  it("anchors on yesterday when today has no activity yet", () => {
    // Haven't trained today, but a streak ending yesterday still reads current.
    const dates = ["2024-03-09", "2024-03-08"];
    expect(currentStreak("2024-03-10", dates)).toBe(2);
  });

  it("is 0 when neither today nor yesterday is active", () => {
    const dates = ["2024-03-08", "2024-03-07"];
    expect(currentStreak("2024-03-10", dates)).toBe(0);
  });

  it("stops at the first gap", () => {
    // 10, 9 are consecutive; 7 is broken by the missing 8th.
    const dates = ["2024-03-10", "2024-03-09", "2024-03-07"];
    expect(currentStreak("2024-03-10", dates)).toBe(2);
  });

  it("ignores order and duplicates in the input dates", () => {
    const dates = ["2024-03-08", "2024-03-10", "2024-03-10", "2024-03-09"];
    expect(currentStreak("2024-03-10", dates)).toBe(3);
  });

  it("depends only on the anchor date string (timezone-boundary semantics)", () => {
    const dates = ["2024-03-10"];
    // The same underlying data reads differently depending on which calendar
    // date the profile's timezone considers "today":
    expect(currentStreak("2024-03-10", dates)).toBe(1); // today anchor
    expect(currentStreak("2024-03-11", dates)).toBe(1); // yesterday anchor
    expect(currentStreak("2024-03-12", dates)).toBe(0); // two days stale
  });

  it("handles a streak spanning a month boundary", () => {
    const dates = ["2024-03-01", "2024-02-29", "2024-02-28"];
    expect(currentStreak("2024-03-01", dates)).toBe(3);
  });
});

// ---- Timezone skips, both directions (#3294) --------------------------------
//
// currentStreak walks by calendar-date STRING, which makes it DST-immune but not
// skip-immune. These rows are built from REAL instants through real zones — every
// profile-local day below is one Intl actually reports, not a day count we asserted
// — so they pin what the arithmetic does when a local day vanishes or repeats:
//
//   EASTWARD, a whole local date DELETED (a zone realigning across the date line, or
//   a >24h travel switch): the walk reads the missing date as a gap and stops there,
//   so it reports only the part of the run AFTER the skip. Undercount — and note it
//   is not always by one: whatever prefix sat before the skip is dropped with it.
//   Deliberate and tolerated; lib/streak.ts carries why, and why "fixing" it risks
//   the opposite, worse error.
//
//   DST, either hemisphere, either direction: a 23h or 25h day is still a day with
//   its own date, so nothing is deleted and the count is EXACT. The case that
//   happens to everyone twice a year is the case that was never broken.
//
//   WESTWARD, a local date lived through TWICE: two runs at the same calendar label
//   collapse to one entry in the date set, so the count is exact. The mirror does
//   NOT invent a day — which is the property that makes the eastward error safe to
//   leave.

// The profile-local days a profile ACTUALLY lived, sampled minute by minute from real
// instants through whatever zone its clock was on at the time — `zoneAt` is what lets
// one helper express both a zone's own re-alignment and a travel switch. Values are
// minutes spent on that local date, so a date lived twice is visibly over 1440.
function livedLocalDays(
  zoneAt: (t: number) => string,
  fromIso: string,
  toIso: string
): Map<string, number> {
  const minutes = new Map<string, number>();
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += 60_000) {
    const day = dateStrInTz(zoneAt(t), new Date(t));
    minutes.set(day, (minutes.get(day) ?? 0) + 1);
  }
  return minutes;
}

const fixedZone = (tz: string) => () => tz;
const switchedZone = (from: string, to: string, atIso: string) => {
  const at = Date.parse(atIso);
  return (t: number) => (t < at ? from : to);
};

describe("currentStreak across a real timezone skip (#3294)", () => {
  it.each([
    {
      name: "eastward · Apia's deleted 2011-12-30 · one day before the skip",
      zoneAt: fixedZone("Pacific/Apia"),
      from: "2011-12-29T12:00:00Z",
      to: "2012-01-01T00:00:00Z",
      lived: ["2011-12-29", "2011-12-31", "2012-01-01"],
      vanished: "2011-12-30",
      streak: 2, // trained all three lived days; reported short by one
    },
    {
      name: "eastward · Apia · three days before the skip go with it",
      zoneAt: fixedZone("Pacific/Apia"),
      from: "2011-12-27T12:00:00Z",
      to: "2011-12-30T12:00:00Z",
      lived: ["2011-12-27", "2011-12-28", "2011-12-29", "2011-12-31"],
      vanished: "2011-12-30",
      streak: 1, // the whole prefix is lost, not one day of it
    },
    {
      name: "eastward · Kiritimati's deleted 1994-12-31",
      zoneAt: fixedZone("Pacific/Kiritimati"),
      from: "1994-12-30T12:00:00Z",
      to: "1995-01-01T12:00:00Z",
      lived: ["1994-12-30", "1995-01-01", "1995-01-02"],
      vanished: "1994-12-31",
      streak: 2,
    },
    {
      name: "eastward · a 25h travel switch (Pago Pago → Kiritimati)",
      zoneAt: switchedZone(
        "Pacific/Pago_Pago",
        "Pacific/Kiritimati",
        "2026-03-10T10:30:00Z"
      ),
      from: "2026-03-09T20:00:00Z",
      to: "2026-03-11T20:00:00Z",
      lived: ["2026-03-09", "2026-03-11", "2026-03-12"],
      vanished: "2026-03-10",
      streak: 2,
    },
    {
      name: "westward · the same switch reversed, 2026-03-10 lived twice",
      zoneAt: switchedZone(
        "Pacific/Kiritimati",
        "Pacific/Pago_Pago",
        "2026-03-10T10:30:00Z"
      ),
      from: "2026-03-09T20:00:00Z",
      to: "2026-03-11T20:00:00Z",
      lived: ["2026-03-09", "2026-03-10", "2026-03-11"],
      repeated: "2026-03-10",
      streak: 3, // exact — no day invented from the replay
    },
    {
      name: "DST spring forward · New York, a 23h 2026-03-08",
      zoneAt: fixedZone("America/New_York"),
      from: "2026-03-06T12:00:00Z",
      to: "2026-03-10T12:00:00Z",
      lived: [
        "2026-03-06",
        "2026-03-07",
        "2026-03-08",
        "2026-03-09",
        "2026-03-10",
      ],
      streak: 5,
    },
    {
      name: "DST spring forward · Sydney, the southern-hemisphere jump",
      zoneAt: fixedZone("Australia/Sydney"),
      from: "2026-10-02T00:00:00Z",
      to: "2026-10-05T00:00:00Z",
      lived: ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"],
      streak: 4,
    },
    {
      name: "DST fall back · New York, a 25h 2026-11-01",
      zoneAt: fixedZone("America/New_York"),
      from: "2026-10-30T12:00:00Z",
      to: "2026-11-02T12:00:00Z",
      lived: ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"],
      streak: 4,
    },
  ])("$name", ({ zoneAt, from, to, lived, vanished, repeated, streak }) => {
    const minutes = livedLocalDays(zoneAt, from, to);
    const days = [...minutes.keys()].sort();
    expect(days).toEqual(lived);
    // The skip is REAL, not asserted: the deleted date is absent from a minute-by-
    // minute sweep of the zone, and the repeated one holds more than a day of them.
    if (vanished) expect(days).not.toContain(vanished);
    if (repeated) expect(minutes.get(repeated)).toBeGreaterThan(1440);

    // Trained every day the profile actually lived, anchored on the last of them.
    expect(currentStreak(days.at(-1) as string, days)).toBe(streak);
  });
});

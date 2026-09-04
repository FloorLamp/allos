import { describe, it, expect } from "vitest";
import {
  cockpitRecoveryFraction,
  deriveFeverSeries,
  derivedFeverPeakDay,
  cockpitRecoveryHeadline,
  cockpitSummaryLine,
  doseLaneRoster,
  episodeDayNumber,
  feverTrend,
  feverTrendLabel,
  episodeHeadline,
  readingClockWithRelativeAge,
  episodeCollapsedStatus,
  householdSickLine,
  episodeLatestDose,
  episodeLastDoseClause,
  orderIllnessCockpits,
  isOpenEpisode,
  episodeConditionExternalId,
  episodeAlternateLogDate,
  assignOrderedEpisodeFacts,
  illnessTimelineEvents,
  relativeEpisodeDateLabel,
  type AssembledEpisode,
  type EpisodeMedication,
  type TemperaturePoint,
} from "../illness-episode-format";

// A minimal assembled episode with sensible defaults, overridable per test.
function ep(over: Partial<AssembledEpisode> = {}): AssembledEpisode {
  return {
    id: null,
    situation: "Illness",
    start: "2026-06-01",
    end: null,
    ongoing: true,
    firstDay: "2026-06-01",
    lastActiveDay: "2026-06-04",
    asOf: "2026-06-04",
    dayCount: 4,
    symptoms: [],
    distinctSymptomCount: 0,
    temperatures: [],
    maxTempF: null,
    latestTemp: null,
    medications: [],
    totalAdministrations: 0,
    conditions: [],
    notes: [],
    ...over,
  };
}

function temp(degF: number, flag: string | null = null): TemperaturePoint {
  return {
    id: Math.round(degF * 10),
    date: "2026-06-02",
    time: null,
    degF,
    flag,
  };
}

describe("episodeDayNumber", () => {
  it("counts the start day as day 1", () => {
    expect(episodeDayNumber("2026-06-01", "2026-06-01")).toBe(1);
    expect(episodeDayNumber("2026-06-01", "2026-06-04")).toBe(4);
  });
  it("is null for an unknown (before-log) start", () => {
    expect(episodeDayNumber(null, "2026-06-04")).toBeNull();
  });
  it("floors at 1 for an as-of before the start", () => {
    expect(episodeDayNumber("2026-06-05", "2026-06-01")).toBe(1);
  });
});

describe("feverTrend", () => {
  it("is null with fewer than two fever-flagged readings", () => {
    expect(feverTrend([])).toBeNull();
    expect(feverTrend([temp(102, "high"), temp(98, null)])).toBeNull();
  });
  it("reads falling when later fevers are cooler", () => {
    expect(
      feverTrend([
        temp(102.4, "high"),
        temp(101.9, "high"),
        temp(100.0, "high"),
        temp(99.2, "high"),
      ])
    ).toBe("falling");
  });
  it("reads rising when later fevers are hotter", () => {
    expect(
      feverTrend([temp(99.5, "high"), temp(100, "high"), temp(102, "high")])
    ).toBe("rising");
  });
  it("reads steady within half a degree", () => {
    expect(
      feverTrend([
        temp(101.0, "high"),
        temp(101.1, "high"),
        temp(101.2, "high"),
      ])
    ).toBe("steady");
  });
  it("ignores non-fever readings when deciding the trend", () => {
    // Only the two 'high' readings count; the normal one is dropped.
    expect(
      feverTrend([temp(98.2, null), temp(103, "high"), temp(100, "high")])
    ).toBe("falling");
  });
});

describe("feverTrendLabel", () => {
  it("maps trends to phrases, null with no curve", () => {
    expect(feverTrendLabel("falling")).toBe("fever trending down");
    expect(feverTrendLabel("rising")).toBe("fever trending up");
    expect(feverTrendLabel("steady")).toBe("fever steady");
    expect(feverTrendLabel(null)).toBeNull();
  });
});

describe("episodeHeadline", () => {
  it("assembles situation · day · fever · symptoms · meds, omitting absent clauses", () => {
    const e = ep({
      distinctSymptomCount: 3,
      temperatures: [
        temp(102.4, "high"),
        temp(101, "high"),
        temp(99.5, "high"),
      ],
      medications: [
        { itemId: 1, name: "Ibuprofen", count: 3, administrations: [] },
      ],
    });
    expect(episodeHeadline(e)).toBe(
      "Illness · day 4 · fever trending down · 3 symptoms · ibuprofen 3×"
    );
  });
  it("degrades to just situation · day for a bare episode", () => {
    expect(episodeHeadline(ep())).toBe("Illness · day 4");
  });
  it("uses singular 'symptom' for a count of one and caps meds at two", () => {
    const e = ep({
      distinctSymptomCount: 1,
      medications: [
        { itemId: 1, name: "Ibuprofen", count: 2, administrations: [] },
        { itemId: 2, name: "Tylenol", count: 1, administrations: [] },
        { itemId: 3, name: "Sudafed", count: 1, administrations: [] },
      ],
    });
    expect(episodeHeadline(e)).toBe(
      "Illness · day 4 · 1 symptom · ibuprofen 2× · tylenol 1×"
    );
  });
});

describe("episodeCollapsedStatus", () => {
  it("prioritizes latest temperature and medication timing", () => {
    const latestTemp: TemperaturePoint = {
      id: 1,
      date: "2026-06-04",
      time: "00:05",
      degF: 101.3,
      flag: "high",
    };
    const e = ep({
      latestTemp,
      temperatures: [latestTemp],
      medications: [
        med("Ibuprofen", [
          { date: "2026-06-04", time: "16:02", amount: "200 mg" },
        ]),
      ],
    });
    expect(
      episodeCollapsedStatus(e, "F", {
        timeZone: "America/New_York",
        timeFormat: "12h",
        now: new Date("2026-06-04T22:02:00Z"),
      })
    ).toEqual({
      dayLabel: "Illness · Day 4",
      // The same day WITHOUT the situation, for a host whose header already names it
      // (#3238). Both are emitted: the full form is still what /encounters shows.
      dayOnlyLabel: "Day 4",
      temperature: {
        id: 1,
        value: "101.3 °F",
        when: "at 12:05 AM (18 hrs ago)",
        high: true,
      },
      lastMeds: {
        id: "1:2026-06-04:16:02",
        name: "Ibuprofen",
        dose: "200 mg",
        when: "4:02 PM (2 hrs ago)",
      },
      worsening: false,
    });
  });

  it("keeps older readings relative and degrades to the situation", () => {
    const e = ep({
      start: null,
      latestTemp: {
        date: "2026-06-03",
        time: "08:15",
        degF: 98.6,
        flag: null,
      },
    });
    expect(
      episodeCollapsedStatus(e, "C", {
        timeZone: "UTC",
        timeFormat: "12h",
      })
    ).toMatchObject({
      dayLabel: "Illness",
      // No day number to state, so there is nothing left once the situation's name
      // is taken out — the host renders nothing rather than repeating it.
      dayOnlyLabel: null,
      temperature: {
        value: "37 °C",
        when: "Yesterday, 8:15 AM",
        high: false,
      },
      lastMeds: null,
    });
  });
});

describe("readingClockWithRelativeAge", () => {
  it("normalizes an already-formatted medication clock", () => {
    expect(
      readingClockWithRelativeAge("2026-06-04", "5:00 pm", {
        timeZone: "America/New_York",
        timeFormat: "12h",
        now: new Date("2026-06-04T23:00:00Z"),
      })
    ).toBe("5:00 PM (2 hrs ago)");
  });

  // #2522: the cockpit's Reading time is a user-owned input, so a morning reading
  // logged in the evening — or the seeded 08:00 temperature read at 01:10 — hands
  // this a FUTURE instant. It used to answer "(just now)", which on a safety-tier
  // card tells a caregiver a dose was just given. The clock still shows; the
  // parenthetical now says which way it points.
  it("says a stated time is ahead instead of claiming it just happened", () => {
    expect(
      readingClockWithRelativeAge("2026-06-04", "08:00", {
        timeZone: "UTC",
        timeFormat: "24h",
        now: new Date("2026-06-04T01:10:00Z"),
      })
    ).toBe("08:00 (in 7 hrs)");
  });

  it("keeps the skew tolerance, so a seconds-ahead reading is still 'just now'", () => {
    expect(
      readingClockWithRelativeAge("2026-06-04", "01:10", {
        timeZone: "UTC",
        timeFormat: "24h",
        now: new Date("2026-06-04T01:09:40Z"),
      })
    ).toBe("01:10 (just now)");
  });
});

// A PRN med with administration points (date/time/amount), for the last-dose clause.
function med(
  name: string,
  admins: {
    date: string;
    time: string | null;
    time24?: string | null;
    amount?: string | null;
    product?: string | null;
  }[],
  product: string | null = null
): EpisodeMedication {
  return {
    itemId: 1,
    name,
    product,
    count: admins.length,
    administrations: admins.map((a) => ({
      ...a,
      amount: a.amount ?? null,
    })),
  };
}

describe("episodeLastDoseClause", () => {
  it("is null when nothing was administered", () => {
    expect(episodeLastDoseClause(ep())).toBeNull();
  });
  it("formats the most-recent administration, lowercasing the med name", () => {
    const e = ep({
      medications: [
        med("Ibuprofen", [
          { date: "2026-06-02", time: "2:00pm" },
          { date: "2026-06-03", time: "4:02pm" },
        ]),
      ],
    });
    expect(episodeLastDoseClause(e, "12h")).toBe("last ibuprofen 4:02 PM");
  });
  it("includes the saved formulation with the latest dose", () => {
    const e = ep({
      medications: [
        med(
          "Acetaminophen",
          [{ date: "2026-06-03", time: "4:02pm", amount: "160 mg" }],
          "Children's oral suspension (160 mg / 5 mL)"
        ),
      ],
    });
    expect(episodeLastDoseClause(e, "12h")).toBe(
      "last acetaminophen (160 mg / 5 mL) 4:02 PM"
    );
    expect(illnessTimelineEvents(e)[0]).toMatchObject({
      detail: "160 mg / 5 mL",
    });
  });
  it("uses each administration's snapshot after a formulation change", () => {
    const e = ep({
      medications: [
        med(
          "Acetaminophen",
          [
            {
              date: "2026-06-02",
              time: "4:02pm",
              amount: "160 mg",
              product: "Children's oral suspension (160 mg / 5 mL)",
            },
            {
              date: "2026-06-03",
              time: "4:02pm",
              amount: "160 mg",
              product: "Chewable tablet (160 mg)",
            },
          ],
          "Chewable tablet (160 mg)"
        ),
      ],
    });
    expect(illnessTimelineEvents(e).map((event) => event.detail)).toEqual([
      "160 mg / 5 mL",
      "160 mg · Chewable tablet (160 mg)",
    ]);
  });
  it("picks the globally latest administration across meds", () => {
    const e = ep({
      medications: [
        med("Ibuprofen", [{ date: "2026-06-03", time: "1:00pm" }]),
        med("Tylenol", [{ date: "2026-06-03", time: "6:30pm" }]),
      ],
    });
    expect(episodeLastDoseClause(e, "12h")).toBe("last tylenol 6:30 PM");
  });
  it("degrades to just the name when the clock is unknown", () => {
    const e = ep({
      medications: [med("Ibuprofen", [{ date: "2026-06-03", time: null }])],
    });
    expect(episodeLastDoseClause(e)).toBe("last ibuprofen");
  });
  it("returns the full latest dose and sorts display clocks by their 24-hour value", () => {
    const e = ep({
      medications: [
        med("Ibuprofen", [
          {
            date: "2026-06-03",
            time: "10:00am",
            time24: "10:00",
            amount: "200 mg",
          },
          {
            date: "2026-06-03",
            time: "9:00pm",
            time24: "21:00",
            amount: "400 mg",
          },
        ]),
      ],
    });

    expect(episodeLatestDose(e)).toMatchObject({
      name: "Ibuprofen",
      date: "2026-06-03",
      time: "9:00pm",
      amount: "400 mg",
    });
  });
});

describe("householdSickLine", () => {
  it("prefixes the name and appends the latest temp", () => {
    const e = ep({ latestTemp: temp(101.3, "high") });
    expect(householdSickLine("Mia", e)).toBe("Mia · sick day 4 · 101.3 °F");
  });
  it("drops the day clause when the start is unknown", () => {
    const e = ep({ start: null, latestTemp: null });
    expect(householdSickLine("Mia", e)).toBe("Mia · sick");
  });
  it("appends the last-dose clause (the co-caregiver double-dose guard, #858)", () => {
    const e = ep({
      latestTemp: temp(101.3, "high"),
      medications: [med("Ibuprofen", [{ date: "2026-06-03", time: "4:02pm" }])],
    });
    expect(householdSickLine("Mia", e, "F", null, "12h")).toBe(
      "Mia · sick day 4 · 101.3 °F · last ibuprofen 4:02 PM"
    );
  });
});

describe("orderIllnessCockpits", () => {
  it("puts the acting profile's cockpit first regardless of its start", () => {
    const ordered = orderIllnessCockpits([
      { profileId: 2, isActive: false, episodeOrder: 0, episodeKey: "20" },
      { profileId: 1, isActive: true, episodeOrder: 0, episodeKey: "10" },
    ]);
    expect(ordered.map((c) => c.profileId)).toEqual([1, 2]);
  });
  it("orders other profiles by numeric profile id, independent of input order", () => {
    const ordered = orderIllnessCockpits([
      { profileId: 5, isActive: false, episodeOrder: 0, episodeKey: "50" },
      { profileId: 3, isActive: false, episodeOrder: 0, episodeKey: "30" },
      { profileId: 4, isActive: false, episodeOrder: 0, episodeKey: "40" },
    ]);
    expect(ordered.map((c) => c.profileId)).toEqual([3, 4, 5]);
  });
  it("preserves the owning query order for simultaneous episodes", () => {
    const ordered = orderIllnessCockpits([
      { profileId: 7, isActive: false, episodeOrder: 1, episodeKey: "72" },
      { profileId: 7, isActive: false, episodeOrder: 0, episodeKey: "71" },
    ]);
    expect(ordered.map((c) => c.episodeKey)).toEqual(["71", "72"]);
  });
});

// The derived fever row's own edge cases (#4712 item 4). The assembly-tier proof —
// that a stated fever row makes the derived one yield for THAT DAY only (owner-ruled
// 2026-09-03, judgement 3) — is in lib/__db_tests__/illness-episode.test.ts; this pins
// the composition itself, including the `statedFeverDates` suppression below.
describe("deriveFeverSeries", () => {
  const reading = (
    date: string,
    time: string | null,
    degF: number,
    flag: string | null,
    id?: number
  ) => ({ id, date, time, degF, flag });

  it.each([
    {
      name: "no flagged reading derives nothing",
      readings: [reading("2026-06-01", "09:00", 99.0, null)],
      expected: null,
    },
    {
      name: "an unflagged reading on a flagged day is not the day's peak",
      readings: [
        reading("2026-06-01", "08:00", 98.4, null),
        reading("2026-06-01", "20:00", 103.4, "high", 7),
      ],
      expected: [["2026-06-01", 103.4, "20:00", 7]],
    },
    {
      name: "the day's PEAK flagged reading wins, whatever order it was taken in",
      readings: [
        reading("2026-06-01", "08:00", 103.4, "high", 1),
        reading("2026-06-01", "20:00", 100.2, "high", 2),
      ],
      expected: [["2026-06-01", 103.4, "08:00", 1]],
    },
    {
      name: "a tie keeps the EARLIER reading, the first crossing of the day",
      readings: [
        reading("2026-06-01", "08:00", 101.0, "high", 1),
        reading("2026-06-01", "20:00", 101.0, "high", 2),
      ],
      expected: [["2026-06-01", 101.0, "08:00", 1]],
    },
    {
      name: "days come back oldest-first, one row per day",
      readings: [
        reading("2026-06-01", "20:00", 100.1, "high", 1),
        reading("2026-06-02", "08:00", 104.0, "high", 2),
        reading("2026-06-03", "08:00", 98.6, null, 3),
      ],
      expected: [
        ["2026-06-01", 100.1, "20:00", 1],
        ["2026-06-02", 104.0, "08:00", 2],
      ],
    },
    {
      name: "an untimed flagged reading still derives, with a null clock",
      readings: [reading("2026-06-01", null, 102.0, "high", 4)],
      expected: [["2026-06-01", 102.0, null, 4]],
    },
  ])("$name", ({ readings, expected }) => {
    const series = deriveFeverSeries(readings);
    if (expected === null) {
      expect(series).toBeNull();
      return;
    }
    expect(series).not.toBeNull();
    expect(series!.source).toBe("derived");
    expect(series!.symptom).toBe("fever");
    expect(series!.label).toBe("Fever");
    // No severity anywhere on the derived arm — that absence is the ruling.
    expect(series!).not.toHaveProperty("maxSeverity");
    expect(series!).not.toHaveProperty("points");
    expect(
      series!.days.map((d) => [d.date, d.peakDegF, d.time, d.readingId])
    ).toEqual(expected);
  });

  it("a date in statedFeverDates yields — per date, not for the whole series (#4712 judgement 3)", () => {
    const readings = [
      reading("2026-06-01", "08:00", 103.4, "high", 1),
      reading("2026-06-02", "08:00", 101.0, "high", 2),
    ];
    const series = deriveFeverSeries(readings, new Set(["2026-06-01"]));
    expect(series).not.toBeNull();
    expect(series!.days.map((d) => d.date)).toEqual(["2026-06-02"]);
  });

  it("every flagged date stated yields nothing at all, not a fallback row", () => {
    const readings = [reading("2026-06-01", "08:00", 103.4, "high", 1)];
    expect(deriveFeverSeries(readings, new Set(["2026-06-01"]))).toBeNull();
  });

  // THE EPISODE'S WORST DAY is what the summary's leading row states (#4712 ruling
  // 2026-09-04 11:20 UTC part 1), so it has to be the same reading the card's own
  // "Peak temp" figure comes from — not the first day, and not the last one.
  it.each([
    {
      name: "the hottest day wins, wherever it falls in the episode",
      days: [
        ["2026-06-01", 100.1],
        ["2026-06-02", 104.0],
        ["2026-06-03", 101.2],
      ],
      expected: ["2026-06-02", 104.0],
    },
    {
      name: "a tie keeps the EARLIER day",
      days: [
        ["2026-06-01", 102.0],
        ["2026-06-02", 102.0],
      ],
      expected: ["2026-06-01", 102.0],
    },
  ])("derivedFeverPeakDay: $name", ({ days, expected }) => {
    const series = deriveFeverSeries(
      days.map(([date, degF], i) =>
        reading(String(date), "08:00", Number(degF), "high", i + 1)
      )
    );
    const peak = derivedFeverPeakDay(series!);
    expect([peak!.date, peak!.peakDegF]).toEqual(expected);
  });
});

// NO SEVERITY EDITOR IS REACHABLE FROM THE DERIVED ROW (#4712 item 4's ruling, and
// the placement ruling's "rendered as a reading (no severity control)"). The ledger's
// symptom event is what the episode timeline turns into an editable severity row, so
// the derived arm contributing none of them is that guarantee at the model tier —
// and the converse is asserted in the same case, because a builder that emitted NO
// symptom events at all would satisfy the absence just as well.
describe("illnessTimelineEvents and the derived fever row (#4712)", () => {
  const episodeWith = (symptoms: AssembledEpisode["symptoms"]) =>
    ({
      situation: "Illness",
      start: "2026-06-01",
      end: null,
      ongoing: true,
      firstDay: "2026-06-01",
      lastActiveDay: "2026-06-01",
      asOf: "2026-06-01",
      dayCount: 1,
      symptoms,
      distinctSymptomCount: symptoms.length,
      temperatures: [],
      maxTempF: null,
      latestTemp: null,
      medications: [],
      totalAdministrations: 0,
      conditions: [],
      notes: [],
    }) satisfies AssembledEpisode;

  it("emits a symptom event for the stated row and none for the derived one", () => {
    const derived = deriveFeverSeries([
      { id: 5, date: "2026-06-01", time: "19:10", degF: 103.4, flag: "high" },
    ])!;
    const stated = {
      source: "logged" as const,
      symptom: "cough",
      label: "Cough",
      points: [{ date: "2026-06-01", severity: 3, note: null }],
      maxSeverity: 3,
    };
    const events = illnessTimelineEvents(episodeWith([stated, derived]));
    const symptomEvents = events.filter((e) => e.kind === "symptom");
    expect(symptomEvents.map((e) => e.label)).toEqual(["Cough"]);
  });
});

describe("assignOrderedEpisodeFacts", () => {
  it("assigns overlapping stored facts only to the first ordered episode", () => {
    const temperature = {
      id: 9,
      date: "2026-06-04",
      time: "10:00",
      degF: 101,
      flag: "high",
    };
    const symptom = {
      source: "logged" as const,
      symptom: "cough",
      label: "Cough",
      points: [{ date: "2026-06-04", severity: 2, note: null }],
      maxSeverity: 2,
    };
    const medication = {
      itemId: 3,
      name: "Ibuprofen",
      count: 1,
      administrations: [
        {
          id: 12,
          date: "2026-06-04",
          time: "11:00",
          amount: "200 mg",
        },
      ],
    };
    const shared = ep({
      symptoms: [symptom],
      distinctSymptomCount: 1,
      temperatures: [temperature],
      latestTemp: temperature,
      maxTempF: 101,
      medications: [medication],
      totalAdministrations: 1,
    });

    const [first, second] = assignOrderedEpisodeFacts([
      { profileId: 7, episode: { ...shared, id: 1 } },
      { profileId: 7, episode: { ...shared, id: 2 } },
    ]);
    expect(first.episode).toMatchObject({
      distinctSymptomCount: 1,
      totalAdministrations: 1,
      maxTempF: 101,
    });
    expect(second.episode).toMatchObject({
      symptoms: [],
      temperatures: [],
      medications: [],
      distinctSymptomCount: 0,
      totalAdministrations: 0,
      maxTempF: null,
      latestTemp: null,
    });
  });

  it("presents an explicitly linked symptom only in its owning episode", () => {
    const symptom = {
      source: "logged" as const,
      symptom: "headache",
      label: "Headache",
      points: [
        {
          date: "2026-06-03",
          severity: 1,
          note: null,
          episodeId: 2,
        },
        {
          date: "2026-06-04",
          severity: 4,
          note: null,
          episodeId: 2,
        },
      ],
      maxSeverity: 4,
    };
    const shared = ep({ symptoms: [symptom], distinctSymptomCount: 1 });

    const [first, second] = assignOrderedEpisodeFacts([
      { profileId: 7, episode: { ...shared, id: 1 } },
      { profileId: 7, episode: { ...shared, id: 2 } },
    ]);
    expect(first.episode.symptoms).toEqual([]);
    expect(second.episode.symptoms).toHaveLength(1);
    expect(episodeCollapsedStatus(first.episode, "F").worsening).toBe(false);
    expect(episodeCollapsedStatus(second.episode, "F").worsening).toBe(true);
  });
});

describe("isOpenEpisode", () => {
  it("is true only for an ongoing episode with at least one signal", () => {
    expect(isOpenEpisode(ep({ ongoing: true, distinctSymptomCount: 2 }))).toBe(
      true
    );
    expect(isOpenEpisode(ep({ ongoing: true }))).toBe(false); // no signal
    expect(isOpenEpisode(ep({ ongoing: false, distinctSymptomCount: 2 }))).toBe(
      false
    ); // closed
  });
});

describe("episodeConditionExternalId", () => {
  it("keys the generated condition to the stable episode row id", () => {
    expect(episodeConditionExternalId(42)).toBe("illness-episode:42");
  });
});

describe("episodeAlternateLogDate", () => {
  it("does not offer yesterday when the episode starts today", () => {
    expect(
      episodeAlternateLogDate(true, "2026-06-04", "2026-06-04")
    ).toBeNull();
  });

  it("offers yesterday only for an open episode whose range contains it", () => {
    expect(episodeAlternateLogDate(true, "2026-06-01", "2026-06-04")).toBe(
      "2026-06-03"
    );
    expect(episodeAlternateLogDate(true, null, "2026-06-04")).toBe(
      "2026-06-03"
    );
    expect(
      episodeAlternateLogDate(false, "2026-06-01", "2026-06-04")
    ).toBeNull();
  });
});

describe("illnessTimelineEvents", () => {
  it("combines temperatures, dose amounts/times, and symptoms chronologically", () => {
    const events = illnessTimelineEvents(
      ep({
        temperatures: [
          {
            id: 4,
            date: "2026-06-02",
            time: "08:30",
            degF: 101.2,
            flag: "high",
          },
        ],
        medications: [
          {
            itemId: 7,
            name: "Ibuprofen",
            count: 1,
            administrations: [
              {
                id: 9,
                date: "2026-06-02",
                time: "9:15 AM",
                time24: "09:15",
                amount: "200 mg",
              },
            ],
          },
        ],
        symptoms: [
          {
            source: "logged" as const,
            symptom: "cough",
            label: "Cough",
            maxSeverity: 2,
            points: [
              {
                date: "2026-06-02",
                severity: 2,
                note: "Worse after lying down",
              },
            ],
          },
        ],
      })
    );
    expect(events.map((event) => [event.label, event.detail])).toEqual([
      ["Temperature", "101.2"],
      ["Ibuprofen", "200 mg"],
      ["Cough", "Moderate"],
    ]);
    expect(events.find((event) => event.kind === "symptom")).toMatchObject({
      note: "Worse after lying down",
    });
  });

  it("makes a missing historical dose amount explicit", () => {
    const events = illnessTimelineEvents(
      ep({
        medications: [
          {
            itemId: 7,
            name: "Ibuprofen",
            count: 1,
            administrations: [
              {
                id: 9,
                date: "2026-06-02",
                time: "9:15 AM",
                time24: "09:15",
                amount: null,
              },
            ],
          },
        ],
      })
    );

    expect(events[0]?.detail).toBe("Amount not recorded");
  });

  it("uses relative calendar labels for an ongoing episode", () => {
    expect(relativeEpisodeDateLabel("2026-06-04", "2026-06-04")).toBe("Today");
    expect(relativeEpisodeDateLabel("2026-06-03", "2026-06-04")).toBe(
      "Yesterday"
    );
    expect(relativeEpisodeDateLabel("2026-05-31", "2026-06-04")).toBe(
      "4 days ago"
    );
  });
});

// #2612: the fever chart's dose lane gets a LEGEND, not the per-day table again.
// Bounded by DISTINCT medication and then by summarizeNames' "and N more" tail, so
// the caption's length is independent of how many doses the window holds.
describe("doseLaneRoster (#2612)", () => {
  const med = (name: string, count: number): EpisodeMedication => ({
    itemId: name.length,
    name,
    count,
    administrations: Array.from({ length: count }, (_, index) => ({
      id: index,
      date: "2026-07-16",
      time: "19:03",
      time24: "19:03",
      amount: "200 mg",
      product: null,
    })),
  });

  it("names each medication once, with its dose count", () => {
    expect(doseLaneRoster([med("Ibuprofen", 5), med("Iron", 2)])).toBe(
      "Ibuprofen ×5 · Iron ×2"
    );
  });

  it("orders by dose count so the truncated tail drops the least-used", () => {
    expect(
      doseLaneRoster([med("Iron", 2), med("Ibuprofen", 5), med("Whey", 3)])
    ).toBe("Ibuprofen ×5 · Whey ×3 · Iron ×2");
  });

  it("counts the rest rather than growing — 28 doses across 6 items is one line", () => {
    const stack = [
      med("Ibuprofen", 5),
      med("Whey", 5),
      med("Creatine", 5),
      med("Iron", 5),
      med("Calcium", 5),
      med("Zinc", 3),
    ];
    // Ties break by NAME, so the same stack always prints the same line.
    expect(doseLaneRoster(stack)).toBe(
      "Calcium ×5 · Creatine ×5 · Ibuprofen ×5 and 3 more"
    );
  });

  it("skips a medication with no administrations, and answers empty for none at all", () => {
    expect(doseLaneRoster([med("Ibuprofen", 0)])).toBe("");
    expect(doseLaneRoster([])).toBe("");
  });
});

// ── THE RECOVERY-LED HEADER'S THREE STRINGS (#4752 item 1) ──────────────────
//
// The header IS the status, so what it says is decided here rather than in JSX.
// The cases that matter are the ones where the clock does NOT exist: with nothing
// measured there is no ring to draw and no sentence about the person that the data
// has earned, and a ring at zero would look exactly like a ring that does not apply.
describe("the cockpit recovery header (#4752 item 1)", () => {
  const recovery = (clearedForHours: number | null, met = false) => ({
    clearedForHours,
    thresholdHours: 24,
    met,
    label: "Fever-free 22h of 24",
  });

  it.each([
    ["no clock at all is the name and nothing more", null, "Dune"],
    ["nothing measured is the name and nothing more", recovery(null), "Dune"],
    ["past halfway is nearly there", recovery(12), "Dune is nearly there"],
    ["short of halfway is on the mend", recovery(11), "Dune is on the mend"],
    [
      "a met convention says so outright",
      recovery(24, true),
      "Dune is fever-free",
    ],
  ] as const)("headline: %s", (_name, input, expected) => {
    expect(cockpitRecoveryHeadline("Dune", input)).toBe(expected);
  });

  it.each([
    ["no clock is undrawable, not zero", null, null],
    ["nothing measured is undrawable", recovery(null), null],
    ["a partial clock is its fraction", recovery(12), 0.5],
    ["a clock past its threshold clamps at full", recovery(30), 1],
    [
      "a zero-hour convention is already met",
      { ...recovery(0), thresholdHours: 0 },
      1,
    ],
  ] as const)("ring: %s", (_name, input, expected) => {
    expect(cockpitRecoveryFraction(input)).toBe(expected);
  });

  // ONE LINE, THREE CLAUSES, and an absent fact says so in the same breath rather
  // than printing "Not logged" under a heading of its own.
  const status = (
    over: Partial<ReturnType<typeof baseStatus>> = {}
  ): ReturnType<typeof baseStatus> => ({ ...baseStatus(), ...over });
  function baseStatus() {
    return {
      dayLabel: "Illness · Day 3",
      dayOnlyLabel: "Day 3",
      temperature: {
        id: 1,
        value: "97.5 °F",
        when: "13h ago",
        high: false,
      } as {
        id: number;
        value: string;
        when: string | null;
        high: boolean;
      } | null,
      lastMeds: {
        id: 2,
        name: "Ibuprofen",
        dose: "160 mg",
        when: "yesterday 11:30 PM",
      } as {
        id: number;
        name: string;
        dose: string | null;
        when: string | null;
      } | null,
      worsening: false,
    };
  }

  it("folds the recovery clause, the last reading and the last dose into one line", () => {
    expect(cockpitSummaryLine(status(), recovery(22))).toBe(
      "Fever-free 22h of 24 · last reading 97.5 °F 13h ago · last med Ibuprofen yesterday 11:30 PM"
    );
  });

  it("names what is missing instead of dropping the clause", () => {
    expect(
      cockpitSummaryLine(status({ temperature: null, lastMeds: null }), null)
    ).toBe("no temperature logged · no meds logged");
  });
});

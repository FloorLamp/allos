import { describe, it, expect } from "vitest";
import {
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
      temperature: {
        value: "101.3 °F",
        when: "at 12:05 AM (18 hrs ago)",
        high: true,
      },
      lastMeds: {
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
      "last acetaminophen · 160 mg / 5 mL 4:02 PM"
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
      { profileId: 2, isActive: false, start: "2026-06-01" },
      { profileId: 1, isActive: true, start: "2026-06-05" },
    ]);
    expect(ordered.map((c) => c.profileId)).toEqual([1, 2]);
  });
  it("orders other profiles by episode start (earliest first), then profileId", () => {
    const ordered = orderIllnessCockpits([
      { profileId: 5, isActive: false, start: "2026-06-03" },
      { profileId: 3, isActive: false, start: "2026-06-01" },
      { profileId: 4, isActive: false, start: "2026-06-01" },
    ]);
    expect(ordered.map((c) => c.profileId)).toEqual([3, 4, 5]);
  });
  it("sorts a null (before-log) start after known starts", () => {
    const ordered = orderIllnessCockpits([
      { profileId: 7, isActive: false, start: null },
      { profileId: 6, isActive: false, start: "2026-06-02" },
    ]);
    expect(ordered.map((c) => c.profileId)).toEqual([6, 7]);
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

import { describe, it, expect } from "vitest";
import { buildSwimlane } from "../care-trail-swimlane";
import { buildCareTrail } from "../care-trail";
import type {
  CareTrailEpisodeInput,
  CareTrailVisitInput,
  CareTrailCourseInput,
} from "../care-trail";

const WIN_START = "2026-01-01";
const WIN_END = "2026-12-31"; // 364-day window

function episode(
  over: Partial<CareTrailEpisodeInput> & {
    profileId: number;
    episodeId: number;
  }
): CareTrailEpisodeInput {
  return {
    situation: "Cold",
    firstDay: "2026-06-01",
    lastActiveDay: "2026-06-07",
    ongoing: false,
    dayCount: 7,
    maxTempF: 101,
    symptomLabels: [],
    outcome: null,
    promotedConditionName: null,
    rangeStart: "2026-06-01",
    rangeEndInclusive: "2026-06-07",
    linkedEncounterIds: [],
    ...over,
  };
}

describe("buildSwimlane", () => {
  it("collapses (hasData false) when nothing falls in the window", () => {
    const build = buildCareTrail(
      [
        episode({
          profileId: 1,
          episodeId: 1,
          firstDay: "2025-01-01",
          lastActiveDay: "2025-01-05",
        }),
      ],
      [],
      []
    );
    const s = buildSwimlane(build, [1], WIN_START, WIN_END);
    expect(s.hasData).toBe(false);
  });

  it("positions an episode bar by its span and one lane per member in order", () => {
    const build = buildCareTrail(
      [
        episode({ profileId: 1, episodeId: 1 }),
        episode({
          profileId: 2,
          episodeId: 2,
          firstDay: "2026-06-03",
          lastActiveDay: "2026-06-09",
        }),
      ],
      [],
      []
    );
    const s = buildSwimlane(build, [1, 2], WIN_START, WIN_END);
    expect(s.hasData).toBe(true);
    expect(s.lanes.map((l) => l.profileId)).toEqual([1, 2]);
    const bar = s.lanes[0].episodes[0];
    // Jun 1 sits ~41% across a Jan1..Dec31 window; a 6-day span is a small positive width.
    expect(bar.leftPct).toBeGreaterThan(35);
    expect(bar.leftPct).toBeLessThan(45);
    expect(bar.widthPct).toBeGreaterThan(0);
    // same-date overlap is geometry: lane 2 starts slightly right of lane 1
    expect(s.lanes[1].episodes[0].leftPct).toBeGreaterThan(bar.leftPct);
  });

  it("puts a LINKED visit marker on the bar and an UNLINKED visit on the baseline", () => {
    const linked: CareTrailVisitInput = {
      profileId: 1,
      encounterId: 10,
      date: "2026-06-03",
      endDate: null,
      type: "Urgent care",
      reason: null,
      providerId: 9,
      providerName: "Dr. Ng",
      locationName: null,
    };
    const unlinked: CareTrailVisitInput = {
      ...linked,
      encounterId: 11,
      date: "2026-08-01",
      type: "Dental",
    };
    const build = buildCareTrail(
      [episode({ profileId: 1, episodeId: 1, linkedEncounterIds: [10] })],
      [linked, unlinked],
      []
    );
    const s = buildSwimlane(build, [1], WIN_START, WIN_END);
    const lane = s.lanes[0];
    expect(lane.episodes[0].visitMarkers.map((m) => m.encounterId)).toEqual([
      10,
    ]);
    expect(lane.visitMarkers.map((m) => m.encounterId)).toEqual([11]);
  });

  it("renders a course sub-bar and flags overhang past the episode end", () => {
    const course: CareTrailCourseInput = {
      profileId: 1,
      courseId: 20,
      itemId: 2,
      medName: "Amoxicillin",
      startedOn: "2026-06-02",
      stoppedOn: "2026-06-12", // past Jun-7 episode end
      open: false,
      stopReason: "completed_course",
      rx: true,
      asNeeded: false,
      prescriberProviderId: null,
      administrationDates: [],
    };
    const build = buildCareTrail(
      [episode({ profileId: 1, episodeId: 1 })],
      [],
      [course]
    );
    const s = buildSwimlane(build, [1], WIN_START, WIN_END);
    const bars = s.lanes[0].episodes[0].courseBars;
    expect(bars).toHaveLength(1);
    expect(bars[0].overhang).toBe(true);
    expect(bars[0].widthPct).toBeGreaterThan(0);
  });
});

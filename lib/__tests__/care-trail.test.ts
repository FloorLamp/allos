import { describe, it, expect } from "vitest";
import {
  buildCareTrail,
  careTrailRows,
  courseStateLabel,
  courseOverhangDays,
  normalizeCareTrailKind,
  perMemberEpisodeStats,
  type CareTrailEpisodeInput,
  type CareTrailVisitInput,
  type CareTrailCourseInput,
} from "../care-trail";
import {
  classifyEpisodeMed,
  type EpisodeMedInput,
} from "../episode-med-reconcile";

// ── fixtures ──────────────────────────────────────────────────────────────────

// One member (profile 1) with a Cold episode [Jun 1 .. Jun 7]. A linked urgent-care visit
// on Jun 2 (Day 2), an unlinked routine dental visit on Jun 4, and an Amoxicillin course
// started Jun 2 whose prescriber (provider 9) matches the urgent-care visit's provider.
const episode: CareTrailEpisodeInput = {
  profileId: 1,
  episodeId: 100,
  situation: "Cold",
  firstDay: "2026-06-01",
  lastActiveDay: "2026-06-07",
  ongoing: false,
  dayCount: 7,
  maxTempF: 101.2,
  symptomLabels: ["cough", "congestion"],
  outcome: null,
  promotedConditionName: null,
  rangeStart: "2026-06-01",
  rangeEndInclusive: "2026-06-07",
  linkedEncounterIds: [200],
};

const linkedVisit: CareTrailVisitInput = {
  profileId: 1,
  encounterId: 200,
  date: "2026-06-02",
  endDate: null,
  type: "Urgent care",
  reason: "Fever",
  providerId: 9,
  providerName: "Dr. Ng",
  locationName: null,
};

const unlinkedVisit: CareTrailVisitInput = {
  profileId: 1,
  encounterId: 201,
  date: "2026-06-04",
  endDate: null,
  type: "Dental",
  reason: "Cleaning",
  providerId: 5,
  providerName: "Dr. Molar",
  locationName: null,
};

const amoxCourse: CareTrailCourseInput = {
  profileId: 1,
  courseId: 300,
  itemId: 30,
  medName: "Amoxicillin",
  startedOn: "2026-06-02",
  stoppedOn: "2026-06-09", // runs 2 days past the episode's last active day (Jun 7)
  open: false,
  stopReason: "completed_course",
  rx: true,
  asNeeded: false,
  prescriberProviderId: 9, // matches the linked urgent-care visit
  administrationDates: [],
};

// ── pure helpers ────────────────────────────────────────────────────────────

describe("normalizeCareTrailKind", () => {
  it("defaults to illness and only accepts the two states", () => {
    expect(normalizeCareTrailKind(undefined)).toBe("illness");
    expect(normalizeCareTrailKind("garbage")).toBe("illness");
    expect(normalizeCareTrailKind("illness")).toBe("illness");
    // The URL param `visits` (+ decodes to space, so `illness+visits` isn't URL-safe)
    // maps to the illness+visits state; the internal value still round-trips too.
    expect(normalizeCareTrailKind("visits")).toBe("illness+visits");
    expect(normalizeCareTrailKind("illness+visits")).toBe("illness+visits");
  });
});

describe("courseStateLabel (existing vocabulary only)", () => {
  it("reads Open / Completed / the stop reason", () => {
    expect(courseStateLabel({ open: true, stopReason: null })).toBe("Open");
    expect(
      courseStateLabel({ open: false, stopReason: "completed_course" })
    ).toBe("Completed");
    expect(courseStateLabel({ open: false, stopReason: "side_effect" })).toBe(
      "Side effect"
    );
    expect(courseStateLabel({ open: false, stopReason: null })).toBe("Stopped");
  });
});

describe("courseOverhangDays", () => {
  it("counts whole days the course runs past the episode end", () => {
    expect(courseOverhangDays("2026-06-09", "2026-06-07")).toBe(2);
    expect(courseOverhangDays("2026-06-06", "2026-06-07")).toBe(0);
    expect(courseOverhangDays(null, "2026-06-07")).toBe(0);
    expect(courseOverhangDays("2026-06-09", null)).toBe(0);
  });
});

// ── the nested build ──────────────────────────────────────────────────────────

describe("buildCareTrail", () => {
  it("nests a linked visit under its episode with the cockpit day annotation", () => {
    const build = buildCareTrail([episode], [linkedVisit, unlinkedVisit], []);
    expect(build.episodes).toHaveLength(1);
    const ep = build.episodes[0];
    expect(ep.linkedVisits).toHaveLength(1);
    expect(ep.linkedVisits[0].encounterId).toBe(200);
    expect(ep.linkedVisits[0].dayNumber).toBe(2); // Jun 2 is day 2 of a Jun-1 episode
    expect(ep.linkedVisitCount).toBe(1);
    // the unlinked visit is held apart (never nested, never counted)
    expect(build.unlinkedVisits.map((v) => v.encounterId)).toEqual([201]);
  });

  it("nests a course by classifyEpisodeMed membership with the chain match + overhang", () => {
    const build = buildCareTrail([episode], [linkedVisit], [amoxCourse]);
    const ep = build.episodes[0];
    expect(ep.courses).toHaveLength(1);
    const c = ep.courses[0];
    expect(c.medName).toBe("Amoxicillin");
    expect(c.dayNumber).toBe(2);
    expect(c.stateLabel).toBe("Completed");
    expect(c.overhangDays).toBe(2);
    // prescriber provider 9 matches the linked urgent-care visit → provable chain
    expect(c.chainVisit).not.toBeNull();
    expect(c.chainVisit?.encounterId).toBe(200);
    expect(c.chainVisit?.dayNumber).toBe(2);
  });

  it("does not invent a chain when the prescriber matches no linked visit", () => {
    const noMatch = { ...amoxCourse, prescriberProviderId: 999 };
    const build = buildCareTrail([episode], [linkedVisit], [noMatch]);
    expect(build.episodes[0].courses[0].chainVisit).toBeNull();
  });

  it("excludes a course whose start falls outside the episode window", () => {
    const early = {
      ...amoxCourse,
      courseId: 301,
      startedOn: "2026-05-01", // before the window
    };
    const build = buildCareTrail([episode], [linkedVisit], [early]);
    expect(build.episodes[0].courses).toHaveLength(0);
  });

  it("nests a multi-episode-linked visit under EACH episode with per-episode day math", () => {
    const secondEpisode: CareTrailEpisodeInput = {
      ...episode,
      episodeId: 101,
      firstDay: "2026-06-02",
      lastActiveDay: "2026-06-08",
      rangeStart: "2026-06-02",
      rangeEndInclusive: "2026-06-08",
      linkedEncounterIds: [200],
    };
    const build = buildCareTrail([episode, secondEpisode], [linkedVisit], []);
    const byId = new Map(build.episodes.map((e) => [e.episodeId, e]));
    expect(byId.get(100)!.linkedVisits[0].dayNumber).toBe(2); // Jun 2 of a Jun-1 episode
    expect(byId.get(101)!.linkedVisits[0].dayNumber).toBe(1); // Jun 2 of a Jun-2 episode
    // linked to both → never counted as unlinked
    expect(build.unlinkedVisits).toHaveLength(0);
  });
});

// Course membership is the SAME classifyEpisodeMed window classification the reconcile
// uses — never a second derivation. Pin it: for the same med + window, the trail includes
// the course iff classifyEpisodeMed returns associated.
describe("course membership == classifyEpisodeMed (one computation)", () => {
  const medInput = (createdOn: string): EpisodeMedInput => ({
    itemId: 30,
    name: "Amoxicillin",
    asNeeded: false,
    rx: true,
    hasOpenCourse: true,
    createdOn,
    administrationDates: [],
  });
  const range = { start: "2026-06-01", endInclusive: "2026-06-07" };

  it("agrees on an in-window course", () => {
    const inWindow = { ...amoxCourse, startedOn: "2026-06-03" };
    const build = buildCareTrail([episode], [], [inWindow]);
    expect(build.episodes[0].courses).toHaveLength(1);
    expect(classifyEpisodeMed(medInput("2026-06-03"), range)).not.toBeNull();
  });

  it("agrees on an out-of-window course", () => {
    const outWindow = { ...amoxCourse, startedOn: "2026-05-20" };
    const build = buildCareTrail([episode], [], [outWindow]);
    expect(build.episodes[0].courses).toHaveLength(0);
    expect(classifyEpisodeMed(medInput("2026-05-20"), range)).toBeNull();
  });
});

// ── toggle partition ──────────────────────────────────────────────────────────

describe("careTrailRows toggle", () => {
  it("illness = episodes only (linked visits stay nested); illness+visits adds unlinked", () => {
    const build = buildCareTrail([episode], [linkedVisit, unlinkedVisit], []);
    const illness = careTrailRows(build, "illness");
    expect(illness.map((r) => r.kind)).toEqual(["episode"]);
    // the linked visit never becomes a standalone row in either mode
    expect(
      illness.some((r) => r.kind === "visit" && r.encounterId === 200)
    ).toBe(false);

    const withVisits = careTrailRows(build, "illness+visits");
    const standaloneIds = withVisits
      .filter((r) => r.kind === "visit")
      .map((r) => (r.kind === "visit" ? r.encounterId : 0));
    expect(standaloneIds).toEqual([201]); // only the UNLINKED visit
  });

  it("sorts rows most-recent first", () => {
    const older: CareTrailEpisodeInput = {
      ...episode,
      episodeId: 99,
      firstDay: "2026-01-01",
      lastActiveDay: "2026-01-05",
      linkedEncounterIds: [],
    };
    const build = buildCareTrail([older, episode], [], []);
    const rows = careTrailRows(build, "illness");
    expect(rows.map((r) => (r.kind === "episode" ? r.episodeId : 0))).toEqual([
      100, 99,
    ]);
  });
});

// ── stats ───────────────────────────────────────────────────────────────────

describe("perMemberEpisodeStats", () => {
  it("counts, averages duration, and reports the last month per member", () => {
    const build = buildCareTrail(
      [
        episode,
        {
          ...episode,
          episodeId: 101,
          firstDay: "2026-03-10",
          lastActiveDay: "2026-03-13",
          dayCount: 4,
          linkedEncounterIds: [],
        },
      ],
      [],
      []
    );
    const stats = perMemberEpisodeStats(build.episodes, 2026);
    expect(stats).toHaveLength(1);
    expect(stats[0].episodeCount).toBe(2);
    expect(stats[0].episodesThisYear).toBe(2);
    expect(stats[0].avgDurationDays).toBe(6); // (7 + 4) / 2 = 5.5 → 6
    expect(stats[0].lastMonth).toBe("2026-06");
  });
});

import { describe, expect, it } from "vitest";
import {
  compactList,
  countTone,
  dateFromCreatedAt,
  flagTone,
  groupTimelineDays,
  journalActivityHref,
  medicalRecordHref,
  normalizeTimelineRange,
  parseDetailItems,
  parseUtcStamp,
  protocolTimelineEvents,
  sortTimelineEvents,
  timeFromCreatedAt,
  timelineCategoryFromParam,
  timelineCategoryLabel,
  timelineDateFromParam,
  visitLinkedRefs,
  type TimelineEvent,
} from "../timeline-format";

describe("timeline formatting", () => {
  const events: TimelineEvent[] = [
    {
      id: "body:1",
      date: "2026-07-01",
      category: "body",
      title: "Weight",
    },
    {
      id: "activity:2",
      date: "2026-07-02",
      category: "activity",
      title: "Evening run",
      sortTime: "18:00",
      iconType: "cardio",
      iconTitle: "Evening run",
    },
    {
      id: "document:3",
      date: "2026-07-02",
      category: "document",
      title: "Lab report",
      sortTime: "09:00",
    },
  ];

  it("sorts newest dates first, then latest time within a date", () => {
    expect(sortTimelineEvents(events).map((e) => e.id)).toEqual([
      "activity:2",
      "document:3",
      "body:1",
    ]);
  });

  it("groups sorted events by day", () => {
    expect(groupTimelineDays(events)).toEqual([
      {
        date: "2026-07-02",
        events: [events[1], events[2]],
      },
      {
        date: "2026-07-01",
        events: [events[0]],
      },
    ]);
  });

  it("compacts long detail lists", () => {
    expect(compactList(["LDL", "HDL", "A1c", "Ferritin"], 3)).toBe(
      "LDL, HDL, A1c +1 more"
    );
  });

  it("labels categories for display", () => {
    expect(timelineCategoryLabel("immunization")).toBe("Immunization");
    expect(timelineCategoryLabel("visit")).toBe("Visit");
  });

  it("parses category params defensively", () => {
    expect(timelineCategoryFromParam("activity")).toBe("activity");
    expect(timelineCategoryFromParam(["body", "activity"])).toBe("body");
    expect(timelineCategoryFromParam("bogus")).toBeUndefined();
    expect(timelineCategoryFromParam(undefined)).toBeUndefined();
  });

  it("parses date params defensively", () => {
    expect(timelineDateFromParam(" 2026-07-07 ")).toBe("2026-07-07");
    expect(timelineDateFromParam(["2026-01-01", "2026-02-01"])).toBe(
      "2026-01-01"
    );
    expect(timelineDateFromParam("2026-02-30")).toBeUndefined();
    expect(timelineDateFromParam(["not-a-date"])).toBeUndefined();
    expect(timelineDateFromParam(undefined)).toBeUndefined();
  });

  it("normalizes reversed date ranges", () => {
    expect(normalizeTimelineRange("2026-07-10", "2026-07-01")).toEqual({
      from: "2026-07-01",
      to: "2026-07-10",
    });
    expect(normalizeTimelineRange("2026-07-01", undefined)).toEqual({
      from: "2026-07-01",
      to: undefined,
    });
  });

  it("builds journal deep links for activities", () => {
    expect(journalActivityHref(42)).toBe("/training?tab=log#activity-42");
  });

  it("allows activity events to carry activity-icon metadata", () => {
    expect(events[1].iconType).toBe("cardio");
    expect(events[1].iconTitle).toBe("Evening run");
  });
});

describe("timeline event helpers", () => {
  it("maps a single result flag to a tone", () => {
    expect(flagTone("high")).toBe("bad");
    expect(flagTone("low")).toBe("bad");
    expect(flagTone("abnormal")).toBe("bad");
    expect(flagTone("non-optimal-high")).toBe("warn");
    expect(flagTone(null)).toBe("default");
    expect(flagTone("normal")).toBe("default");
  });

  it("maps panel abnormal/non-optimal counts to a tone", () => {
    expect(countTone(2, 0)).toBe("bad");
    expect(countTone(0, 3)).toBe("warn");
    expect(countTone(1, 5)).toBe("bad"); // abnormal wins
    expect(countTone(0, 0)).toBe("default");
  });

  it("builds the medical panel href by specificity", () => {
    expect(medicalRecordHref(42, ["LDL", "HDL"], "LDL")).toBe("/import/42");
    expect(medicalRecordHref(null, ["LDL"], "LDL")).toBe(
      "/biomarkers/view?name=LDL"
    );
    expect(medicalRecordHref(null, ["A B"], "A B")).toBe(
      "/biomarkers/view?name=A%20B"
    );
    expect(medicalRecordHref(null, ["LDL", "HDL"], "LDL")).toBe(
      "/results/biomarkers"
    );
    expect(medicalRecordHref(null, [], null)).toBe("/results/biomarkers");
  });

  it("parses pipe-delimited detail-item payloads", () => {
    expect(
      parseDetailItems("Glucose::130::mg/dL::high||HDL::55::mg/dL::")
    ).toEqual([
      { label: "Glucose", value: "130", unit: "mg/dL", flag: "high" },
      { label: "HDL", value: "55", unit: "mg/dL" },
    ]);
    expect(parseDetailItems("Vitamin D::1 cap")).toEqual([
      { label: "Vitamin D", value: "1 cap" },
    ]);
    // Nothing usable → undefined (so callers can omit the field).
    expect(parseDetailItems("")).toBeUndefined();
    expect(parseDetailItems(null)).toBeUndefined();
    expect(parseDetailItems("::just a value")).toBeUndefined();
  });

  it("parses UTC-stored timestamps (SQLite datetime and ISO forms)", () => {
    expect(parseUtcStamp("2026-07-07 02:30:00")?.toISOString()).toBe(
      "2026-07-07T02:30:00.000Z"
    );
    expect(parseUtcStamp("2026-07-07T02:30:00Z")?.toISOString()).toBe(
      "2026-07-07T02:30:00.000Z"
    );
    expect(parseUtcStamp(null)).toBeNull();
    expect(parseUtcStamp("")).toBeNull();
    expect(parseUtcStamp("not-a-date")).toBeNull();
  });

  it("shapes protocol start/end timeline events", () => {
    const ongoing = protocolTimelineEvents([
      {
        id: 5,
        name: "Creatine 5 g/day",
        start_date: "2026-05-01",
        end_date: null,
      },
    ]);
    expect(ongoing).toHaveLength(1);
    expect(ongoing[0]).toMatchObject({
      id: "protocol-start:5",
      date: "2026-05-01",
      category: "protocol",
      title: "Started Creatine 5 g/day",
      href: "/protocols/5",
      tone: "good",
    });

    const ended = protocolTimelineEvents([
      {
        id: 7,
        name: "Sauna block",
        start_date: "2026-05-01",
        end_date: "2026-06-01",
      },
    ]);
    expect(ended.map((e) => e.id)).toEqual([
      "protocol-start:7",
      "protocol-end:7",
    ]);
    expect(ended[1]).toMatchObject({
      date: "2026-06-01",
      title: "Ended Sauna block",
      category: "protocol",
    });
  });

  it("shapes visit lineage rows into labeled, domain-routed linked refs (#662)", () => {
    const refs = visitLinkedRefs([
      { kind: "procedure", label: "Colonoscopy" },
      { kind: "care-plan", label: "Follow-up in 6 months" },
      { kind: "medication", label: "Lisinopril" },
    ]);
    expect(refs).toEqual([
      { label: "Procedure: Colonoscopy", href: "/records/history/procedures" },
      {
        label: "Care plan: Follow-up in 6 months",
        href: "/records/care/overview",
      },
      { label: "Medication: Lisinopril", href: "/medications" },
    ]);
  });

  it("drops blank-named lineage rows and trims labels", () => {
    const refs = visitLinkedRefs([
      { kind: "procedure", label: "  X-ray  " },
      { kind: "care-plan", label: "   " },
      { kind: "medication", label: "" },
    ]);
    expect(refs).toEqual([
      { label: "Procedure: X-ray", href: "/records/history/procedures" },
    ]);
  });

  it("derives created-at date/time in the profile timezone (off-by-one safe)", () => {
    // 02:30 UTC is still the previous evening in America/New_York (UTC-4 in July).
    const stamp = "2026-07-07 02:30:00";
    expect(dateFromCreatedAt(stamp, "UTC")).toBe("2026-07-07");
    expect(dateFromCreatedAt(stamp, "America/New_York")).toBe("2026-07-06");
    expect(timeFromCreatedAt(stamp, "UTC")).toBe("02:30");
    expect(timeFromCreatedAt(stamp, "America/New_York")).toBe("22:30");
    expect(dateFromCreatedAt(null, "UTC")).toBeNull();
    expect(timeFromCreatedAt("", "UTC")).toBeNull();
  });
});

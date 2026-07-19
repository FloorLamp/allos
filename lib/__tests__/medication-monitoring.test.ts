import { describe, expect, it } from "vitest";
import {
  buildMedMonitoring,
  monitoringLabFamilyKey,
  monitoringRowNoteText,
  monitoringNotesForMed,
  medMonitoringTitle,
  medMonitoringDetail,
  medMonitoringSignalKey,
  MONITORING_INIT_WINDOW_DAYS,
  type MonitoredMedInput,
} from "@/lib/medication-monitoring";
import { shiftDateStr } from "@/lib/date";

// Pure boundary tests for the medication → required-monitoring-lab bridge (issue #995):
// the builder over (active med + start/change dates + last relevant lab date) → the
// expected due-retest with its reason, across init vs maintenance; a matching lab
// satisfies/resets it; a med with no dataset entry emits nothing.

const TODAY = "2026-07-19";
const lithium = (over: Partial<MonitoredMedInput> = {}): MonitoredMedInput => ({
  id: 1,
  name: "Lithium",
  rxcui: null,
  rxcuiIngredients: null,
  startDate: "2020-01-01",
  recentChangeDate: "2020-01-01",
  ...over,
});

// Family key helper so tests seed the lab-date map exactly as the gather does.
const fam = monitoringLabFamilyKey;

describe("buildMedMonitoring — matching", () => {
  it("emits nothing for a med with no dataset entry", () => {
    const hits = buildMedMonitoring(
      [
        {
          id: 9,
          name: "Ibuprofen",
          rxcui: null,
          startDate: "2020-01-01",
          recentChangeDate: "2020-01-01",
        },
      ],
      new Map(),
      TODAY
    );
    expect(hits).toEqual([]);
  });

  it("emits nothing when every monitoring lab is fresh (satisfied)", () => {
    // A recent reading for each of lithium's labs, all within the maintenance cadence.
    const recent = shiftDateStr(TODAY, -10);
    const labDates = new Map<string, string>([
      [fam("Lithium"), recent],
      [fam("TSH"), recent],
      [fam("Creatinine"), recent],
      [fam("eGFR"), recent],
      [fam("Calcium"), recent],
    ]);
    expect(buildMedMonitoring([lithium()], labDates, TODAY)).toEqual([]);
  });

  it("emits a retest hit when a monitoring lab is overdue, keyed med:entry", () => {
    // Lithium level drawn 400 days ago — past the 180-day maintenance cadence.
    const stale = shiftDateStr(TODAY, -400);
    const fresh = shiftDateStr(TODAY, -10);
    const labDates = new Map<string, string>([
      [fam("Lithium"), stale],
      [fam("TSH"), fresh],
      [fam("Creatinine"), fresh],
      [fam("eGFR"), fresh],
      [fam("Calcium"), fresh],
    ]);
    const hits = buildMedMonitoring([lithium()], labDates, TODAY);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit.dedupeKey).toBe(medMonitoringSignalKey(1, "lithium"));
    expect(hit.tier).toBe("care");
    expect(hit.kind).toBe("retest");
    expect(hit.dueLabs.map((l) => l.canonical)).toEqual(["Lithium"]);
    // Due date is the stale reading + the 180-day maintenance cadence.
    expect(hit.dueDate).toBe(shiftDateStr(stale, 180));
  });
});

describe("buildMedMonitoring — satisfaction is family-aware (#482)", () => {
  it("an eAG reading satisfies an HbA1c monitoring requirement", () => {
    // Antipsychotic metabolic monitoring requires 'Hemoglobin A1c'. An eAG reading is the
    // same #482 family, so it must satisfy the A1c clock. Give every OTHER metabolic lab a
    // fresh reading, and give the A1c family a fresh eAG reading — nothing should be due.
    const fresh = shiftDateStr(TODAY, -20);
    const labDates = new Map<string, string>([
      [fam("Estimated Average Glucose"), fresh], // eAG → family:hemoglobin-a1c
      [fam("Glucose"), fresh],
      [fam("LDL Cholesterol"), fresh],
      [fam("HDL Cholesterol"), fresh],
      [fam("Triglycerides"), fresh],
    ]);
    const olanzapine: MonitoredMedInput = {
      id: 4,
      name: "Olanzapine",
      rxcui: null,
      startDate: "2020-01-01",
      recentChangeDate: "2020-01-01",
    };
    // Sanity: eAG and HbA1c collapse to the same family key.
    expect(fam("Estimated Average Glucose")).toBe(fam("Hemoglobin A1c"));
    expect(buildMedMonitoring([olanzapine], labDates, TODAY)).toEqual([]);
  });
});

describe("buildMedMonitoring — init vs maintenance cadence", () => {
  it("uses the tighter init cadence within the post-start/-change window", () => {
    // Warfarin: init 7d, maintenance 30d. Started 30 days ago (inside the 90-day init
    // window), INR drawn 10 days ago. 10 > 7 (init) → due; but 10 < 30 (maintenance) → not
    // due if maintenance were used. So the init cadence is what makes it due.
    const start = shiftDateStr(TODAY, -30);
    const inr = shiftDateStr(TODAY, -10);
    const warfarin: MonitoredMedInput = {
      id: 2,
      name: "Warfarin",
      rxcui: null,
      startDate: start,
      recentChangeDate: start,
    };
    const labDates = new Map<string, string>([[fam("INR"), inr]]);
    const hits = buildMedMonitoring([warfarin], labDates, TODAY);
    expect(hits).toHaveLength(1);
    expect(hits[0].phase).toBe("init");
    expect(hits[0].cadenceDays).toBe(7);
  });

  it("uses the maintenance cadence once past the init window (a change > init window ago)", () => {
    // Same warfarin, but the last change was 200 days ago (past the 90-day window) and INR
    // drawn 10 days ago. 10 < 30 (maintenance) → NOT due.
    const start = shiftDateStr(TODAY, -200);
    const inr = shiftDateStr(TODAY, -10);
    const warfarin: MonitoredMedInput = {
      id: 2,
      name: "Warfarin",
      rxcui: null,
      startDate: start,
      recentChangeDate: start,
    };
    const labDates = new Map<string, string>([[fam("INR"), inr]]);
    expect(buildMedMonitoring([warfarin], labDates, TODAY)).toEqual([]);
  });

  it("treats a recent dose change as re-opening the tighter init window", () => {
    const start = shiftDateStr(TODAY, -300); // long ago
    const change = shiftDateStr(TODAY, -10); // recent dose change
    const inr = shiftDateStr(TODAY, -8);
    const warfarin: MonitoredMedInput = {
      id: 2,
      name: "Warfarin",
      rxcui: null,
      startDate: start,
      recentChangeDate: change,
    };
    const labDates = new Map<string, string>([[fam("INR"), inr]]);
    const hits = buildMedMonitoring([warfarin], labDates, TODAY);
    // 8 days since INR > 7-day init cadence → due, on the init cadence (re-opened window).
    expect(hits).toHaveLength(1);
    expect(hits[0].phase).toBe("init");
  });

  it("the init window boundary is inclusive at MONITORING_INIT_WINDOW_DAYS", () => {
    const start = shiftDateStr(TODAY, -MONITORING_INIT_WINDOW_DAYS);
    const w: MonitoredMedInput = {
      id: 2,
      name: "Warfarin",
      rxcui: null,
      startDate: start,
      recentChangeDate: start,
    };
    // INR 8 days ago → init(7) due, maintenance(30) not — so a hit proves init still applies.
    const labDates = new Map<string, string>([
      [fam("INR"), shiftDateStr(TODAY, -8)],
    ]);
    expect(buildMedMonitoring([w], labDates, TODAY)[0]?.phase).toBe("init");
  });
});

describe("buildMedMonitoring — baseline", () => {
  it("surfaces a baseline hit for a newly-monitored med with no labs on file", () => {
    const start = shiftDateStr(TODAY, -3);
    const hits = buildMedMonitoring(
      [lithium({ startDate: start, recentChangeDate: start })],
      new Map(), // nothing on file
      TODAY
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("baseline");
    expect(hits[0].dueDate).toBe(TODAY);
    // Every required lab is listed as due (none on file).
    expect(hits[0].dueLabs.length).toBe(5);
    expect(medMonitoringTitle(hits[0])).toBe("Baseline labs for Lithium");
  });

  it("a non-baseline drug with no reading isn't nagged until the first cadence elapses", () => {
    // Metformin (baseline:false, init 90d). Started 10 days ago, no creatinine on file.
    // 10 < 90 → not yet due.
    const start = shiftDateStr(TODAY, -10);
    const metformin: MonitoredMedInput = {
      id: 5,
      name: "Metformin",
      rxcui: null,
      startDate: start,
      recentChangeDate: start,
    };
    expect(buildMedMonitoring([metformin], new Map(), TODAY)).toEqual([]);
    // …but once past the maintenance cadence (started > 365 days ago) it becomes due.
    const older = shiftDateStr(TODAY, -400);
    const due = buildMedMonitoring(
      [{ ...metformin, startDate: older, recentChangeDate: older }],
      new Map(),
      TODAY
    );
    expect(due).toHaveLength(1);
    expect(due[0].kind).toBe("retest");
  });
});

describe("buildMedMonitoring — a med can match two entries", () => {
  it("clozapine emits both its ANC (care) and metabolic (coaching) monitors", () => {
    const clozapine: MonitoredMedInput = {
      id: 3,
      name: "Clozapine",
      rxcui: null,
      startDate: shiftDateStr(TODAY, -400),
      recentChangeDate: shiftDateStr(TODAY, -400),
    };
    const hits = buildMedMonitoring([clozapine], new Map(), TODAY);
    const byEntry = new Map(hits.map((h) => [h.entryKey, h]));
    expect(byEntry.get("clozapine")?.tier).toBe("care");
    expect(byEntry.get("second_gen_antipsychotic")?.tier).toBe("coaching");
  });
});

describe("copy + row note", () => {
  it("the row note lists every monitored lab for a med, deduped", () => {
    const note = monitoringRowNoteText({ name: "Lithium", rxcui: null });
    expect(note).toContain("Requires monitoring:");
    expect(note).toContain("lithium level");
    expect(note).toContain("TSH");
    expect(
      monitoringRowNoteText({ name: "Ibuprofen", rxcui: null })
    ).toBeNull();
  });

  it("exposes per-entry monitoring descriptors for the medications surface", () => {
    const notes = monitoringNotesForMed({ name: "Clozapine", rxcui: null });
    expect(notes.map((n) => n.entryKey).sort()).toEqual([
      "clozapine",
      "second_gen_antipsychotic",
    ]);
  });

  it("the detail is informational, never prescriptive, and cites its source", () => {
    const start = shiftDateStr(TODAY, -3);
    const hit = buildMedMonitoring(
      [lithium({ startDate: start, recentChangeDate: start })],
      new Map(),
      TODAY
    )[0];
    const detail = medMonitoringDetail(hit);
    expect(detail).toMatch(/discuss timing with your prescriber/i);
    expect(detail).toMatch(/not clearance/i);
    expect(detail).toMatch(/Source:/);
    // Never a directive.
    expect(detail).not.toMatch(/\byou must\b/i);
    expect(detail).not.toMatch(/\bget this test\b/i);
  });
});

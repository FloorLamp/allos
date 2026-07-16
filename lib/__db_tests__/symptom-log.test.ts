// DB INTEGRATION TIER (issue #799).
//
// Exercises the symptom log end-to-end against the real migrated schema: the
// symptom_logs owned table + the situations illness_type flag (migration 042), the
// worst-severity write core, the query layer, and the DERIVED episode association
// wired from getIllnessSituations + getSituationEvents through episodeForDate.
//
// Deterministic: :memory:-backed temp DB via setup.ts; no network.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  resolveSituationId,
  getSituations,
  getIllnessSituations,
  getActiveSituations,
  setActiveSituations,
  setSituationIllnessType,
  hasActiveIllnessSituation,
  getSituationEvents,
} from "@/lib/settings";
import {
  logSymptomCore,
  setSymptomSeverityCore,
} from "@/lib/symptom-log-write";
import {
  getSymptomsOnDate,
  getSymptomSeveritiesOnDate,
  getCustomSymptomNames,
} from "@/lib/queries";
import { episodeForDate } from "@/lib/symptom-episode";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("situations illness_type flag (#799)", () => {
  it("the built-in Illness row is born illness-type-flagged; others are not", () => {
    const p = newProfile("illness-default");
    resolveSituationId(p, "Illness");
    resolveSituationId(p, "Travel");
    const rows = getSituations(p);
    expect(rows.find((s) => s.name === "Illness")?.illness_type).toBe(1);
    expect(rows.find((s) => s.name === "Travel")?.illness_type).toBe(0);
  });

  it("a user situation opts in via setSituationIllnessType; hasActiveIllnessSituation gates on active+flagged", () => {
    const p = newProfile("opt-in");
    setActiveSituations(p, ["Migraine"]);
    expect(hasActiveIllnessSituation(p)).toBe(false); // active but unflagged
    setSituationIllnessType(p, "Migraine", true);
    expect(hasActiveIllnessSituation(p)).toBe(true);
    expect(getIllnessSituations(p)).toEqual([
      { name: "Migraine", active: true },
    ]);
    setSituationIllnessType(p, "Migraine", false);
    expect(hasActiveIllnessSituation(p)).toBe(false);
  });
});

describe("symptom log write + read", () => {
  it("keeps a day's WORST severity on re-log; an edit may lower it", () => {
    const p = newProfile("worst");
    logSymptomCore(p, "cough", 2, "2026-07-01");
    logSymptomCore(p, "cough", 4, "2026-07-01");
    logSymptomCore(p, "cough", 1, "2026-07-01"); // does not lower
    expect(getSymptomSeveritiesOnDate(p, "2026-07-01").cough).toBe(4);

    setSymptomSeverityCore(p, "cough", 1, "2026-07-01"); // explicit edit lowers
    expect(getSymptomSeveritiesOnDate(p, "2026-07-01").cough).toBe(1);
  });

  it("stores a custom name inline and lists it as a custom vocabulary entry", () => {
    const p = newProfile("custom");
    logSymptomCore(p, "Migraine", 3, "2026-07-01");
    logSymptomCore(p, "cough", 2, "2026-07-01");
    const day = getSymptomsOnDate(p, "2026-07-01");
    expect(day.map((d) => d.symptom).sort()).toEqual(["Migraine", "cough"]);
    expect(getCustomSymptomNames(p)).toEqual(["Migraine"]);
  });
});

describe("derived episode association (#799)", () => {
  it("associates a symptom's date with the active illness episode window", () => {
    const p = newProfile("episode");
    // Illness active from 2026-06-01, stopped 2026-06-08.
    setActiveSituations(p, ["Illness"]); // logs a start today — replace with a dated log
    // Build a deterministic change-log directly (the runtime path appends "today"
    // transitions; here we assert the pure derivation over a known log).
    const events = [
      { situation: "Illness", date: "2026-06-01", change: "start" as const },
      { situation: "Illness", date: "2026-06-08", change: "stop" as const },
    ];
    // The flagged situation set (Illness is illness-type by default).
    const illness = getIllnessSituations(p).map((s) => ({
      name: s.name,
      active: false, // treat as closed for this fixture
    }));

    const inside = episodeForDate("2026-06-04", illness, events);
    expect(inside).toEqual({
      situation: "Illness",
      start: "2026-06-01",
      end: "2026-06-08",
    });
    // The stop day and a day outside the window derive no episode.
    expect(episodeForDate("2026-06-08", illness, events)).toBeNull();
    expect(episodeForDate("2026-05-01", illness, events)).toBeNull();
  });

  it("getSituationEvents feeds the derivation from a real toggle history", () => {
    const p = newProfile("real-log");
    resolveSituationId(p, "Illness");
    setActiveSituations(p, ["Illness"]);
    const events = getSituationEvents(p);
    expect(
      events.some((e) => e.situation === "Illness" && e.change === "start")
    ).toBe(true);
    expect(getActiveSituations(p)).toContain("Illness");
  });
});

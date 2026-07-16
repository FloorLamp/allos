import { describe, it, expect } from "vitest";
import {
  makeNameClassifier,
  needsEquipment,
  analyzeActivityForm,
  buildActivityPayload,
  generateActivityTitle,
  resolveFormSessionDuration,
} from "@/lib/activity-form-validate";
import { blankPart, type PartEntry } from "@/lib/activity-form-model";
import type { ActivityType } from "@/lib/types";

// The picker vocabulary the classifier reads: lowercased name → type. Variant
// lifts ("Curl" → strength) resolve via the catalog even when absent here.
const typeByName = new Map<string, ActivityType>([
  ["dumbbell curl", "strength"],
  ["curl", "strength"],
  ["plank", "strength"],
  ["running", "cardio"],
  ["jog", "cardio"],
  ["tennis", "sport"],
]);
const classifier = makeNameClassifier(typeByName);

describe("resolveFormSessionDuration", () => {
  it("derives cardio-only totals from visible components, not stale standalone state", () => {
    expect(
      resolveFormSessionDuration({
        clockDuration: null,
        standaloneDuration: 30,
        componentDuration: 45,
        hasStrength: false,
      })
    ).toBe(45);
  });

  it("keeps the standalone total for strength/mixed sessions and lets clocks win", () => {
    expect(
      resolveFormSessionDuration({
        clockDuration: null,
        standaloneDuration: 75,
        componentDuration: 20,
        hasStrength: true,
      })
    ).toBe(75);
    expect(
      resolveFormSessionDuration({
        clockDuration: 60,
        standaloneDuration: 75,
        componentDuration: 20,
        hasStrength: true,
      })
    ).toBe(60);
  });
});

// A part builder over the model's blankPart, so new fields can't be missed.
function part(o: Partial<PartEntry>): PartEntry {
  return { ...blankPart(), ...o };
}
const set = (
  o: Partial<PartEntry["sets"][number]>
): PartEntry["sets"][number] => ({
  weight: "",
  reps: "",
  weightRight: "",
  repsRight: "",
  duration: "",
  durationRight: "",
  warmup: false,
  rpe: null,
  ...o,
});
const strengthPart = (name: string, o: Partial<PartEntry> = {}) =>
  part({ name, sets: [set({ weight: "50", reps: "10" })], ...o });

const session = (
  parts: PartEntry[],
  o: Partial<Parameters<typeof analyzeActivityForm>[1]> = {}
) =>
  analyzeActivityForm(classifier, {
    parts,
    startTime: "",
    endTime: "",
    date: "2026-07-10",
    ...o,
  });

describe("makeNameClassifier", () => {
  it("resolves type from the vocabulary, then variant catalog, else null", () => {
    expect(classifier.nameType("Running")).toBe("cardio");
    expect(classifier.nameType("Dumbbell Curl")).toBe("strength");
    // Not in the map but a real variant lift.
    const fresh = makeNameClassifier(new Map());
    expect(fresh.nameType("Barbell Curl")).toBe("strength");
    expect(fresh.nameType("Nonsense Activity")).toBeNull();
  });
  it("partType: nameless → null, custom → its own type, else the name's type", () => {
    expect(classifier.partType(part({ name: "" }))).toBeNull();
    expect(
      classifier.partType(
        part({ name: "Whatever", custom: true, customType: "sport" })
      )
    ).toBe("sport");
    expect(classifier.partType(part({ name: "Running" }))).toBe("cardio");
  });
  it("isCoined: a logged, non-curated cardio/sport name", () => {
    expect(classifier.isCoined("Jog")).toBe(true); // cardio, uncurated
    expect(classifier.isCoined("Running")).toBe(false); // curated
    expect(classifier.isCoined("Dumbbell Curl")).toBe(false); // strength
  });
  it("customFlags marks coined names custom with their vocabulary type", () => {
    expect(classifier.customFlags("Jog")).toEqual({
      custom: true,
      customType: "cardio",
    });
    expect(classifier.customFlags("Running")).toEqual({
      custom: false,
      customType: null,
    });
  });
});

describe("needsEquipment", () => {
  it("is true only for a bare variant base awaiting an implement", () => {
    expect(needsEquipment("Curl")).toBe(true); // bare base
    expect(needsEquipment("Dumbbell Curl")).toBe(false); // concrete variant
    expect(needsEquipment("Running")).toBe(false); // not a lift
  });
});

describe("analyzeActivityForm — save gating & blockers", () => {
  it("a pristine blank form can't save and asks for an activity", () => {
    const a = session([blankPart()]);
    expect(a.canSave).toBe(false);
    expect(a.namedParts).toHaveLength(0);
    expect(a.saveBlocker).toBe("Add an activity to start.");
  });
  it("a complete strength part saves cleanly", () => {
    const a = session([strengthPart("Dumbbell Curl")]);
    expect(a.canSave).toBe(true);
    expect(a.saveBlocker).toBeNull();
    expect(a.namedParts).toHaveLength(1);
    expect(a.canAddPart).toBe(true);
    expect(a.partFault(a.namedParts[0])).toBeNull();
  });
  it("an unrecognized, non-custom name blocks with the pick-or-add hint", () => {
    const a = session([part({ name: "Zumbaaa" })]);
    expect(a.canSave).toBe(false);
    expect(a.saveBlocker).toBe(
      "Pick an activity from the list, or add it as a new one."
    );
  });
  it("a typeless custom part asks for a type", () => {
    const a = session([
      part({ name: "My Thing", custom: true, customType: null }),
    ]);
    expect(a.saveBlocker).toBe(
      "Choose a type for the new activity — cardio or sport."
    );
  });
  it("a bare variant base without equipment faults on equipment", () => {
    const p = strengthPart("Curl"); // needsEquipment, equipmentId null
    const a = session([p]);
    expect(a.saveBlocker).toBe(
      "Choose equipment for the highlighted activity."
    );
    expect(a.partFault(p)).toBe("equipment");
    // Picking a concrete implement clears it.
    const ok = session([strengthPart("Dumbbell Curl", { equipmentId: 4 })]);
    expect(ok.canSave).toBe(true);
  });
  it("a half-filled set faults on set and blocks", () => {
    const p = part({ name: "Dumbbell Curl", sets: [set({ weight: "50" })] }); // reps missing
    const a = session([p]);
    expect(a.saveBlocker).toBe(
      "A set is only half-filled — finish it or clear it."
    );
    expect(a.partFault(p)).toBe("set");
  });
  it("a named but empty strength part faults on content", () => {
    const p = part({ name: "Dumbbell Curl", sets: [set({})] });
    const a = session([p]);
    expect(a.saveBlocker).toBe("Enter a set — weight & reps, or a hold time.");
    expect(a.partFault(p)).toBe("content");
  });
  it("an invalid hold time on a timed lift blocks", () => {
    const p = part({ name: "Plank", sets: [set({ duration: "notatime" })] });
    const a = session([p]);
    expect(a.saveBlocker).toBe("Enter the hold time as m:ss or seconds.");
  });
  it("a reversed time range blocks after the part checks pass", () => {
    const a = session([strengthPart("Dumbbell Curl")], {
      startTime: "10:00",
      endTime: "09:00",
    });
    expect(a.timeError).toBe(true);
    expect(a.canSave).toBe(false);
    expect(a.saveBlocker).toBe("End time must be after the start time.");
  });
  it("a cardio part is satisfied by a full time range alone", () => {
    const p = part({ name: "Running", custom: true, customType: "cardio" });
    const noRange = session([p]);
    expect(noRange.canSave).toBe(false);
    const withRange = session([p], { startTime: "08:00", endTime: "09:00" });
    expect(withRange.canSave).toBe(true);
  });
  it("an invalid date blocks even a complete part", () => {
    const a = session([strengthPart("Dumbbell Curl")], { date: "Friday" });
    expect(a.dateError).toBe(true);
    expect(a.canSave).toBe(false);
    expect(a.saveBlocker).toBe("Enter a valid date in YYYY-MM-DD format.");
  });
  it("canAddPart is false while the last part is unfinished", () => {
    const a = session([part({ name: "Dumbbell Curl", sets: [set({})] })]);
    expect(a.canAddPart).toBe(false);
  });
});

describe("generateActivityTitle", () => {
  it("falls back to New activity with nothing named", () => {
    expect(generateActivityTitle("", [], classifier)).toBe("New activity");
  });
  it("names a duration-prefixed cardio-only session", () => {
    const p = part({
      name: "Running",
      custom: true,
      customType: "cardio",
      durationMin: "30",
    });
    expect(generateActivityTitle("", [p], classifier)).toBe(
      "30 Min Running Session"
    );
  });
});

describe("buildActivityPayload", () => {
  it("shapes a single strength part into comps + flat + primaryType", () => {
    const p = strengthPart("Dumbbell Curl", { equipmentId: 3 });
    const { comps, flat, primaryType } = buildActivityPayload(classifier, [p]);
    expect(primaryType).toBe("strength");
    expect(comps).toEqual([
      {
        name: "Dumbbell Curl",
        type: "strength",
        distance: null,
        duration_min: null,
      },
    ]);
    expect(flat).toEqual([
      {
        exercise: "Dumbbell Curl",
        weight: 50,
        reps: 10,
        weightRight: null,
        repsRight: null,
        durationSec: null,
        durationSecRight: null,
        equipmentId: 3,
        targetReps: null,
        toFailure: false,
        warmup: false,
        rpe: null,
      },
    ]);
  });
  it("keeps a cardio component's distance/duration and no set rows", () => {
    const p = part({
      name: "Running",
      custom: true,
      customType: "cardio",
      distance: "5",
      durationMin: "30",
    });
    const { comps, flat, primaryType } = buildActivityPayload(classifier, [p]);
    expect(primaryType).toBe("cardio");
    expect(comps).toEqual([
      { name: "Running", type: "cardio", distance: 5, duration_min: 30 },
    ]);
    expect(flat).toHaveLength(0);
  });
  it("a mixed activity reports strength as the primary type", () => {
    const strength = strengthPart("Dumbbell Curl");
    const cardio = part({
      name: "Running",
      custom: true,
      customType: "cardio",
      durationMin: "20",
    });
    const { primaryType } = buildActivityPayload(classifier, [
      cardio,
      strength,
    ]);
    expect(primaryType).toBe("strength");
  });

  it("auto-fills a lone sport leg's empty Duration from the clock span (#791)", () => {
    // A sport part with Start/End but no typed Duration: the clock minutes land
    // ON the component, not just a placeholder — so its duration-only stats show
    // real minutes instead of a 0-minute session.
    const p = part({ name: "Tennis" });
    const { comps } = buildActivityPayload(classifier, [p], 55);
    expect(comps).toEqual([
      { name: "Tennis", type: "sport", distance: null, duration_min: 55 },
    ]);
  });

  it("auto-fills a lone cardio leg's empty Duration from the clock span (#791)", () => {
    const p = part({ name: "Running", distance: "5" });
    const { comps } = buildActivityPayload(classifier, [p], 30);
    expect(comps[0].duration_min).toBe(30);
  });

  it("never overrides a typed component Duration with the clock span (#791)", () => {
    const p = part({ name: "Tennis", durationMin: "40" });
    const { comps } = buildActivityPayload(classifier, [p], 55);
    expect(comps[0].duration_min).toBe(40);
  });

  it("leaves multi-part composite legs manual — no clock fill (#791)", () => {
    // Attributing the whole span to every leg would double-count per-leg stats;
    // the parent rollup already covers the session total via clock-wins.
    const swim = part({ name: "Running", distance: "1" });
    const bike = part({ name: "Tennis" });
    const { comps } = buildActivityPayload(classifier, [swim, bike], 90);
    expect(comps.map((c) => c.duration_min)).toEqual([null, null]);
  });

  it("does not fill a lone strength part from the clock span (#791)", () => {
    const p = strengthPart("Dumbbell Curl");
    const { comps } = buildActivityPayload(classifier, [p], 60);
    expect(comps[0].duration_min).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  buildMedicationList,
  medicationDoseDetail,
  medicationScheduleLabel,
  type MedicationListInput,
} from "@/lib/medication-list";

function input(over: Partial<MedicationListInput>): MedicationListInput {
  return {
    id: 1,
    name: "Med",
    brand: null,
    product: null,
    asNeeded: false,
    rx: false,
    prescriber: null,
    doseAmounts: [],
    timesOfDay: [],
    startedOn: null,
    ...over,
  };
}

describe("medicationDoseDetail (#852 item 4 — shared with the Emergency Card)", () => {
  it("joins distinct strengths and appends 'as needed' for a PRN med", () => {
    expect(medicationDoseDetail(["10 mg", "10 mg"], false)).toBe("10 mg");
    expect(medicationDoseDetail(["10 mg"], true)).toBe("10 mg · as needed");
    expect(medicationDoseDetail([], true)).toBe("as needed");
    expect(medicationDoseDetail([], false)).toBeNull();
  });
});

describe("medicationScheduleLabel (#852 item 4)", () => {
  it("reads PRN, distinct buckets, or the neutral fallback", () => {
    expect(medicationScheduleLabel([], true)).toBe("As needed (PRN)");
    expect(
      medicationScheduleLabel(["Morning", "Morning", "Evening"], false)
    ).toBe("Morning, Evening");
    expect(medicationScheduleLabel([null, ""], false)).toBe("Scheduled");
  });
});

describe("buildMedicationList (#852 item 4)", () => {
  it("assembles rows and sorts by name (case-insensitive)", () => {
    const rows = buildMedicationList([
      input({
        id: 2,
        name: "zoloft",
        brand: "Zoloft",
        asNeeded: false,
        rx: true,
        prescriber: "Dr. Ada Lovelace",
        doseAmounts: ["50 mg"],
        timesOfDay: ["Morning"],
        startedOn: "2024-01-02",
      }),
      input({
        id: 1,
        name: "Aspirin",
        asNeeded: true,
        doseAmounts: ["81 mg"],
        startedOn: "2023-06-01",
      }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Aspirin", "zoloft"]);
    expect(rows[0]).toMatchObject({
      name: "Aspirin",
      dose: "81 mg",
      schedule: "As needed (PRN)",
      prescriber: null,
      startedOn: "2023-06-01",
    });
    expect(rows[1]).toMatchObject({
      name: "zoloft",
      subtitle: "Zoloft",
      dose: "50 mg",
      schedule: "Morning",
      prescriber: "Dr. Ada Lovelace",
      startedOn: "2024-01-02",
      rx: true,
    });
  });

  it("is one computation: the same fixture yields identical rows for print and share", () => {
    const fixture = [
      input({ id: 1, name: "Metformin", doseAmounts: ["500 mg"] }),
    ];
    // The print page and the /share page both call buildMedicationList over the same
    // gather; a stable output is what lets those two surfaces never disagree.
    expect(buildMedicationList(fixture)).toEqual(buildMedicationList(fixture));
  });

  it("its dose column shares medicationDoseDetail's projection", () => {
    const rows = buildMedicationList([
      input({
        id: 1,
        name: "Ibuprofen",
        asNeeded: true,
        doseAmounts: ["200 mg"],
      }),
    ]);
    // The Emergency Card shows medicationDoseDetail(...); the list dose column is the
    // strength half of it (same distinct-strength join), so they can't drift.
    expect(medicationDoseDetail(["200 mg"], true)).toBe("200 mg · as needed");
    expect(rows[0].dose).toBe("200 mg");
  });
});

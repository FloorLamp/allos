import { describe, expect, it } from "vitest";
import {
  buildImmunizationRecord,
  immunizationRecordDoseCount,
  type ImmunizationRecordInput,
} from "@/lib/immunization-record";

// The printable immunization record (#1849). What matters for the artifact a
// registrar transcribes: every dose reachable under the vaccine a form asks about
// (a combination shot included), numbered within THAT series, in transcription
// order, with unstated facts left unstated.

function dose(
  over: Partial<ImmunizationRecordInput> & { id: number; date: string }
): ImmunizationRecordInput {
  return {
    vaccine: "influenza",
    dose_label: null,
    lot_number: null,
    route: null,
    site: null,
    provider_name: null,
    reaction: null,
    ...over,
  };
}

describe("buildImmunizationRecord", () => {
  it("groups by vaccine, ordering groups by name and doses oldest first", () => {
    const groups = buildImmunizationRecord([
      dose({ id: 1, date: "2024-10-02", vaccine: "influenza" }),
      dose({ id: 2, date: "2023-09-30", vaccine: "influenza" }),
      dose({ id: 3, date: "2022-01-05", vaccine: "hepa" }),
    ]);
    expect(groups.map((g) => g.code)).toEqual(["hepa", "influenza"]);
    expect(groups[1].doses.map((d) => d.date)).toEqual([
      "2023-09-30",
      "2024-10-02",
    ]);
  });

  it("carries every administration fact and leaves the unstated ones null", () => {
    const [group] = buildImmunizationRecord([
      dose({
        id: 7,
        date: "2025-03-04",
        vaccine: "tdap",
        lot_number: " LOT-9 ",
        route: "intramuscular",
        site: "  ",
        provider_name: "Anytown Family Clinic",
      }),
    ]);
    expect(group.doses[0]).toMatchObject({
      lot: "LOT-9",
      route: "intramuscular",
      site: null,
      provider: "Anytown Family Clinic",
      reaction: null,
    });
  });

  it("numbers doses within the series and honors an explicit dose label", () => {
    const groups = buildImmunizationRecord([
      dose({ id: 1, date: "2020-01-01", vaccine: "hepa" }),
      dose({
        id: 2,
        date: "2020-08-01",
        vaccine: "hepa",
        dose_label: "Booster (travel clinic)",
      }),
    ]);
    expect(groups[0].doses.map((d) => d.label)).toEqual([
      "Dose 1 of 2",
      "Booster (travel clinic)",
    ]);
  });

  it("credits a combination shot to each component and names the product", () => {
    const groups = buildImmunizationRecord([
      dose({ id: 1, date: "2021-05-01", vaccine: "proquad" }),
    ]);
    expect(groups.map((g) => g.code)).toEqual(["mmr", "varicella"]);
    for (const g of groups)
      expect(g.doses[0].product).toBe("ProQuad (MMR-Varicella)");
    // One stored dose, however many series it credits.
    expect(immunizationRecordDoseCount(groups)).toBe(1);
  });

  it("leaves the product column empty when the dose IS the group's vaccine", () => {
    const [group] = buildImmunizationRecord([
      dose({ id: 1, date: "2021-05-01", vaccine: "tdap" }),
    ]);
    expect(group.doses[0].product).toBeNull();
  });

  it("keeps an unknown vaccine slug under its own readable name", () => {
    const groups = buildImmunizationRecord([
      dose({ id: 1, date: "2021-05-01", vaccine: "tick_borne_thing" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Tick Borne Thing");
  });

  it("drops an undated dose — it can't be transcribed or numbered", () => {
    const groups = buildImmunizationRecord([
      dose({ id: 1, date: "", vaccine: "tdap" }),
      dose({ id: 2, date: "2021-05-01", vaccine: "tdap" }),
    ]);
    expect(groups[0].doses.map((d) => d.id)).toEqual([2]);
  });

  it("is empty for a profile with no doses", () => {
    expect(buildImmunizationRecord([])).toEqual([]);
    expect(immunizationRecordDoseCount([])).toBe(0);
  });
});

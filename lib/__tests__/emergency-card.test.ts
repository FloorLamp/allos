import { describe, expect, it } from "vitest";
import {
  allergySeverityRank,
  buildEmergencyCard,
  isEmergencyCardEmpty,
  normalizeBloodType,
  parseEmergencyPayload,
  serializeEmergencyPayload,
  type EmergencyCard,
  type EmergencyCardInput,
} from "@/lib/emergency-card";

const baseInput: EmergencyCardInput = {
  name: "Test Patient",
  age: 40,
  sex: "female",
  birthdate: "1985-04-01",
  manualBloodType: null,
  derivedBloodType: null,
  allergies: [],
  medications: [],
  conditions: [],
  contact: null,
  generatedAt: "2026-07-09T12:00:00.000Z",
};

describe("allergySeverityRank", () => {
  it("orders severe/anaphylaxis first, then moderate, mild, unknown", () => {
    expect(allergySeverityRank("Anaphylaxis")).toBe(0);
    expect(allergySeverityRank("severe")).toBe(0);
    expect(allergySeverityRank("Moderate")).toBe(1);
    expect(allergySeverityRank("mild")).toBe(2);
    expect(allergySeverityRank("weird")).toBe(3);
    expect(allergySeverityRank(null)).toBe(3);
  });
});

describe("buildEmergencyCard", () => {
  it("sorts allergies by severity then name and drops blank substances", () => {
    const card = buildEmergencyCard({
      ...baseInput,
      allergies: [
        { substance: "Pollen", reaction: "Rhinitis", severity: "mild" },
        { substance: "Peanuts", reaction: "Hives", severity: "moderate" },
        { substance: "Bee stings", reaction: "Swelling", severity: "severe" },
        { substance: "   ", reaction: null, severity: null },
      ],
    });
    expect(card.allergies.map((a) => a.substance)).toEqual([
      "Bee stings",
      "Peanuts",
      "Pollen",
    ]);
  });

  it("prefers the manual blood type over the lab-derived one", () => {
    expect(
      buildEmergencyCard({
        ...baseInput,
        manualBloodType: "O-",
        derivedBloodType: "A+",
      }).bloodType
    ).toBe("O-");
    expect(
      buildEmergencyCard({ ...baseInput, derivedBloodType: "A+" }).bloodType
    ).toBe("A+");
    expect(buildEmergencyCard(baseInput).bloodType).toBeNull();
  });

  it("collapses the contact to null unless a name or phone is present", () => {
    expect(
      buildEmergencyCard({
        ...baseInput,
        contact: { name: null, phone: null, relation: "Spouse" },
      }).contact
    ).toBeNull();
    expect(
      buildEmergencyCard({
        ...baseInput,
        contact: { name: "  ", phone: "555-0101", relation: "  " },
      }).contact
    ).toEqual({ name: "", phone: "555-0101", relation: null });
  });

  it("trims medications/conditions and drops empty rows", () => {
    const card = buildEmergencyCard({
      ...baseInput,
      medications: [
        { name: "Sertraline", detail: "50 mg · Morning" },
        { name: "  ", detail: "orphan" },
      ],
      conditions: [
        { name: "Hypertension", onsetDate: "2020-01-01" },
        { name: "", onsetDate: null },
      ],
    });
    expect(card.medications).toEqual([
      { name: "Sertraline", detail: "50 mg · Morning" },
    ]);
    expect(card.conditions).toEqual([
      { name: "Hypertension", onsetDate: "2020-01-01" },
    ]);
  });
});

describe("isEmergencyCardEmpty", () => {
  it("is empty with only identity, non-empty once any clinical fact exists", () => {
    expect(isEmergencyCardEmpty(buildEmergencyCard(baseInput))).toBe(true);
    expect(
      isEmergencyCardEmpty(
        buildEmergencyCard({ ...baseInput, manualBloodType: "O+" })
      )
    ).toBe(false);
    expect(
      isEmergencyCardEmpty(
        buildEmergencyCard({
          ...baseInput,
          allergies: [{ substance: "Peanuts", reaction: null, severity: null }],
        })
      )
    ).toBe(false);
  });
});

describe("normalizeBloodType", () => {
  it("accepts canonical types and tolerant spellings", () => {
    expect(normalizeBloodType("o+")).toBe("O+");
    expect(normalizeBloodType("AB negative")).toBe("AB-");
    expect(normalizeBloodType("a positive")).toBe("A+");
    expect(normalizeBloodType("B-")).toBe("B-");
  });
  it("rejects garbage and empty", () => {
    expect(normalizeBloodType("C+")).toBeNull();
    expect(normalizeBloodType("")).toBeNull();
    expect(normalizeBloodType(null)).toBeNull();
  });
});

describe("emergency payload (de)serialization", () => {
  const card: EmergencyCard = buildEmergencyCard({
    ...baseInput,
    manualBloodType: "O+",
    allergies: [
      { substance: "Peanuts", reaction: "Hives", severity: "moderate" },
    ],
  });

  it("round-trips a payload with its profile id", () => {
    const raw = serializeEmergencyPayload(7, card);
    const parsed = parseEmergencyPayload(raw);
    expect(parsed?.profileId).toBe(7);
    expect(parsed?.card.bloodType).toBe("O+");
    expect(parsed?.card.allergies[0].substance).toBe("Peanuts");
  });

  it("rejects malformed / wrong-version / wrong-shape blobs", () => {
    expect(parseEmergencyPayload(null)).toBeNull();
    expect(parseEmergencyPayload("not json")).toBeNull();
    expect(parseEmergencyPayload("[]")).toBeNull();
    expect(
      parseEmergencyPayload(
        JSON.stringify({ version: 999, profileId: 1, card })
      )
    ).toBeNull();
    expect(
      parseEmergencyPayload(
        JSON.stringify({ version: 1, profileId: 1, card: { name: "x" } })
      )
    ).toBeNull();
    expect(
      parseEmergencyPayload(JSON.stringify({ version: 1, card }))
    ).toBeNull();
  });
});

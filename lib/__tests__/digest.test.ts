import { describe, it, expect } from "vitest";
import {
  buildDigest,
  dedupeFlaggedByAnalyte,
  renderDigestMessage,
  type DigestInput,
} from "../notifications/digest";

const empty: DigestInput = {
  profileName: "Mom",
  doseCount: 0,
  goalsDue: [],
  activities: [],
  adherence: null,
  weightKg: null,
  newFlaggedBiomarkers: [],
  newDocumentLabels: [],
};

describe("buildDigest", () => {
  it("returns null when there is nothing to report", () => {
    expect(buildDigest(empty)).toBeNull();
  });

  it("names the profile in the title", () => {
    const model = buildDigest({ ...empty, doseCount: 2 });
    expect(model?.title).toContain("Mom");
  });

  it("collapses empty sections and keeps only populated ones", () => {
    const model = buildDigest({
      ...empty,
      doseCount: 3,
      goalsDue: [{ label: "Legs", count: 1, perWeek: 2 }],
    });
    expect(model?.sections.map((s) => s.heading)).toEqual(["Today"]);
    expect(model?.sections[0].lines).toEqual([
      "💊 3 supplement doses scheduled",
      "🎯 Legs: 1/2 this week",
    ]);
  });

  it("summarizes yesterday: activities, adherence, weight", () => {
    const model = buildDigest({
      ...empty,
      activities: [
        {
          title: "Morning run",
          type: "cardio",
          durationMin: 30,
          distanceKm: 5,
        },
        {
          title: "Upper body",
          type: "strength",
          durationMin: 45,
          distanceKm: null,
        },
      ],
      adherence: { taken: 4, skipped: 0, due: 5 },
      weightKg: 72.5,
    });
    const y = model?.sections.find((s) => s.heading === "Yesterday");
    expect(y?.lines).toEqual([
      "🏋️ Morning run — 5 km", // cardio → distance
      "🏋️ Upper body — 45 min", // strength → duration
      "💊 Supplements: 4/5 taken",
      "⚖️ Weight: 72.5 kg",
    ]);
  });

  it("lists new flagged biomarkers and documents", () => {
    const model = buildDigest({
      ...empty,
      newFlaggedBiomarkers: [
        { name: "LDL", value: "160 mg/dL", flag: "high" },
        { name: "Ferritin", value: null, flag: "low" },
      ],
      newDocumentLabels: ["Quest Labs"],
    });
    const s = model?.sections.find((x) => x.heading === "New");
    expect(s?.lines).toEqual([
      "🚩 LDL 160 mg/dL (high)",
      "🚩 Ferritin (low)",
      "📄 1 new document: Quest Labs",
    ]);
  });

  it("uses singular wording for a single dose", () => {
    const model = buildDigest({ ...empty, doseCount: 1 });
    expect(model?.sections[0].lines[0]).toBe("💊 1 supplement dose scheduled");
  });

  it("titles a medications-only profile 'medications', not 'supplements' (#380)", () => {
    const model = buildDigest({
      ...empty,
      doseCount: 2,
      intakeKinds: ["medication"],
      adherence: { taken: 1, skipped: 0, due: 2 },
    });
    expect(model?.sections[0].lines[0]).toBe("💊 2 medication doses scheduled");
    const y = model?.sections.find((s) => s.heading === "Yesterday");
    expect(y?.lines).toContain("💊 Medications: 1/2 taken");
  });

  it("uses 'supplements & meds' for a mixed profile (#380)", () => {
    const model = buildDigest({
      ...empty,
      doseCount: 3,
      intakeKinds: ["supplement", "medication"],
    });
    expect(model?.sections[0].lines[0]).toBe(
      "💊 3 supplement & med doses scheduled"
    );
  });

  it("rounds an integration-sourced weight float instead of printing it raw (#380)", () => {
    const model = buildDigest({ ...empty, weightKg: 78.4523 });
    const y = model?.sections.find((s) => s.heading === "Yesterday");
    expect(y?.lines).toEqual(["⚖️ Weight: 78.5 kg"]);
  });

  it("states skips plainly instead of '0/0 taken' when everything due was skipped (#380 nit)", () => {
    const model = buildDigest({
      ...empty,
      adherence: { taken: 0, skipped: 2, due: 2 },
    });
    const y = model?.sections.find((s) => s.heading === "Yesterday");
    expect(y?.lines).toEqual(["💊 Supplements: 2 skipped"]);
  });
});

describe("renderDigestMessage", () => {
  it("renders headings + bulleted lines with the profile title", () => {
    const model = buildDigest({
      ...empty,
      doseCount: 1,
      weightKg: 70,
    })!;
    const msg = renderDigestMessage(model);
    expect(msg.title).toBe("☀️ Morning digest — Mom");
    expect(msg.body).toContain("Today\n• 💊 1 supplement dose scheduled");
    expect(msg.body).toContain("Yesterday\n• ⚖️ Weight: 70 kg");
    expect(msg.actions).toBeUndefined();
  });
});

describe("dedupeFlaggedByAnalyte", () => {
  it("collapses repeat flags of one analyte to the newest (first) reading — issue #283", () => {
    // The read orders newest-first, so the first occurrence per analyte wins.
    const rows = [
      { name: "LDL Cholesterol", value: "160 mg/dL", flag: "high" },
      { name: "LDL Cholesterol", value: "155 mg/dL", flag: "high" },
      { name: "Ferritin", value: "20", flag: "low" },
    ];
    expect(dedupeFlaggedByAnalyte(rows)).toEqual([
      { name: "LDL Cholesterol", value: "160 mg/dL", flag: "high" },
      { name: "Ferritin", value: "20", flag: "low" },
    ]);
  });

  it("keys case-insensitively and trims — two casings of one analyte are one flag", () => {
    const rows = [
      { name: "Glucose", value: "130", flag: "high" },
      { name: " glucose ", value: "125", flag: "high" },
    ];
    expect(dedupeFlaggedByAnalyte(rows)).toHaveLength(1);
    expect(dedupeFlaggedByAnalyte([])).toEqual([]);
  });
});

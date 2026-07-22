import { describe, it, expect } from "vitest";
import {
  buildDigest,
  dedupeFlaggedByAnalyte,
  renderDigestMessage,
  type DigestInput,
} from "../notifications/digest";
import type {
  BandGroup,
  UpcomingDomain,
  UpcomingItem,
  UrgencyBand,
} from "../upcoming";
import type { Reason } from "../reasons";

let n = 0;
const item = (
  domain: UpcomingDomain,
  extra: Partial<UpcomingItem> = {}
): UpcomingItem => ({
  key: `${domain}:${n++}`,
  domain,
  title: domain,
  href: "/",
  dueDate: null,
  ...extra,
});
const band = (
  b: UrgencyBand,
  label: string,
  items: UpcomingItem[]
): BandGroup => ({ band: b, label, items });

const empty: DigestInput = {
  profileName: "Mom",
  doseCount: 0,
  todayGroups: [],
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

  it("collapses empty sections and keeps only the populated Today section", () => {
    const model = buildDigest({
      ...empty,
      doseCount: 3,
      todayGroups: [
        band("week", "This week", [item("goal", { title: "Legs" })]),
      ],
    });
    expect(model?.sections.map((s) => s.heading)).toEqual(["Today"]);
    // The dose glance headline, then the banded "what's due" summary (goals now
    // come from collectUpcoming, not a hand-computed goal line) — issue #1108.
    expect(model?.sections[0].lines).toEqual([
      "💊 3 supplement doses scheduled",
      "This week: 1 goal",
    ]);
  });

  it("mentions active situational items in Today (#662 item 1)", () => {
    const model = buildDigest({ ...empty, situationalActiveCount: 3 });
    expect(model?.sections[0].heading).toBe("Today");
    expect(model?.sections[0].lines).toContain(
      "🧭 3 situational items now active"
    );
  });

  it("omits the situational mention when none are active", () => {
    expect(buildDigest({ ...empty, situationalActiveCount: 0 })).toBeNull();
    const model = buildDigest({ ...empty, doseCount: 1 });
    expect(
      model?.sections[0].lines.some((l) => l.includes("situational"))
    ).toBe(false);
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

describe("buildDigest — merged Today section (issue #1108)", () => {
  const risk = (text: string): Reason => ({
    code: "risk-elevated",
    text,
    source: "ACC/AHA (informational)",
  });

  it("formats the banded what's-due list from collectUpcoming as the Today section", () => {
    const model = buildDigest({
      ...empty,
      todayGroups: [
        band("overdue", "Overdue", [item("biomarker")]),
        band("today", "Today", [item("appointment")]),
        band("week", "This week", [item("goal"), item("training")]),
      ],
    });
    const today = model?.sections.find((s) => s.heading === "Today");
    expect(today?.lines).toEqual([
      "Overdue: 1 lab",
      "Today: 1 appointment",
      "This week: 1 goal, 1 training target",
    ]);
  });

  it("summarizes doses ONLY in the glance headline, never double-counted in the bands", () => {
    const model = buildDigest({
      ...empty,
      doseCount: 3,
      todayGroups: [
        band("today", "Today", [
          item("dose"),
          item("dose"),
          item("dose"),
          item("appointment"),
        ]),
      ],
    });
    const today = model?.sections.find((s) => s.heading === "Today");
    // The dose headline counts the doses; the band line lists everything BUT doses.
    expect(today?.lines).toEqual([
      "💊 3 supplement doses scheduled",
      "Today: 1 appointment",
    ]);
  });

  it("a day of only doses reads as one clean glance line (no empty band line)", () => {
    const model = buildDigest({
      ...empty,
      doseCount: 2,
      todayGroups: [band("today", "Today", [item("dose"), item("dose")])],
    });
    const today = model?.sections.find((s) => s.heading === "Today");
    expect(today?.lines).toEqual(["💊 2 supplement doses scheduled"]);
  });

  it("surfaces the high-priority why lines (#656) under Today", () => {
    const model = buildDigest({
      ...empty,
      todayGroups: [
        band("overdue", "Overdue", [
          item("biomarker", {
            title: "Retest LDL Cholesterol",
            priority: 2,
            reasons: [risk("Family history of heart disease")],
          }),
        ]),
      ],
    });
    const today = model?.sections.find((s) => s.heading === "Today");
    expect(today?.lines).toEqual([
      "Overdue: 1 lab",
      "⚑ Retest LDL Cholesterol — Family history of heart disease",
    ]);
  });

  it("respects the bus: an item absent from todayGroups never reaches Today", () => {
    // The gather passes the ALREADY-suppressed collectUpcoming set, so a
    // dismissed/snoozed item simply isn't in todayGroups. With nothing else to
    // report the whole digest collapses to null (no hollow send).
    expect(buildDigest({ ...empty, todayGroups: [] })).toBeNull();
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

describe("digest renders bounded-precision numbers (issue #1109)", () => {
  // The reported bug: a full-precision canonical distance reaching the family chat
  // verbatim ("32.397218025887694 km"). The digest now formats it through the shared
  // fmtDistance boundary, canonical km per the notification unit policy.
  it("rounds a cardio distance line via fmtDistance", () => {
    const model = buildDigest({
      ...empty,
      activities: [
        {
          title: "Morning ride",
          type: "cardio",
          durationMin: 62,
          distanceKm: 32.397218025887694,
        },
      ],
    });
    const line = model?.sections.find((s) => s.heading === "Yesterday")
      ?.lines[0];
    expect(line).toBe("🏋️ Morning ride — 32.4 km");
  });

  // The class guard (issue #1109): a full-precision float on EVERY numeric digest
  // field, rendered end to end — no output line may carry 3+ decimal places. The
  // tripwire so the next raw canonical-float interpolation fails a test instead of
  // shipping 17 digits to a chat.
  it("no rendered line carries a long decimal, even on full-precision inputs", () => {
    const model = buildDigest({
      ...empty,
      activities: [
        {
          title: "Long ride",
          type: "cardio",
          durationMin: 184,
          distanceKm: 32.397218025887694,
        },
        {
          title: "Strength",
          type: "strength",
          durationMin: 47,
          distanceKm: null,
        },
      ],
      weightKg: 70.438218025887694,
      newFlaggedBiomarkers: [
        { name: "Glucose", value: "129 mg/dL", flag: "high" },
      ],
    });
    expect(model).not.toBeNull();
    const msg = renderDigestMessage(model!);
    for (const line of msg.body.split("\n")) {
      expect(line).not.toMatch(/\d+\.\d{3,}/);
    }
    expect(msg.title).not.toMatch(/\d+\.\d{3,}/);
  });
});

describe("buildDigest — Sleep section (issue #1117)", () => {
  it("renders last night vs baseline, stages, nap, and SRI", () => {
    const model = buildDigest({
      ...empty,
      sleep: {
        lastNightMin: 440, // 7h 20m
        baselineMin: 425, // ~7h 5m
        deepMin: 65,
        remMin: 95,
        napMin: 45,
        sri: 82,
      },
    });
    const sleep = model?.sections.find((s) => s.heading === "Sleep");
    expect(sleep).toBeTruthy();
    expect(sleep?.lines[0]).toBe(
      "😴 Last night: 7h 20m (typical ~7h 5m) · deep 1h 5m, REM 1h 35m"
    );
    // The nap is a SEPARATE line, never folded into the overnight figure.
    expect(sleep?.lines).toContain("💤 + 45m nap");
    expect(sleep?.lines).toContain("📈 Sleep regularity · SRI 82");
  });

  it("omits stages, nap, and SRI when absent (calm, minimal)", () => {
    const model = buildDigest({
      ...empty,
      sleep: { lastNightMin: 480, baselineMin: 470 },
    });
    const sleep = model?.sections.find((s) => s.heading === "Sleep");
    expect(sleep?.lines).toEqual(["😴 Last night: 8h (typical ~7h 50m)"]);
  });

  it("collapses entirely when there is no sleep data", () => {
    expect(buildDigest({ ...empty, sleep: null })).toBeNull();
    expect(buildDigest({ ...empty })).toBeNull();
  });

  it("sends a sleep-only digest (the section counts as content)", () => {
    const model = buildDigest({
      ...empty,
      sleep: { lastNightMin: 400, baselineMin: 400 },
    });
    expect(model?.sections.map((s) => s.heading)).toEqual(["Sleep"]);
  });

  it("does not show a zero-minute nap line", () => {
    const model = buildDigest({
      ...empty,
      sleep: { lastNightMin: 400, baselineMin: 400, napMin: 0 },
    });
    const sleep = model?.sections.find((s) => s.heading === "Sleep");
    expect(sleep?.lines.some((l) => l.includes("nap"))).toBe(false);
  });
});

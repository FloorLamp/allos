import { describe, it, expect } from "vitest";
import { bodyFor } from "@/lib/notifications/types";
import { plainBody } from "@/lib/notifications/rich-text";
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
import type { IntakeDeltas } from "../intake-deltas";

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
      // One item in the band, so it is NAMED rather than counted (#1819 item 5), and
      // the band line carries the section's bullet emoji like every other line.
      "🗓️ This week: Legs",
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

// ---- The delta and the fraction, merged when redundant (#1819 item 6) -----
//
// "🔁 Missed: Glycine (1 day)" above "💊 Supplements: 8/9 taken" stated one fact
// twice — the 1 missing IS the Glycine. #1505 part 3's "delta leads, fraction
// supports" survives intact wherever the two genuinely diverge.
describe("buildDigest — the intake delta and the adherence fraction", () => {
  const missed = (names: string[]): IntakeDeltas => ({
    missed: names.map((name, i) => ({
      kind: "missed" as const,
      itemId: i + 1,
      name,
      days: 1,
    })),
    resumed: [],
  });

  const yesterday = (input: Parameters<typeof buildDigest>[0]) =>
    buildDigest(input)?.sections.find((s) => s.heading === "Yesterday")?.lines;

  it("MERGES into one line when the delta fully explains the gap", () => {
    expect(
      yesterday({
        ...empty,
        intakeDeltas: missed(["Glycine (test)"]),
        adherence: { taken: 8, skipped: 0, due: 9 },
      })
    ).toEqual(["💊 Supplements: 8/9 taken — missed Glycine (test) (1 day)"]);
  });

  it("keeps two lines when several misses cannot ride one fraction", () => {
    expect(
      yesterday({
        ...empty,
        intakeDeltas: missed(["Glycine (test)", "Magnesium (test)"]),
        adherence: { taken: 7, skipped: 0, due: 9 },
      })
    ).toEqual([
      "🔁 Missed: Glycine (test) (1 day), Magnesium (test) (1 day)",
      "💊 Supplements: 7/9 taken",
    ]);
  });

  it("keeps two lines when a RESUME is the news — a resume is not a gap", () => {
    expect(
      yesterday({
        ...empty,
        intakeDeltas: {
          missed: [],
          resumed: [
            { kind: "resumed", itemId: 1, name: "Vitamin D (test)", days: 2 },
          ],
        },
        adherence: { taken: 8, skipped: 0, due: 9 },
      })
    ).toEqual([
      "🔁 Resumed: Vitamin D (test) (2 days)",
      "💊 Supplements: 8/9 taken",
    ]);
  });

  it("keeps two lines when a SKIP, not the miss, moved the fraction", () => {
    // 1 skipped leaves 8 intended and 8 taken — no gap for the delta to explain.
    expect(
      yesterday({
        ...empty,
        intakeDeltas: missed(["Glycine (test)"]),
        adherence: { taken: 8, skipped: 1, due: 9 },
      })
    ).toEqual([
      "🔁 Missed: Glycine (test) (1 day)",
      "💊 Supplements: 8/8 taken · 1 skipped",
    ]);
  });

  it("still leads with the delta when there is no fraction beside it", () => {
    expect(
      yesterday({ ...empty, intakeDeltas: missed(["Glycine (test)"]) })
    ).toEqual(["🔁 Missed: Glycine (test) (1 day)"]);
  });

  it("a quiet delta window leaves the fraction alone", () => {
    expect(
      yesterday({
        ...empty,
        intakeDeltas: { missed: [], resumed: [] },
        adherence: { taken: 8, skipped: 0, due: 9 },
      })
    ).toEqual(["💊 Supplements: 8/9 taken"]);
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
        band("overdue", "Overdue", [
          item("screening", { title: "Colonoscopy" }),
          item("biomarker", { title: "CBC" }),
          item("biomarker", { title: "Lipid panel" }),
        ]),
        band("today", "Today", [item("appointment", { title: "Dentist" })]),
        band("week", "This week", [
          item("goal", { title: "Legs" }),
          item("training", { title: "Back" }),
          item("training", { title: "Chest" }),
          item("training", { title: "Cardio" }),
        ]),
      ],
    });
    const today = model?.sections.find((s) => s.heading === "Today");
    expect(today?.lines).toEqual([
      // <= 3 items: named, peers joined by ", " and domains by " · " (#1819 item 5).
      "🗓️ Overdue: Colonoscopy · CBC, Lipid panel",
      "🗓️ Today: Dentist",
      // Above the naming threshold the count is genuinely the right shape.
      "🗓️ This week: 1 goal, 3 training targets",
    ]);
  });

  // #1819 item 4: a bare count of unmet targets is neither progress nor what is
  // lagging. The weekly-progress phrase replaces it — over the SAME paced set.
  it("states weekly training PROGRESS instead of counting unmet targets", () => {
    const model = buildDigest({
      ...empty,
      trainingPaceLine: "2 of 4 training targets on pace — behind on Back, Chest",
      todayGroups: [
        band("week", "This week", [
          item("training", { key: "training:1", title: "Back" }),
          item("training", { key: "training:2", title: "Chest" }),
          item("training", { key: "training:3", title: "Cardio" }),
          item("training", { key: "training:4", title: "Lower body" }),
        ]),
      ],
    });
    const today = model?.sections.find((s) => s.heading === "Today");
    expect(today?.lines).toEqual([
      "🗓️ This week: 2 of 4 training targets on pace — behind on Back, Chest",
    ]);
  });

  it("never lets the pace phrase stand in for a training item it is not about", () => {
    // An endurance event and an outdoor plan share the `training` DOMAIN but not the
    // weekly-target key namespace, so the phrase must decline rather than absorb them.
    const model = buildDigest({
      ...empty,
      trainingPaceLine: "2 of 4 training targets on pace",
      todayGroups: [
        band("week", "This week", [
          item("training", { key: "training:1", title: "Back" }),
          item("training", {
            key: "endurance-event:9",
            title: "Event: 10 km Run",
          }),
          item("goal", { title: "Legs" }),
          item("appointment", { title: "Dentist" }),
        ]),
      ],
    });
    const today = model?.sections.find((s) => s.heading === "Today");
    expect(today?.lines).toEqual([
      "🗓️ This week: 1 appointment, 1 goal, 2 training targets",
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
      "🗓️ Today: appointment",
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
      "🗓️ Overdue: Retest LDL Cholesterol",
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
    for (const line of plainBody(msg.body).split("\n")) {
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
    // 15m above a 7h5m baseline is inside the typical band — the line says so rather
    // than manufacturing a "+15m" delta (#1712).
    // #1819 item 7: the verdict is a clause about the figure, so it takes the em-dash.
    expect(sleep?.lines[0]).toBe(
      "😴 Last night: 7h 20m — about typical · deep 1h 5m, REM 1h 35m"
    );
    // The nap is a SEPARATE line, never folded into the overnight figure.
    expect(sleep?.lines).toContain("💤 + 45m nap");
    // The acronym and the naked number are gone: the banded qualifier says what the
    // index means, about the SCHEDULE and never about the sleeper (#992/#1819 item 7).
    expect(sleep?.lines).toContain("📈 Sleep regularity 82 — very consistent");
  });

  it("omits stages, nap, and SRI when absent (calm, minimal)", () => {
    const model = buildDigest({
      ...empty,
      sleep: { lastNightMin: 480, baselineMin: 470 },
    });
    const sleep = model?.sections.find((s) => s.heading === "Sleep");
    expect(sleep?.lines).toEqual(["😴 Last night: 8h — about typical"]);
  });

  // #1712 §3: the line printed two numbers and left the conclusion to the reader.
  it("states the verdict when the night is notably above baseline", () => {
    const model = buildDigest({
      ...empty,
      sleep: { lastNightMin: 445, baselineMin: 404 }, // 7h25 vs ~6h44
    });
    const sleep = model?.sections.find((s) => s.heading === "Sleep");
    expect(sleep?.lines[0]).toBe("😴 Last night: 7h 25m — ▲ 41m above typical");
  });

  it("reads a short night neutrally — the digest never nags about sleep", () => {
    const model = buildDigest({
      ...empty,
      sleep: { lastNightMin: 330, baselineMin: 425 }, // 5h30 vs ~7h5
    });
    const line = model?.sections.find((s) => s.heading === "Sleep")?.lines[0]!;
    expect(line).toBe("😴 Last night: 5h 30m — ▼ 1h 35m below typical");
    // #1292's poor-sleep acknowledgment owns the "rough night" framing; the digest
    // must not double up with alarm of its own.
    expect(line.toLowerCase()).not.toMatch(/rough|poor|bad|short night|only/);
  });

  it("states the figure alone when there is no baseline to compare against", () => {
    const model = buildDigest({
      ...empty,
      sleep: { lastNightMin: 445, baselineMin: 0 },
    });
    expect(model?.sections.find((s) => s.heading === "Sleep")?.lines[0]).toBe(
      "😴 Last night: 7h 25m"
    );
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

// ---- The offer tail is a CONTROL on Telegram and TEXT everywhere else (#1712) ----
describe("digest offer tail per channel (#1712)", () => {
  const withOffers = (count: number) =>
    renderDigestMessage(
      buildDigest({
        ...empty,
        doseCount: 9,
        offerCount: count,
        offerTail: {
          label: "➕ Log other (3 for morning)",
          data: "offerexp:1:2026-03-04",
          row: "offer-tail",
        },
      })!
    );

  it("Telegram gets the button and NO body line — the button is the label", () => {
    const msg = withOffers(3);
    const telegram = plainBody(bodyFor(msg, "telegram"));
    expect(telegram).not.toContain("you can log any time");
    // The control is present and self-describing (it names the slot and the count).
    expect(msg.actions?.[0].label).toContain("Log other");
    expect(msg.actions?.[0].label).toContain("3 for morning");
  });

  it("Web Push and Home Assistant get the line, since they cannot render the control", () => {
    const msg = withOffers(3);
    expect(plainBody(bodyFor(msg, "push"))).toContain(
      "3 more supplements you can log any time"
    );
    expect(plainBody(bodyFor(msg, "home-assistant"))).toContain(
      "3 more supplements you can log any time"
    );
    // Same message otherwise — the honest-count principle survives, only the
    // Telegram duplicate goes.
    expect(plainBody(bodyFor(msg, "push"))).toContain(
      plainBody(bodyFor(msg, "telegram"))
    );
  });

  it("no offers ⇒ no line on any channel", () => {
    const msg = renderDigestMessage(
      buildDigest({ ...empty, doseCount: 9, offerCount: 0 })!
    );
    expect(msg.bodyByChannel).toBeUndefined();
    expect(plainBody(bodyFor(msg, "push"))).not.toContain(
      "you can log any time"
    );
  });
});

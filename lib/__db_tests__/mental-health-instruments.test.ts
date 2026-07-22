// DB INTEGRATION TIER (issue #716 — the #448 builder-fixture rule + the write-core /
// screening-satisfaction / milestone-exemption acceptance).
//
// recordInstrumentScore writes a biomarker-shaped medical_records row (the observation
// substrate) plus per-item instrument_responses, and the mental-health CRISIS builder
// GATHERS that state and hands it to the pure crisis decision — so this file seeds a
// realistic fixture and asserts the END-TO-END finding output the pure tier can't see:
//   • the score lands as a canonical PHQ-9/GAD-7 biomarker reading with NO MedicalFlag
//     (the severity band, not a flag, is the on-screen signal — and no flag means it
//     never reaches the flagged-biomarker digest push);
//   • a SEVERE score / positive PHQ-9 item 9 surfaces a care-tier, NON-DISMISSIBLE
//     crisis UpcomingItem that RESISTS a blanket dismiss and is NEVER counted in the
//     Telegram digest (no crisis content on any channel);
//   • a recorded score SATISFIES its preventive screening;
//   • recording a score creates NO activities row, so the milestone/streak machinery
//     never sees it (the "never gamify a depression score" law, enforced structurally).
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  recordInstrumentScore,
  getInstrumentReadings,
} from "@/lib/instrument-records";
import {
  collectUpcoming,
  dismissFinding,
  getCurrentFlaggedBiomarkers,
  getInferredPreventiveSatisfactions,
} from "@/lib/queries";
import { buildDigest, renderDigestMessage } from "@/lib/notifications/digest";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { gatherMilestoneInput } from "@/lib/milestones-db";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { MENTAL_HEALTH_PREFIX } from "@/lib/mental-health";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function setBirthdate(profileId: number, iso: string): void {
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`
  ).run(profileId, iso);
}

describe("recordInstrumentScore — the score is a biomarker reading, no flag", () => {
  it("stores the total as a canonical PHQ-9 medical_records row with value_num and no flag", () => {
    const p = newProfile("MH score");
    const td = today(p);
    recordInstrumentScore(p, {
      instrument: "PHQ-9",
      date: td,
      total: 8,
      answers: [0, 1, 1, 1, 1, 1, 1, 1, 1].map((answer, itemIndex) => ({
        itemIndex,
        answer,
      })),
    });

    const row = db
      .prepare(
        `SELECT category, canonical_name, value_num, flag FROM medical_records
         WHERE profile_id = ? AND canonical_name = 'PHQ-9'`
      )
      .get(p) as {
      category: string;
      canonical_name: string;
      value_num: number;
      flag: string | null;
    };
    // #1076: the score files as `instrument`, not the general lab bucket.
    expect(row.category).toBe("instrument");
    expect(row.value_num).toBe(8);
    // No MedicalFlag — the severity band is the on-screen signal, so the score never
    // enters the flagged-biomarker digest push (the #716 no-notification law).
    expect(row.flag == null).toBe(true);
    expect(getCurrentFlaggedBiomarkers(p, "1970-01-01")).toHaveLength(0);

    const readings = getInstrumentReadings(p);
    expect(readings).toHaveLength(1);
    expect(readings[0].band.label).toBe("Mild");
    expect(readings[0].total).toBe(8);
  });

  it("stores per-item answers linked to the score, and clears them on score delete (cascade)", () => {
    const p = newProfile("MH items");
    const td = today(p);
    const recordId = recordInstrumentScore(p, {
      instrument: "PHQ-9",
      date: td,
      total: 3,
      answers: Array.from({ length: 9 }, (_, itemIndex) => ({
        itemIndex,
        answer: itemIndex === 8 ? 3 : 0,
      })),
    });
    const before = db
      .prepare(
        "SELECT COUNT(*) AS n FROM instrument_responses WHERE profile_id = ?"
      )
      .get(p) as { n: number };
    expect(before.n).toBe(9);

    db.prepare(
      "DELETE FROM medical_records WHERE id = ? AND profile_id = ?"
    ).run(recordId, p);
    const after = db
      .prepare(
        "SELECT COUNT(*) AS n FROM instrument_responses WHERE profile_id = ?"
      )
      .get(p) as { n: number };
    expect(after.n).toBe(0);
  });
});

describe("mental-health crisis builder — care tier, non-dismissible, never pushed", () => {
  it("a severe PHQ-9 surfaces a care-tier crisis item that resists a blanket dismiss", () => {
    const p = newProfile("MH severe");
    const td = today(p);
    recordInstrumentScore(p, { instrument: "PHQ-9", date: td, total: 24 });

    const items = collectUpcoming(p, td);
    const crisis = items.find((i) => i.domain === "mental-health");
    expect(crisis).toBeTruthy();
    expect(crisis!.band).toBe("today");
    expect(dedupeKeyHasKnownPrefix(crisis!.key)).toBe(true);
    expect(crisis!.key.startsWith(MENTAL_HEALTH_PREFIX)).toBe(true);
    expect(tierForDedupeKey(crisis!.key)).toBe("care");
    // The crisis-resources line rides the finding detail. With no resources
    // configured (this fixture sets none) it is the neutral fallback + supportive
    // lead (#996) — never a hardcoded/fabricated number.
    expect(crisis!.detail).toContain("you’re not alone");
    expect(crisis!.detail).toContain("local emergency services");
    expect(crisis!.detail).not.toContain("988");

    // Non-dismissible: a blanket dismiss on its key does NOT hide it (safety-ungated).
    dismissFinding(p, crisis!.key);
    const after = collectUpcoming(p, td);
    expect(after.some((i) => i.domain === "mental-health")).toBe(true);
  });

  it("a positive PHQ-9 item 9 escalates even when the total is not severe", () => {
    const p = newProfile("MH item9");
    const td = today(p);
    recordInstrumentScore(p, {
      instrument: "PHQ-9",
      date: td,
      total: 6, // mild total, but item 9 positive
      answers: Array.from({ length: 9 }, (_, itemIndex) => ({
        itemIndex,
        answer: itemIndex === 8 ? 2 : 0,
      })),
    });
    const items = collectUpcoming(p, td);
    expect(items.some((i) => i.domain === "mental-health")).toBe(true);
  });

  it("a minimal score with a clean item 9 does NOT escalate", () => {
    const p = newProfile("MH calm");
    const td = today(p);
    recordInstrumentScore(p, {
      instrument: "PHQ-9",
      date: td,
      total: 2,
      answers: Array.from({ length: 9 }, (_, itemIndex) => ({
        itemIndex,
        answer: itemIndex === 0 ? 2 : 0,
      })),
    });
    expect(
      collectUpcoming(p, td).some((i) => i.domain === "mental-health")
    ).toBe(false);
  });

  it("the crisis line never reaches the Telegram digest (no crisis content on any channel)", () => {
    const p = newProfile("MH nopush");
    recordInstrumentScore(p, {
      instrument: "PHQ-9",
      date: today(p),
      total: 25,
    });
    // The merged morning digest (#1108) embeds the what's-due list as its Today
    // section, so the no-leak guard runs against the ACTUAL sent message. A crisis
    // mental-health finding is care-tier on the page/hero but is excluded from the
    // digest's domain sequence, so it's never counted, and its title/reason never
    // reach the push (the decided harm case: crisis content on a shared device).
    const model = buildDigest(gatherDigestInput(p, "MH nopush"));
    if (model) {
      const msg = renderDigestMessage(model);
      const text = `${msg.title} ${msg.body} ${JSON.stringify(msg)}`;
      expect(text).not.toContain("988");
      expect(text).not.toContain("mental-health");
    }
  });
});

describe("screening satisfaction (#716)", () => {
  it("a recorded PHQ-9 satisfies depression_screening; a GAD-7 satisfies anxiety_screening", () => {
    const p = newProfile("MH screen");
    setBirthdate(p, "1990-01-01");
    const td = today(p);
    recordInstrumentScore(p, { instrument: "PHQ-9", date: td, total: 4 });
    recordInstrumentScore(p, { instrument: "GAD-7", date: td, total: 3 });

    const sats = getInferredPreventiveSatisfactions(p);
    expect(sats.some((s) => s.ruleKey === "depression_screening")).toBe(true);
    expect(sats.some((s) => s.ruleKey === "anxiety_screening")).toBe(true);
  });
});

describe("milestone exemption (#716) — never gamify a mental-health score", () => {
  it("recording an instrument score creates no activities row and no streak", () => {
    const p = newProfile("MH exempt");
    const td = today(p);
    recordInstrumentScore(p, { instrument: "PHQ-9", date: td, total: 12 });
    recordInstrumentScore(p, { instrument: "GAD-7", date: td, total: 10 });

    const activities = db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
      .get(p) as { n: number };
    expect(activities.n).toBe(0);

    const input = gatherMilestoneInput(p);
    expect(input.totalWorkouts).toBe(0);
    expect(input.streak).toBe(0);
  });
});

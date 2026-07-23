// DB INTEGRATION TIER (issue #998 — the #448 builder-fixture rule + the write-core /
// screening-satisfaction / no-gamification acceptance, mirroring the #716 mental-
// health suite for behavioral health's other half).
//
// recordInstrumentScore writes a biomarker-shaped medical_records row (the
// observation substrate) for AUDIT-C/AUDIT/DAST-10, and consumption rides the
// EXISTING food_log store (a standard drink = one serving of the `alcohol` group),
// so this file seeds realistic fixtures and asserts what the pure tier can't see:
//   • an AUDIT-C score lands as a canonical biomarker reading with per-item 0..4
//     answers and NO MedicalFlag (the severity band is the on-screen signal — no
//     flag means it never reaches the flagged-biomarker digest push);
//   • a recorded AUDIT-C / DAST-10 SATISFIES its preventive screening;
//   • the over-target coaching builder fires ONE calm finding with a registered,
//     guardable coaching-tier dedupeKey — and stays SILENT under/at the cap and
//     with no target set (silence is the success state — no celebration);
//   • the substance target NEVER enters the floor-semantics frequency rollup
//     (getFrequencyTargetProgress) — a floor reader would nudge toward MORE — and
//     never surfaces on Upcoming or in the digest;
//   • NO GAMIFICATION, structurally: neither scores nor drink logs create an
//     activities row, so the milestone/streak machinery never sees this domain,
//     and the finding copy carries no streak/badge/milestone language.
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  recordInstrumentScore,
  getSubstanceInstrumentReadings,
} from "@/lib/instrument-records";
import { logFoodServingCore } from "@/lib/food-log-write";
import {
  logSubstanceUnitCore,
  undoSubstanceUnitCore,
} from "@/lib/substance-log-write";
import {
  collectUpcoming,
  getInferredPreventiveSatisfactions,
  getFrequencyTargetProgress,
  getSubstanceTarget,
  getSubstanceWeekState,
  getAllSubstanceWeekStates,
  getAlcoholWeeklyTrend,
  getSubstanceWeeklyTrend,
} from "@/lib/queries";
import { buildDigest, renderDigestMessage } from "@/lib/notifications/digest";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { gatherMilestoneInput } from "@/lib/milestones-db";
import {
  buildSubstanceUseFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import {
  SUBSTANCE_USE_PREFIX,
  substanceTargetSignalKey,
  capProgressLine,
  substanceCapStatus,
} from "@/lib/substance-use";

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

function addCap(
  profileId: number,
  cap: number,
  substance: string = "alcohol"
): void {
  db.prepare(
    `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
     VALUES (?, 'substance', ?, ?)`
  ).run(profileId, substance, cap);
}

function logDrinks(profileId: number, date: string, n: number): void {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, 'alcohol', ?)
     ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = servings + excluded.servings`
  ).run(profileId, date, n);
}

describe("recordInstrumentScore (substance) — a biomarker reading, no flag, no crisis", () => {
  it("stores an AUDIT-C total with 0..4 per-item answers, banded, unflagged", () => {
    const p = newProfile("SU audit-c");
    const td = today(p);
    recordInstrumentScore(p, {
      instrument: "AUDIT-C",
      date: td,
      total: 9,
      answers: [4, 2, 3].map((answer, itemIndex) => ({ itemIndex, answer })),
    });

    const row = db
      .prepare(
        `SELECT category, value_num, flag FROM medical_records
         WHERE profile_id = ? AND canonical_name = 'AUDIT-C'`
      )
      .get(p) as { category: string; value_num: number; flag: string | null };
    // #1076: the score files as `instrument`, not the general lab bucket.
    expect(row.category).toBe("instrument");
    expect(row.value_num).toBe(9);
    // No MedicalFlag — the severity band is the on-screen signal, so the score
    // never enters the flagged-biomarker digest push (the #716/#998 law).
    expect(row.flag == null).toBe(true);

    const answers = db
      .prepare(
        `SELECT item_index, answer FROM instrument_responses
         WHERE profile_id = ? ORDER BY item_index`
      )
      .all(p) as { item_index: number; answer: number }[];
    expect(answers).toHaveLength(3);
    expect(answers[0].answer).toBe(4); // 0..4 scale accepted (wider than PHQ's 0..3)

    const readings = getSubstanceInstrumentReadings(p);
    expect(readings).toHaveLength(1);
    expect(readings[0].instrument).toBe("AUDIT-C");
    expect(readings[0].band.label).toBe("Higher risk");
  });

  it("a severe substance score NEVER surfaces a crisis item on Upcoming (#996 is explicit-only)", () => {
    const p = newProfile("SU no-crisis");
    const td = today(p);
    recordInstrumentScore(p, { instrument: "AUDIT", date: td, total: 32 });
    recordInstrumentScore(p, { instrument: "DAST-10", date: td, total: 10 });
    const items = collectUpcoming(p, td);
    expect(items.some((i) => i.domain === "mental-health")).toBe(false);
    expect(items.some((i) => i.key.startsWith(SUBSTANCE_USE_PREFIX))).toBe(
      false
    );
  });
});

describe("screening satisfaction (#998)", () => {
  it("a recorded AUDIT-C satisfies alcohol_screening; a DAST-10 satisfies drug_use_screening", () => {
    const p = newProfile("SU screen");
    setBirthdate(p, "1990-01-01");
    const td = today(p);
    recordInstrumentScore(p, { instrument: "AUDIT-C", date: td, total: 2 });
    recordInstrumentScore(p, { instrument: "DAST-10", date: td, total: 0 });

    const sats = getInferredPreventiveSatisfactions(p);
    expect(sats.some((s) => s.ruleKey === "alcohol_screening")).toBe(true);
    expect(sats.some((s) => s.ruleKey === "drug_use_screening")).toBe(true);
  });

  it("an AUDIT total also satisfies alcohol_screening but never the drug screening", () => {
    const p = newProfile("SU screen audit");
    setBirthdate(p, "1985-06-15");
    recordInstrumentScore(p, {
      instrument: "AUDIT",
      date: today(p),
      total: 5,
    });
    const sats = getInferredPreventiveSatisfactions(p);
    expect(sats.some((s) => s.ruleKey === "alcohol_screening")).toBe(true);
    expect(sats.some((s) => s.ruleKey === "drug_use_screening")).toBe(false);
  });
});

describe("buildSubstanceUseFindings (#998) — over-target only, coaching tier, calm", () => {
  it("fires ONE registered coaching finding when the week is over the cap", () => {
    const p = newProfile("SU over");
    const td = today(p);
    addCap(p, 7);
    logDrinks(p, td, 9);

    const findings = buildSubstanceUseFindings(p);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(substanceTargetSignalKey("alcohol"));
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    // The detail is the SAME shared progress line the page renders (#221).
    expect(f.detail).toBe(capProgressLine(substanceCapStatus(9, 7)));
    expect(f.detail).toContain("2 over your 7-drink weekly cap");
    // The rollup carries the same finding (union parity with the aggregator).
    expect(
      collectCoachingFindings(p, td, "kg").some(
        (c) => c.dedupeKey === f.dedupeKey
      )
    ).toBe(true);
  });

  it("stays silent under the cap, at the cap, and with no target set", () => {
    const under = newProfile("SU under");
    addCap(under, 7);
    logDrinks(under, today(under), 3);
    expect(buildSubstanceUseFindings(under)).toEqual([]);

    const at = newProfile("SU at-cap");
    addCap(at, 7);
    logDrinks(at, today(at), 7);
    expect(buildSubstanceUseFindings(at)).toEqual([]);

    const none = newProfile("SU no-target");
    logDrinks(none, today(none), 20);
    expect(buildSubstanceUseFindings(none)).toEqual([]);
  });

  it("a cap-0 (alcohol-free week) target fires only once something is logged", () => {
    const p = newProfile("SU dry");
    addCap(p, 0);
    expect(buildSubstanceUseFindings(p)).toEqual([]);
    logDrinks(p, today(p), 1);
    const findings = buildSubstanceUseFindings(p);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("alcohol-free week");
  });
});

describe("cap semantics never leak into floor-semantics surfaces (#998)", () => {
  it("the substance target is excluded from getFrequencyTargetProgress, Upcoming, and the digest", () => {
    const p = newProfile("SU no-leak");
    const td = today(p);
    addCap(p, 7);
    logDrinks(p, td, 2); // 2 of 7 — a floor reader would say "5 to go"

    // The floor rollup never sees it…
    const progress = getFrequencyTargetProgress(p);
    expect(progress.some((t) => t.target.scope_kind === "substance")).toBe(
      false
    );

    // …Upcoming carries no substance item (coaching tier reaches no push surface)…
    const items = collectUpcoming(p, td);
    expect(items.some((i) => i.key.startsWith(SUBSTANCE_USE_PREFIX))).toBe(
      false
    );

    // …and the merged morning digest (#1108) never mentions the domain — its Today
    // section formats collectUpcoming, whose substance-use signals are coaching-tier
    // and reach no push surface, so the sent message stays clean.
    const model = buildDigest(gatherDigestInput(p, "SU no-leak"));
    if (model) {
      const msg = renderDigestMessage(model);
      const text = `${msg.title} ${msg.body} ${JSON.stringify(msg)}`;
      expect(text.toLowerCase()).not.toContain("alcohol");
      expect(text.toLowerCase()).not.toContain("substance");
    }
  });

  it("the dedicated substance read carries the cap state the page renders", () => {
    const p = newProfile("SU state");
    addCap(p, 7);
    logDrinks(p, today(p), 5);
    const state = getSubstanceWeekState(p, "alcohol");
    expect(state.count).toBe(5);
    expect(state.target?.cap).toBe(7);
    expect(capProgressLine(state.status!)).toBe(
      "5 of your 7-drink weekly cap used."
    );
    expect(getSubstanceTarget(p, "alcohol")?.cap).toBe(7);
    // The trend's current week equals the week state (same window, same SUM).
    const trend = getAlcoholWeeklyTrend(p);
    expect(trend[trend.length - 1].isCurrent).toBe(true);
    expect(trend[trend.length - 1].count).toBe(5);
  });
});

describe("no gamification (#998) — structural exemption + copy guard", () => {
  it("scores and drink logs create no activities row and no streak/milestone input", () => {
    const p = newProfile("SU exempt");
    const td = today(p);
    recordInstrumentScore(p, { instrument: "AUDIT-C", date: td, total: 4 });
    logFoodServingCore(p, "alcohol", td);
    logFoodServingCore(p, "alcohol", td);

    const activities = db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
      .get(p) as { n: number };
    expect(activities.n).toBe(0);

    const input = gatherMilestoneInput(p);
    expect(input.totalWorkouts).toBe(0);
    expect(input.streak).toBe(0);
  });

  it("the over-target finding carries no streak/badge/milestone/celebration language", () => {
    const p = newProfile("SU copy");
    addCap(p, 2);
    logDrinks(p, today(p), 6);
    const [f] = buildSubstanceUseFindings(p);
    const text =
      `${f.title} ${f.detail ?? ""} ${f.evidence ?? ""}`.toLowerCase();
    for (const banned of [
      "streak",
      "badge",
      "milestone",
      "congrat",
      "celebrat",
      "great job",
      "well done",
      "keep it up",
      "sober",
    ]) {
      expect(text, `banned word "${banned}" in finding copy`).not.toContain(
        banned
      );
    }
  });
});

// ---- #1078: the non-food substance ledger (nicotine/cannabis) ---------------

describe("substance_log ledger (#1078) — split-ledger week rollup + trend", () => {
  it("one-tap log/undo increments and decrements the (profile, date, substance) row", () => {
    const p = newProfile("SU nic ledger");
    const td = today(p);

    const one = logSubstanceUnitCore(p, "nicotine", td);
    expect(one).toEqual({ kind: "logged", units: 1, substance: "nicotine" });
    const two = logSubstanceUnitCore(p, "nicotine", td);
    expect(two.kind === "logged" && two.units === 2).toBe(true);

    // One counter row per (profile, date, substance) — the food_log shape.
    const rows = db
      .prepare(
        `SELECT substance, units FROM substance_log WHERE profile_id = ? AND date = ?`
      )
      .all(p, td) as { substance: string; units: number }[];
    expect(rows).toEqual([{ substance: "nicotine", units: 2 }]);

    const undone = undoSubstanceUnitCore(p, "nicotine", td);
    expect(undone).toEqual({ kind: "undone", units: 1, substance: "nicotine" });
    // Undo to zero drops the row entirely; a further undo is a no-op at 0.
    undoSubstanceUnitCore(p, "nicotine", td);
    expect(undoSubstanceUnitCore(p, "nicotine", td)).toEqual({
      kind: "undone",
      units: 0,
      substance: "nicotine",
    });
    const left = db
      .prepare(`SELECT COUNT(*) AS n FROM substance_log WHERE profile_id = ?`)
      .get(p) as { n: number };
    expect(left.n).toBe(0);
  });

  it("refuses non-ledger substances: alcohol (food-log) and forged keys write nothing", () => {
    const p = newProfile("SU ledger guard");
    expect(logSubstanceUnitCore(p, "alcohol", today(p))).toEqual({
      kind: "unknown-substance",
    });
    expect(logSubstanceUnitCore(p, "caffeine", today(p))).toEqual({
      kind: "unknown-substance",
    });
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM substance_log WHERE profile_id = ?`)
      .get(p) as { n: number };
    expect(n.n).toBe(0);
  });

  it("week state + trend read the substance's OWN ledger — no cross-substance or cross-ledger leaks", () => {
    const p = newProfile("SU split ledgers");
    const td = today(p);
    logDrinks(p, td, 4); // food_log (alcohol)
    logSubstanceUnitCore(p, "nicotine", td);
    logSubstanceUnitCore(p, "nicotine", td);
    logSubstanceUnitCore(p, "cannabis", td);

    const states = getAllSubstanceWeekStates(p);
    expect(states.map((s) => [s.substance, s.count])).toEqual([
      ["alcohol", 4],
      ["nicotine", 2],
      ["cannabis", 1],
    ]);

    // The trend's current week equals the week state per substance (same window,
    // same SUM — #221/#223), and the alcohol alias still reads the food ledger.
    for (const s of ["nicotine", "cannabis"] as const) {
      const trend = getSubstanceWeeklyTrend(p, s);
      expect(trend[trend.length - 1].isCurrent).toBe(true);
      expect(trend[trend.length - 1].count).toBe(s === "nicotine" ? 2 : 1);
    }
    const alcohol = getAlcoholWeeklyTrend(p);
    expect(alcohol[alcohol.length - 1].count).toBe(4);
  });
});

describe("buildSubstanceUseFindings (#1078) — per-substance over-target, coaching tier, calm", () => {
  it("a nicotine week over its cap fires ONE registered coaching finding with use-wording", () => {
    const p = newProfile("SU nic over");
    const td = today(p);
    addCap(p, 7, "nicotine");
    for (let i = 0; i < 9; i++) logSubstanceUnitCore(p, "nicotine", td);

    const findings = buildSubstanceUseFindings(p);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(substanceTargetSignalKey("nicotine"));
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(f.title).toBe("Nicotine is over your weekly target");
    // The detail is the SAME shared per-substance progress line the page renders.
    expect(f.detail).toBe(
      capProgressLine(substanceCapStatus(9, 7), "nicotine")
    );
    expect(f.detail).toContain("2 over your 7-use weekly cap");
    expect(
      collectCoachingFindings(p, td, "kg").some(
        (c) => c.dedupeKey === f.dedupeKey
      )
    ).toBe(true);
  });

  it("a cannabis cap-0 target fires only once something is logged, with its own key", () => {
    const p = newProfile("SU cann dry");
    addCap(p, 0, "cannabis");
    expect(buildSubstanceUseFindings(p)).toEqual([]);
    logSubstanceUnitCore(p, "cannabis", today(p));
    const findings = buildSubstanceUseFindings(p);
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toBe(substanceTargetSignalKey("cannabis"));
    expect(findings[0].detail).toContain("cannabis-free week");
  });

  it("each substance keeps its OWN finding + key; under-cap substances stay silent", () => {
    const p = newProfile("SU multi");
    const td = today(p);
    addCap(p, 2, "alcohol");
    addCap(p, 2, "nicotine");
    addCap(p, 20, "cannabis");
    logDrinks(p, td, 5);
    for (let i = 0; i < 3; i++) logSubstanceUnitCore(p, "nicotine", td);
    logSubstanceUnitCore(p, "cannabis", td); // 1 of 20 — silent

    const keys = buildSubstanceUseFindings(p).map((f) => f.dedupeKey);
    expect(keys).toEqual([
      substanceTargetSignalKey("alcohol"),
      substanceTargetSignalKey("nicotine"),
    ]);
  });

  it("nicotine/cannabis stay off every push surface and out of the digest (#449 coaching tier)", () => {
    const p = newProfile("SU nic no-push");
    const td = today(p);
    addCap(p, 1, "nicotine");
    addCap(p, 1, "cannabis");
    for (let i = 0; i < 5; i++) {
      logSubstanceUnitCore(p, "nicotine", td);
      logSubstanceUnitCore(p, "cannabis", td);
    }
    const items = collectUpcoming(p, td);
    expect(items.some((i) => i.key.startsWith(SUBSTANCE_USE_PREFIX))).toBe(
      false
    );
    const model = buildDigest(gatherDigestInput(p, "SU nic no-push"));
    if (model) {
      const text = JSON.stringify(renderDigestMessage(model)).toLowerCase();
      expect(text).not.toContain("nicotine");
      expect(text).not.toContain("cannabis");
      expect(text).not.toContain("substance");
    }
  });
});

describe("no gamification for the new substances (#1078) — structural exemption + copy guard", () => {
  it("substance_log writes create no activities row and no streak/milestone input", () => {
    const p = newProfile("SU nic exempt");
    const td = today(p);
    for (let i = 0; i < 4; i++) logSubstanceUnitCore(p, "nicotine", td);
    logSubstanceUnitCore(p, "cannabis", td);

    const activities = db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
      .get(p) as { n: number };
    expect(activities.n).toBe(0);

    const input = gatherMilestoneInput(p);
    expect(input.totalWorkouts).toBe(0);
    expect(input.streak).toBe(0);
  });

  it("the per-substance finding copy carries no streak/badge/milestone/celebration language", () => {
    const p = newProfile("SU nic copy");
    const td = today(p);
    addCap(p, 1, "nicotine");
    addCap(p, 1, "cannabis");
    for (let i = 0; i < 3; i++) {
      logSubstanceUnitCore(p, "nicotine", td);
      logSubstanceUnitCore(p, "cannabis", td);
    }
    for (const f of buildSubstanceUseFindings(p)) {
      const text =
        `${f.title} ${f.detail ?? ""} ${f.evidence ?? ""}`.toLowerCase();
      for (const banned of [
        "streak",
        "badge",
        "milestone",
        "congrat",
        "celebrat",
        "great job",
        "well done",
        "keep it up",
        "sober",
        "quit-day",
      ]) {
        expect(text, `banned word "${banned}" in finding copy`).not.toContain(
          banned
        );
      }
    }
  });
});

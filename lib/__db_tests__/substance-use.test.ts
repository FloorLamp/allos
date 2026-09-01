// DB INTEGRATION TIER (issue #998 — the #448 builder-fixture rule + the write-core /
// screening-satisfaction / no-gamification acceptance, mirroring the #716 mental-
// health suite for behavioral health's other half).
//
// recordInstrumentScore writes a biomarker-shaped medical_records row (the
// observation substrate) for AUDIT-C/AUDIT/DAST-10, and consumption rides the
// EXISTING food_daily_totals store (a standard drink = one serving of the `alcohol` group),
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
//     activities row, so the milestone machinery never sees this domain,
//     and the finding copy carries no streak/badge/milestone language.
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
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
  addSubstanceDailyTotalCore,
  updateSubstanceDailyTotalCore,
} from "@/lib/substance-daily-totals-write";
import { restoreDeletedRow } from "@/lib/undo-delete-db";
import {
  collectUpcoming,
  getInferredPreventiveSatisfactions,
  getFrequencyTargetProgress,
  getSubstanceTarget,
  getSubstanceWeekState,
  getAllSubstanceWeekStates,
  getAlcoholWeeklyTrend,
  getSubstanceWeeklyTrend,
  getProfileSubstanceKeys,
  getLoggedSubstanceKeys,
  hasLoggedSubstance,
  getAllSubstanceDailyTotals,
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
import { CHANGE_DETECTION_DOMAIN_CENSUS } from "@/lib/change-detection";
import { isArguedExclusion } from "@/lib/loggable-domains";

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
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, 'alcohol', ?)
     ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = servings + excluded.servings`
  ).run(profileId, date, n);
}

describe("recordInstrumentScore (substance) — a biomarker reading, no flag, no crisis", () => {
  it("stores an AUDIT-C total with 0..4 per-item answers, banded, unflagged", () => {
    const p = newProfile("SU audit-c");
    const td = today(p);
    recordInstrumentScore(
      p,
      {
        instrument: "AUDIT-C",
        date: td,
        total: 9,
        answers: [4, 2, 3].map((answer, itemIndex) => ({ itemIndex, answer })),
      },
      "page"
    );

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
    recordInstrumentScore(
      p,
      { instrument: "AUDIT", date: td, total: 32 },
      "page"
    );
    recordInstrumentScore(
      p,
      { instrument: "DAST-10", date: td, total: 10 },
      "page"
    );
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
    recordInstrumentScore(
      p,
      { instrument: "AUDIT-C", date: td, total: 2 },
      "page"
    );
    recordInstrumentScore(
      p,
      { instrument: "DAST-10", date: td, total: 0 },
      "page"
    );

    const sats = getInferredPreventiveSatisfactions(p);
    expect(sats.some((s) => s.ruleKey === "alcohol_screening")).toBe(true);
    expect(sats.some((s) => s.ruleKey === "drug_use_screening")).toBe(true);
  });

  it("an AUDIT total also satisfies alcohol_screening but never the drug screening", () => {
    const p = newProfile("SU screen audit");
    setBirthdate(p, "1985-06-15");
    recordInstrumentScore(
      p,
      {
        instrument: "AUDIT",
        date: today(p),
        total: 5,
      },
      "page"
    );
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
    // The change-detection census must describe the production path above, not
    // claim that the floor-only Dashboard transition can see this cap tenant.
    expect(isArguedExclusion(CHANGE_DETECTION_DOMAIN_CENSUS.substance)).toBe(
      true
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
    expect(capProgressLine(state.status!)).toBe("5 of 7 this week.");
    expect(getSubstanceTarget(p, "alcohol")?.cap).toBe(7);
    // The trend's current week equals the week state (same window, same SUM).
    const trend = getAlcoholWeeklyTrend(p);
    expect(trend[trend.length - 1].isCurrent).toBe(true);
    expect(trend[trend.length - 1].count).toBe(5);
  });
});

describe("no gamification (#998) — structural exemption + copy guard", () => {
  it("scores and drink logs create no activities row and no milestone input", () => {
    const p = newProfile("SU exempt");
    const td = today(p);
    recordInstrumentScore(
      p,
      { instrument: "AUDIT-C", date: td, total: 4 },
      "page"
    );
    logFoodServingCore(p, "alcohol", td, "page");
    logFoodServingCore(p, "alcohol", td, "page");

    const activities = db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
      .get(p) as { n: number };
    expect(activities.n).toBe(0);

    const input = gatherMilestoneInput(p);
    expect(input.totalWorkouts).toBe(0);
    expect(input.completedGoals).toEqual([]);
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

describe("substance_daily_totals ledger (#1078) — split-ledger week rollup + trend", () => {
  it("one-tap log/undo increments and decrements the (profile, date, substance) row", () => {
    const p = newProfile("SU nic ledger");
    const td = today(p);

    const one = logSubstanceUnitCore(p, "nicotine", td, "page");
    expect(one).toEqual({ kind: "logged", units: 1, substance: "nicotine" });
    const two = logSubstanceUnitCore(p, "nicotine", td, "page");
    expect(two.kind === "logged" && two.units === 2).toBe(true);

    // One counter row per (profile, date, substance) — the food_daily_totals shape.
    const rows = db
      .prepare(
        `SELECT substance, units FROM substance_daily_totals WHERE profile_id = ? AND date = ?`
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
      .prepare(
        `SELECT COUNT(*) AS n FROM substance_daily_totals WHERE profile_id = ?`
      )
      .get(p) as { n: number };
    expect(left.n).toBe(0);
  });

  // #3279 MOVED THIS FIXTURE ACROSS ITS OWN BOUNDARY, DELIBERATELY. The "caffeine" case
  // stood for a forged key writing nothing; the vocabulary is open now, so caffeine is a
  // custom substance and this ledger is where it belongs. Alcohol's refusal is untouched
  // and is the half that still matters — it is a CURATED food-log fact, so the counter
  // ledger must keep turning it away. What replaces the forged case is a key not in
  // canonical stored form: a caller that skipped resolveSubstanceKey would otherwise mint
  // " Kratom " beside an existing "Kratom".
  it("refuses alcohol (food-log) and un-normalized keys: neither writes to the counter ledger", () => {
    const p = newProfile("SU ledger guard");
    expect(logSubstanceUnitCore(p, "alcohol", today(p), "page")).toEqual({
      kind: "unknown-substance",
    });
    expect(logSubstanceUnitCore(p, " Kratom ", today(p), "page")).toEqual({
      kind: "unknown-substance",
    });
    expect(logSubstanceUnitCore(p, "", today(p), "page")).toEqual({
      kind: "unknown-substance",
    });
    const n = db
      .prepare(
        `SELECT COUNT(*) AS n FROM substance_daily_totals WHERE profile_id = ?`
      )
      .get(p) as { n: number };
    expect(n.n).toBe(0);
  });

  it("week state + trend read the substance's OWN ledger — no cross-substance or cross-ledger leaks", () => {
    const p = newProfile("SU split ledgers");
    const td = today(p);
    logDrinks(p, td, 4); // food_daily_totals (alcohol)
    logSubstanceUnitCore(p, "nicotine", td, "page");
    logSubstanceUnitCore(p, "nicotine", td, "page");
    logSubstanceUnitCore(p, "cannabis", td, "page");

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
    for (let i = 0; i < 9; i++) logSubstanceUnitCore(p, "nicotine", td, "page");

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
    logSubstanceUnitCore(p, "cannabis", today(p), "page");
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
    for (let i = 0; i < 3; i++) logSubstanceUnitCore(p, "nicotine", td, "page");
    logSubstanceUnitCore(p, "cannabis", td, "page"); // 1 of 20 — silent

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
      logSubstanceUnitCore(p, "nicotine", td, "page");
      logSubstanceUnitCore(p, "cannabis", td, "page");
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
  it("substance_daily_totals writes create no activities row and no milestone input", () => {
    const p = newProfile("SU nic exempt");
    const td = today(p);
    for (let i = 0; i < 4; i++) logSubstanceUnitCore(p, "nicotine", td, "page");
    logSubstanceUnitCore(p, "cannabis", td, "page");

    const activities = db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
      .get(p) as { n: number };
    expect(activities.n).toBe(0);

    const input = gatherMilestoneInput(p);
    expect(input.totalWorkouts).toBe(0);
    expect(input.completedGoals).toEqual([]);
  });

  it("the per-substance finding copy carries no streak/badge/milestone/celebration language", () => {
    const p = newProfile("SU nic copy");
    const td = today(p);
    addCap(p, 1, "nicotine");
    addCap(p, 1, "cannabis");
    for (let i = 0; i < 3; i++) {
      logSubstanceUnitCore(p, "nicotine", td, "page");
      logSubstanceUnitCore(p, "cannabis", td, "page");
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

// #2073 — a historical correction that LOWERS a day's drink count has to decide
// which per-tap `food_log_events` rows survive. They are not interchangeable: each
// carries its own `recorded_at`, so the choice is what any timing surface over the
// alcohol group (a "last drink at HH:MM", mirroring the food-log timing work in
// lib/correction-time.ts) will read. The rule is drop the EARLIEST taps and keep
// the latest, so the day's last-drink instant survives a correction.
describe("alcohol event reconciliation trims the oldest taps (#2073)", () => {
  // Give the day's taps distinct instants. addSubstanceDailyTotalCore stamps a
  // whole batch with one clock read, so a fixture that wants tap ORDER must say so.
  function stampTapHours(profileId: number, date: string, hours: number[]) {
    const ids = db
      .prepare(
        `SELECT id FROM food_log_events
         WHERE profile_id = ? AND group_key = 'alcohol' AND date = ?
         ORDER BY id`
      )
      .all(profileId, date) as { id: number }[];
    expect(ids.length).toBe(hours.length);
    const stamp = db.prepare(
      "UPDATE food_log_events SET recorded_at = ? WHERE id = ?"
    );
    ids.forEach((row, i) => {
      stamp.run(`${date}T${String(hours[i]).padStart(2, "0")}:00:00Z`, row.id);
    });
  }

  function tapHours(profileId: number, date: string): string[] {
    return (
      db
        .prepare(
          `SELECT recorded_at FROM food_log_events
           WHERE profile_id = ? AND group_key = 'alcohol' AND date = ?
           ORDER BY recorded_at`
        )
        .all(profileId, date) as { recorded_at: string }[]
    ).map((row) => row.recorded_at);
  }

  it("keeps the latest taps when an edit shrinks the day", () => {
    const p = newProfile("SU trim oldest");
    const date = "2026-03-14";
    const added = addSubstanceDailyTotalCore(
      p,
      "alcohol",
      {
        date,
        amount: 4,
      },
      "page"
    );
    if (added.kind !== "added") throw new Error("history entry was not added");
    stampTapHours(p, date, [18, 19, 20, 21]);

    expect(
      updateSubstanceDailyTotalCore(
        p,
        "alcohol",
        added.id,
        {
          date,
          amount: 2,
        },
        "page"
      )
    ).toEqual({ kind: "updated", id: added.id });

    // The two EARLIEST taps are gone; the 20:00/21:00 pair — including the day's
    // last drink — is intact and untouched.
    expect(tapHours(p, date)).toEqual([
      `${date}T20:00:00Z`,
      `${date}T21:00:00Z`,
    ]);
    const servings = db
      .prepare(
        `SELECT servings FROM food_daily_totals
         WHERE profile_id = ? AND group_key = 'alcohol' AND date = ?`
      )
      .get(p, date) as { servings: number };
    expect(servings.servings).toBe(2);
  });

  it("keeps the surviving taps when the corrected day also MOVES", () => {
    const p = newProfile("SU trim oldest moved");
    const from = "2026-03-14";
    const to = "2026-03-15";
    const added = addSubstanceDailyTotalCore(
      p,
      "alcohol",
      {
        date: from,
        amount: 3,
      },
      "page"
    );
    if (added.kind !== "added") throw new Error("history entry was not added");
    stampTapHours(p, from, [17, 18, 19]);

    expect(
      updateSubstanceDailyTotalCore(
        p,
        "alcohol",
        added.id,
        {
          date: to,
          amount: 1,
        },
        "page"
      )
    ).toEqual({ kind: "updated", id: added.id });

    expect(tapHours(p, from)).toEqual([]);
    expect(tapHours(p, to)).toEqual([`${from}T19:00:00Z`]);
  });

  it("still APPENDS when a correction raises the day, leaving the existing taps alone", () => {
    const p = newProfile("SU trim grow");
    const date = "2026-03-14";
    const added = addSubstanceDailyTotalCore(
      p,
      "alcohol",
      {
        date,
        amount: 2,
      },
      "page"
    );
    if (added.kind !== "added") throw new Error("history entry was not added");
    stampTapHours(p, date, [18, 19]);

    expect(
      updateSubstanceDailyTotalCore(
        p,
        "alcohol",
        added.id,
        {
          date,
          amount: 4,
        },
        "page"
      )
    ).toEqual({ kind: "updated", id: added.id });

    const hours = tapHours(p, date);
    expect(hours.length).toBe(4);
    expect(hours.slice(0, 2)).toEqual([
      `${date}T18:00:00Z`,
      `${date}T19:00:00Z`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// #3279 — the OPEN VOCABULARY, end to end. A profile names its own substance and it
// behaves "like the curated three": one ledger, history correction, week state. The
// pure tier owns the naming rules; this tier owns what only a real DB can show —
// that no table, no migration and no branch was needed to carry it.
describe("custom substances (#3279)", () => {
  it("a logged custom substance joins the profile's vocabulary, and leaves when its last row does", () => {
    const p = newProfile("SU custom vocab");
    // Before anything is logged, the vocabulary is exactly the curated catalog.
    expect(getProfileSubstanceKeys(p)).toEqual([
      "alcohol",
      "nicotine",
      "cannabis",
    ]);

    const day = today(p);
    expect(logSubstanceUnitCore(p, "Kratom", day, "page")).toEqual({
      kind: "logged",
      units: 1,
      substance: "Kratom",
    });
    expect(getProfileSubstanceKeys(p)).toEqual([
      "alcohol",
      "nicotine",
      "cannabis",
      "Kratom",
    ]);
    expect(getSubstanceWeekState(p, "Kratom").count).toBe(1);

    // The ledger IS the register: undo the last unit and the row is dropped, so the
    // substance quietly leaves the vocabulary. That is why no forget-this-substance
    // affordance exists (docs/internals/substances.md).
    expect(undoSubstanceUnitCore(p, "Kratom", day)).toEqual({
      kind: "undone",
      units: 0,
      substance: "Kratom",
    });
    expect(getProfileSubstanceKeys(p)).toEqual([
      "alcohol",
      "nicotine",
      "cannabis",
    ]);
  });

  // #3327 — the OTHER question about a profile's substances, and the reason it needed
  // its own read. `getProfileSubstanceKeys` answers "what is the VOCABULARY?" and
  // always opens with the curated three, because they are the offered defaults on the
  // page that offers them. A quick surface must not offer them to somebody who has
  // never logged any: an empty offer is worse than no offer.
  it("distinguishes the offered vocabulary from what this profile has actually logged", () => {
    const p = newProfile("SU logged keys");
    const day = today(p);

    // A brand-new profile has the whole vocabulary and NOTHING logged. This is the
    // pair the quick-log row is gated on, and the two answers differ.
    expect(getProfileSubstanceKeys(p)).toEqual([
      "alcohol",
      "nicotine",
      "cannabis",
    ]);
    expect(getLoggedSubstanceKeys(p)).toEqual([]);
    expect(hasLoggedSubstance(p)).toBe(false);

    // A custom substance qualifies the moment it exists, because it exists BY being
    // logged — which is what keeps #3326's new substance reachable the same day.
    logSubstanceUnitCore(p, "Kratom", day, "page");
    expect(getLoggedSubstanceKeys(p)).toEqual(["Kratom"]);
    expect(hasLoggedSubstance(p)).toBe(true);

    // A curated substance qualifies on its own rows, and only on its own: logging
    // nicotine does not vouch for cannabis.
    logSubstanceUnitCore(p, "nicotine", day, "page");
    expect(getLoggedSubstanceKeys(p)).toEqual(["nicotine", "Kratom"]);

    // Alcohol's ledger is food_daily_totals (#860/#944), so its presence has to be
    // asked of the OTHER store — a scan of substance_daily_totals alone would report
    // a drinker as tracking nothing.
    logFoodServingCore(p, "alcohol", day, "page");
    expect(getLoggedSubstanceKeys(p)).toEqual([
      "alcohol",
      "nicotine",
      "Kratom",
    ]);
  });

  it("stops offering a substance to the quick surfaces once its last row is undone", () => {
    // The ledger-is-the-register contract reaching the quick-log gate: #3324 is the
    // open question about whether that is right for substances, and this pins what
    // the tree does today rather than what it should eventually do.
    const p = newProfile("SU logged keys undo");
    const day = today(p);
    logSubstanceUnitCore(p, "Kratom", day, "page");
    expect(hasLoggedSubstance(p)).toBe(true);
    undoSubstanceUnitCore(p, "Kratom", day);
    expect(getLoggedSubstanceKeys(p)).toEqual([]);
    expect(hasLoggedSubstance(p)).toBe(false);
  });

  it("carries a custom substance through history correction like the curated three", () => {
    const p = newProfile("SU custom history");
    const date = shiftDateStr(today(p), -3);
    const added = addSubstanceDailyTotalCore(
      p,
      "  Energy drinks ",
      {
        date,
        amount: 2,
        notes: "two cans",
      },
      "page"
    );
    if (added.kind !== "added")
      throw new Error("custom history entry not added");

    // Normalized ONCE at the write boundary, so the stray-whitespace spelling and the
    // clean one are the same row rather than two neighbours.
    const rows = getAllSubstanceDailyTotals(p).filter(
      (r) => r.substance === "Energy drinks"
    );
    expect(rows).toEqual([
      {
        id: added.id,
        substance: "Energy drinks",
        date,
        amount: 2,
        notes: "two cans",
      },
    ]);

    expect(
      updateSubstanceDailyTotalCore(
        p,
        "Energy drinks",
        added.id,
        {
          date,
          amount: 5,
        },
        "page"
      )
    ).toEqual({ kind: "updated", id: added.id });
    // The correction flows through the shared cadence ledger, so the trend sees it —
    // the row's day may be in the current week or the previous one depending on where
    // today() falls, which is exactly why this sums the window instead of indexing it.
    expect(
      getSubstanceWeeklyTrend(p, "Energy drinks", 2).reduce(
        (n, w) => n + w.count,
        0
      )
    ).toBe(5);

    // A custom substance is never a food, whatever it is called: the nutrition ledger
    // stays empty even for a name containing a curated one.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM food_daily_totals WHERE profile_id = ?`
        )
        .get(p)
    ).toEqual({ n: 0 });
  });

  it("stays NEUTRAL with no cap: no status, no finding, no digest line", () => {
    const p = newProfile("SU custom neutral");
    const day = today(p);
    for (let i = 0; i < 9; i += 1) logSubstanceUnitCore(p, "Kratom", day, "page");

    // #3279 ruling 1. Nine uses is a fact, not a verdict. With no target row there is
    // no SubstanceCapStatus for any surface to render — the opt-in is structural, so
    // this is an absence of DATA, not a flag someone remembered to check.
    const state = getSubstanceWeekState(p, "Kratom");
    expect(state.count).toBe(9);
    expect(state.target).toBeNull();
    expect(state.status).toBeNull();
    expect(buildSubstanceUseFindings(p)).toEqual([]);

    // And it never nags toward MORE: a substance cap is a ceiling, so it stays out of
    // the floor-semantics frequency rollup even once one is set.
    db.prepare(
      `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
       VALUES ('substance', 'Kratom', 3, ?)`
    ).run(p);
    expect(
      getFrequencyTargetProgress(p).some(
        (t) => t.target.scope_value === "Kratom"
      )
    ).toBe(false);

    // With the cap now opted into, the SAME nine uses do carry a verdict — and it
    // names the substance the person named.
    const capped = getSubstanceWeekState(p, "Kratom");
    expect(capped.status).not.toBeNull();
    expect(capProgressLine(capped.status!, "Kratom")).toBe(
      "9 uses logged this week — 6 over your 3-use weekly cap."
    );
    const findings = buildSubstanceUseFindings(p);
    expect(findings.length).toBe(1);
    expect(findings[0].title).toBe("Kratom is over your weekly target");
  });
});

// ---------------------------------------------------------------------------
// #4435 — the historical substance write core used to re-spell food insertion and
// broke four contracts every other food path holds. One block, four demonstrations:
// a backfill ADDS, a re-date never leaves an instant on the day the row left, a
// correction that shrinks a day is undoable, and a substance write says which
// surface filed it.

/** Every alcohol tap this profile holds, in ledger order. */
function alcoholTaps(profileId: number) {
  return db
    .prepare(
      `SELECT date, occurred_at, time_source FROM food_log_events
        WHERE profile_id = ? AND group_key = 'alcohol' ORDER BY id`
    )
    .all(profileId);
}

/** The day rows the record renders, for one day. */
function historyOn(profileId: number, date: string) {
  return getAllSubstanceDailyTotals(profileId).filter((r) => r.date === date);
}

describe("the substance write core keeps the shared food contracts (#4435)", () => {
  // BOTH LEDGERS, because both refused: alcohol rides food_daily_totals and
  // nicotine rides substance_daily_totals, and the refusal was written twice.
  it.each(["alcohol", "nicotine"])(
    "backfills %s ADDITIVELY onto a day that already has some",
    (substance) => {
      const p = newProfile(`SU additive ${substance}`);
      const date = shiftDateStr(today(p), -4);
      const first = addSubstanceDailyTotalCore(
        p,
        substance,
        { date, amount: 1, notes: "the first one" },
        "page"
      );
      if (first.kind !== "added") throw new Error("first backfill was refused");

      // The second one lands on the SAME day row rather than being refused as a
      // conflict: remembering a second drink is the ordinary case, not an error.
      expect(
        addSubstanceDailyTotalCore(p, substance, { date, amount: 2 }, "page")
      ).toEqual({ kind: "added", id: first.id });
      expect(historyOn(p, date)).toEqual([
        { id: first.id, substance, date, amount: 3, notes: "the first one" },
      ]);
    }
  );

  it("never leaves a tap's instant on the day its row left", () => {
    const p = newProfile("SU redate instant");
    const from = shiftDateStr(today(p), -5);
    const to = shiftDateStr(today(p), -4);
    const added = addSubstanceDailyTotalCore(
      p,
      "alcohol",
      { date: from, amount: 1 },
      "page"
    );
    if (added.kind !== "added") throw new Error("backfill was refused");
    // A stated instant on the row's own day — what a correction chip or a picker
    // leaves behind, and the only shape judgeEatenAt accepts anywhere else.
    db.prepare(
      `UPDATE food_log_events SET occurred_at = ?, time_source = 'stated'
        WHERE profile_id = ? AND group_key = 'alcohol' AND date = ?`
    ).run(`${from}T21:30:00Z`, p, from);

    expect(
      updateSubstanceDailyTotalCore(
        p,
        "alcohol",
        added.id,
        { date: to, amount: 1 },
        "page"
      )
    ).toEqual({ kind: "updated", id: added.id });

    // The day moved, so the hour nobody restated cannot survive it: an instant
    // sitting on the previous day would be the cross-day pair every other write
    // refuses to create.
    expect(alcoholTaps(p)).toEqual([
      { date: to, occurred_at: null, time_source: null },
    ]);
  });

  it("captures the drinks a shrinking correction drops, so they can come back", () => {
    const p = newProfile("SU shrink undo");
    const date = shiftDateStr(today(p), -6);
    const added = addSubstanceDailyTotalCore(
      p,
      "alcohol",
      { date, amount: 3 },
      "page"
    );
    if (added.kind !== "added") throw new Error("backfill was refused");

    expect(
      updateSubstanceDailyTotalCore(
        p,
        "alcohol",
        added.id,
        { date, amount: 1 },
        "page"
      )
    ).toEqual({ kind: "updated", id: added.id });
    expect(alcoholTaps(p).length).toBe(1);

    // Two taps went; two captures exist, and restoring them puts the day back —
    // the #2642 contract every other food-row removal already holds.
    const captured = db
      .prepare(
        `SELECT id FROM deleted_rows
          WHERE profile_id = ? AND kind = 'food-serving' ORDER BY id`
      )
      .all(p) as { id: number }[];
    expect(captured.length).toBe(2);
    for (const row of captured) expect(restoreDeletedRow(p, row.id)).toBe(true);
    expect(alcoholTaps(p).length).toBe(3);
  });

  // A DAY TOTAL carries the surface of the tap that last filed into it, exactly as
  // it already carries that tap's `recorded_at`. Both doors, because the one-tap
  // core took no such argument at all and the history core ignored the one it had.
  it.each([
    [
      "one-tap",
      (p: number, date: string) =>
        logSubstanceUnitCore(p, "nicotine", date, "quick-log"),
    ],
    [
      "backfill",
      (p: number, date: string) =>
        addSubstanceDailyTotalCore(
          p,
          "nicotine",
          { date, amount: 2 },
          "quick-log"
        ),
    ],
  ])("stamps logged_via on a substance %s", (_door, write) => {
    const p = newProfile(`SU via ${_door}`);
    const date = shiftDateStr(today(p), -2);
    write(p, date);
    expect(
      db
        .prepare(
          `SELECT logged_via FROM substance_daily_totals
            WHERE profile_id = ? AND substance = 'nicotine' AND date = ?`
        )
        .get(p, date)
    ).toEqual({ logged_via: "quick-log" });
  });
});

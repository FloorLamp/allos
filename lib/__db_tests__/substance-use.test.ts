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
  correctSubstanceEventCore,
  deleteSubstanceEventCore,
  logSubstanceUnitCore,
  undoSubstanceUnitCore,
} from "@/lib/substance-log-write";
import {
  addSubstanceDailyTotalCore,
  deleteSubstanceDailyTotalCore,
} from "@/lib/substance-daily-totals-write";
import { restoreDeletedRow } from "@/lib/undo-delete-db";
// The deploy step itself, so the pre-deploy trash capture below meets it in the
// order a real upgrade does.
import { backfill } from "@/lib/migrations/versions/20260905-substance-event-rows";
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
    expect(one).toEqual({
      kind: "logged",
      units: 1,
      substance: "nicotine",
      eventId: expect.any(Number),
    });
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

// #5026 phase 2 — A USE IS AN EVENT, ON EVERY LEDGER. Phase 1 left one day-count
// correction standing for nicotine, cannabis and custom keys, because for them the day
// still WAS the stored fact. It is not any more: the same three questions a drink
// answers — which day, which minute, and can one use be taken out without taking its
// neighbours — are asked here of the ledger phase 2 gave them.
//
// THE FIXTURE STATES TWO DIFFERENT MINUTES ON ONE DAY, deliberately: a fixture whose
// uses share a clock cannot show a correction levelling them, which is the defect the
// day-count form had and the one this door exists not to have.
describe("one use, one row, one clock (#5026 phase 2)", () => {
  function uses(profileId: number, substance: string) {
    return db
      .prepare(
        `SELECT id, date, occurred_at, time_source FROM substance_log_events
         WHERE profile_id = ? AND substance = ? ORDER BY id`
      )
      .all(profileId, substance) as {
      id: number;
      date: string;
      occurred_at: string | null;
      time_source: string | null;
    }[];
  }
  function dayRows(profileId: number, substance: string) {
    return db
      .prepare(
        `SELECT date, units, notes FROM substance_daily_totals
         WHERE profile_id = ? AND substance = ? ORDER BY date`
      )
      .all(profileId, substance) as {
      date: string;
      units: number;
      notes: string | null;
    }[];
  }

  it.each(["nicotine", "cannabis", "Energy drinks"])(
    "%s: each unit of one entry is its own row carrying the stated minute",
    (substance) => {
      const p = newProfile(`SU events ${substance}`);
      const date = shiftDateStr(today(p), -3);
      const added = addSubstanceDailyTotalCore(
        p,
        substance,
        { date, amount: 2, statedAt: `${date}T21:00:00Z`, notes: "as filed" },
        "page"
      );
      expect(added.kind).toBe("added");
      // TWO rows, not one row saying two — and each carries the statement, because the
      // form collects one time for one submission.
      expect(uses(p, substance)).toEqual([
        {
          id: expect.any(Number),
          date,
          occurred_at: `${date}T21:00:00Z`,
          time_source: "stated",
        },
        {
          id: expect.any(Number),
          date,
          occurred_at: `${date}T21:00:00Z`,
          time_source: "stated",
        },
      ]);
      // The counter is still the day's rollup beside them, and the note is still the
      // day's — one sentence, not one per use.
      expect(dayRows(p, substance)).toEqual([
        { date, units: 2, notes: "as filed" },
      ]);
    }
  );

  it("an unstated use keeps a NULL instant rather than inheriting its tap stamp", () => {
    const p = newProfile("SU events unstated");
    const date = shiftDateStr(today(p), -2);
    addSubstanceDailyTotalCore(p, "nicotine", { date, amount: 1 }, "page");
    logSubstanceUnitCore(p, "nicotine", date, "page", `${date}T08:15:00Z`);
    expect(uses(p, "nicotine")).toEqual([
      { id: expect.any(Number), date, occurred_at: null, time_source: null },
      { id: expect.any(Number), date, occurred_at: null, time_source: null },
    ]);
    // The tap instant IS recorded — as the filing stamp it is, in its own column.
    expect(
      db
        .prepare(
          `SELECT recorded_at FROM substance_log_events
            WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(p)
    ).toEqual({ recorded_at: `${date}T08:15:00Z` });
  });

  it("corrects ONE use's day and minute, and the use beside it does not move", () => {
    const p = newProfile("SU events correct one");
    const date = shiftDateStr(today(p), -3);
    addSubstanceDailyTotalCore(
      p,
      "nicotine",
      { date, amount: 1, statedAt: `${date}T21:00:00Z` },
      "page"
    );
    addSubstanceDailyTotalCore(
      p,
      "nicotine",
      { date, amount: 1, statedAt: `${date}T23:00:00Z` },
      "page"
    );
    const [first, second] = uses(p, "nicotine");
    const moved = shiftDateStr(date, 1);

    expect(
      correctSubstanceEventCore(p, first.id, {
        date: moved,
        statedAt: new Date(`${moved}T09:30:00Z`),
      })
    ).toEqual({ kind: "updated", eventId: first.id, date: moved });

    expect(uses(p, "nicotine")).toEqual([
      {
        id: first.id,
        date: moved,
        occurred_at: `${moved}T09:30:00Z`,
        time_source: "stated",
      },
      // THE ONE THAT WAS NOT CORRECTED, asserted rather than assumed: the day-count
      // form levelled every clock under the day it restated, and the whole point of
      // correcting an event is that its neighbour is untouched.
      {
        id: second.id,
        date,
        occurred_at: `${date}T23:00:00Z`,
        time_source: "stated",
      },
    ]);
    // The counter followed the move — one unbump, one bump — so the card and the cap
    // count the use on the day it now sits on.
    expect(dayRows(p, "nicotine")).toEqual([
      { date, units: 1, notes: null },
      { date: moved, units: 1, notes: null },
    ]);
  });

  it("clears a stated minute back to nobody-said, and leaves the day alone", () => {
    const p = newProfile("SU events clear");
    const date = shiftDateStr(today(p), -1);
    addSubstanceDailyTotalCore(
      p,
      "cannabis",
      { date, amount: 1, statedAt: `${date}T20:00:00Z` },
      "page"
    );
    const [only] = uses(p, "cannabis");
    expect(
      correctSubstanceEventCore(p, only.id, { date, statedAt: null })
    ).toEqual({ kind: "updated", eventId: only.id, date });
    expect(uses(p, "cannabis")).toEqual([
      { id: only.id, date, occurred_at: null, time_source: null },
    ]);
    expect(dayRows(p, "cannabis")).toEqual([{ date, units: 1, notes: null }]);
  });

  // THE REFUSALS, and each one writes NOTHING. A correction's statement IS its
  // submission, so an instant off the row's day costs the save rather than being
  // quietly dropped — the opposite of the log path's posture, and #2296's distinction.
  it.each([
    ["a future day", { date: shiftDateStr("2999-01-01", 0) }, "invalid-date"],
    ["a use that is not this profile's", null, "not-found"],
  ] as const)("refuses %s", (_label, patch, kind) => {
    const p = newProfile(`SU events refuse ${kind}`);
    const date = shiftDateStr(today(p), -1);
    addSubstanceDailyTotalCore(p, "nicotine", { date, amount: 1 }, "page");
    const [only] = uses(p, "nicotine");
    const outcome =
      patch === null
        ? correctSubstanceEventCore(p, only.id + 9000, { date })
        : correctSubstanceEventCore(p, only.id, patch);
    expect(outcome.kind).toBe(kind);
    expect(uses(p, "nicotine")).toEqual([
      { id: only.id, date, occurred_at: null, time_source: null },
    ]);
  });

  it("refuses an instant that is not on the use's own day", () => {
    const p = newProfile("SU events other day");
    const date = shiftDateStr(today(p), -2);
    addSubstanceDailyTotalCore(p, "nicotine", { date, amount: 1 }, "page");
    const [only] = uses(p, "nicotine");
    expect(
      correctSubstanceEventCore(p, only.id, {
        statedAt: new Date(`${shiftDateStr(date, -1)}T12:00:00Z`),
      })
    ).toEqual({ kind: "invalid-stated-at", reason: "other-day" });
    expect(uses(p, "nicotine")).toEqual([
      { id: only.id, date, occurred_at: null, time_source: null },
    ]);
  });

  // A MOVE THAT WOULD STRAND A DAY'S NOTE IS REFUSED, AND WRITES NOTHING. The ledger
  // drops a counter row at zero and the day's note lives only on it, so re-dating the
  // LAST use of a noted day would delete a sentence somebody typed — through a door
  // that captures no undo. It costs a move `main` allows — its day form re-dates a
  // noted day onto a free date and the note travels, and case one below is exactly that
  // free destination — so this is a named regression, not an inherited posture. #5304
  // removes the situation by moving the note onto the use.
  //
  // THE FIXTURE IS TWO PROFILES AND TWO SUBSTANCES ON PURPOSE. The refusal reads ONE
  // row — the vacated day's own — and every predicate of that read is a way to refuse
  // somebody else's move or to miss this one. Row 1 is the refusal; rows 2-4 are the
  // NEAR MISSES that must still move, each of which is a different predicate dropped:
  // a neighbour profile's noted day at the same coordinate, this profile's noted day
  // for another substance, and this profile's noted day on another date. Row 5 is the
  // boundary: a noted day the move does not empty keeps its note and moves the use.
  it.each([
    ["its own noted day", "own", "day-note-stranded"],
    ["a neighbour profile's noted day on the same day", "neighbour", "updated"],
    ["this profile's noted day for another substance", "substance", "updated"],
    ["this profile's noted day on another date", "date", "updated"],
    ["a noted day the move does not empty", "not-last", "updated"],
  ] as const)("refuses the move only for %s", (_label, decoy, kind) => {
    // The NEIGHBOUR is created first in every case, so a read that has lost its
    // profile predicate meets the same row whichever case it is in — which is what
    // makes one of these two rows red rather than leaving it to scan order.
    const other = newProfile(`SU strand neighbour ${decoy}`);
    const p = newProfile(`SU strand ${decoy}`);
    const date = shiftDateStr(today(p), -3);
    const moved = shiftDateStr(date, 1);
    const noteOn = (
      profileId: number,
      substance: string,
      day: string,
      amount: number
    ) =>
      addSubstanceDailyTotalCore(
        profileId,
        substance,
        { date: day, amount, notes: "quitting attempt, day 4" },
        "page"
      );

    if (decoy === "neighbour") noteOn(other, "nicotine", date, 1);
    if (decoy === "substance") noteOn(p, "cannabis", date, 1);
    // ON BOTH SIDES OF THE DAY, and the second one is not redundant. A read that has
    // lost its date predicate meets whichever noted row its scan reaches FIRST, and
    // that order is the index's, not the fixture's: `idx_substance_daily_totals_profile`
    // is `(profile_id, date DESC)`, so an EARLIER-only decoy is reached LAST and the
    // mutant lands on the correct row by luck — MEASURED, that mutant was green until
    // the later day was added. With one on each side the refusal reds whichever way the
    // scan runs, so this survives a planner or index change rather than pinning today's.
    if (decoy === "date") {
      noteOn(p, "nicotine", shiftDateStr(date, -1), 1);
      noteOn(p, "nicotine", shiftDateStr(date, 2), 1);
    }
    // The day under correction: noted only in the case that must refuse, and carrying
    // a second use in the boundary case so the move does not empty it.
    if (decoy === "own") noteOn(p, "nicotine", date, 1);
    else if (decoy === "not-last") noteOn(p, "nicotine", date, 2);
    else addSubstanceDailyTotalCore(p, "nicotine", { date, amount: 1 }, "page");

    const mine = uses(p, "nicotine").filter((u) => u.date === date);
    const before = dayRows(p, "nicotine");
    expect(correctSubstanceEventCore(p, mine[0].id, { date: moved }).kind).toBe(
      kind
    );

    if (kind === "day-note-stranded") {
      // NOTHING WAS WRITTEN: the event still sits on its day and the counter is
      // untouched, so the refusal costs the save rather than half-performing it.
      expect(uses(p, "nicotine").map((u) => u.date)).toEqual([date]);
      expect(dayRows(p, "nicotine")).toEqual(before);
    } else {
      expect(uses(p, "nicotine").find((u) => u.id === mine[0].id)?.date).toBe(
        moved
      );
    }
  });

  // AND THE NOTE THE DESTINATION ALREADY HAS IS NEVER TOUCHED — the shape that broke
  // the carry this refusal replaced: two typed notes, one of them was overwritten and
  // the other deleted. Both survive, and both days keep their own.
  it("refuses rather than merging two days' notes into one", () => {
    const p = newProfile("SU strand two notes");
    const date = shiftDateStr(today(p), -3);
    const moved = shiftDateStr(date, 1);
    addSubstanceDailyTotalCore(
      p,
      "nicotine",
      { date, amount: 1, notes: "quitting attempt, day 4" },
      "page"
    );
    addSubstanceDailyTotalCore(
      p,
      "nicotine",
      { date: moved, amount: 1, notes: "birthday" },
      "page"
    );
    const [first] = uses(p, "nicotine");
    expect(correctSubstanceEventCore(p, first.id, { date: moved }).kind).toBe(
      "day-note-stranded"
    );
    expect(dayRows(p, "nicotine")).toEqual([
      { date, units: 1, notes: "quitting attempt, day 4" },
      { date: moved, units: 1, notes: "birthday" },
    ]);
  });

  // ONE PROFILE'S DELETE MOVES ONE PROFILE'S COUNTER. The `substance-use` kind captures
  // its day counter through a `childWhere` that filters on the EVENT's own profile, and
  // `captureDelete` then unbumps once per captured row against the ACTING profile — so
  // with that predicate gone a neighbour's counter row on the same (date, substance)
  // makes the acting profile's counter fall by two. A single-profile fixture cannot see
  // that, which is why this one has two.
  it("deleting a use decrements only this profile's counter, never a neighbour's", () => {
    const mine = newProfile("SU counter mine");
    const theirs = newProfile("SU counter theirs");
    const d = today(mine);
    logSubstanceUnitCore(mine, "nicotine", d, "page", `${d}T09:00:00Z`);
    logSubstanceUnitCore(mine, "nicotine", d, "page", `${d}T10:00:00Z`);
    logSubstanceUnitCore(theirs, "nicotine", d, "page", `${d}T11:00:00Z`);

    const [first] = uses(mine, "nicotine");
    expect(deleteSubstanceEventCore(mine, first.id).kind).toBe("deleted");

    // Two units minus the one deleted, not minus two — and the neighbour is untouched.
    expect(dayRows(mine, "nicotine")).toEqual([
      { date: d, units: 1, notes: null },
    ]);
    expect(dayRows(theirs, "nicotine")).toEqual([
      { date: d, units: 1, notes: null },
    ]);
  });

  // AND ONE PROFILE'S UNDO MAY NOT WRITE INTO ANOTHER'S RECORD, which is the same
  // boundary on the other side of the delete. The day delete captures its use events by
  // NATURAL KEY — (profile, substance, date) — and the restore puts back what was
  // captured verbatim: `remapRow` drops only `id`, so a captured row carries its own
  // `profile_id` back into the table and nothing downstream re-scopes it. The capture's
  // profile predicate is therefore the ONLY thing between an Undo and a cross-profile
  // write. Measured with that predicate mutated to `OR 1=1`: the delete still spared the
  // neighbour, because its own DELETE is re-scoped, and the UNDO then gave them four
  // events behind a counter still reading two — real by one reading and absent by the
  // other, the state #5026 exists to remove. Nothing was watching that.
  it("a neighbour's day delete and undo leaves this profile's uses untouched", () => {
    const mine = newProfile("SU undo scope mine");
    const theirs = newProfile("SU undo scope theirs");
    const d = today(mine);
    // SAME substance, SAME date. A fixture on two dates or two keys cannot reach the
    // profile predicate at all — the other two predicates would refuse the row first.
    logSubstanceUnitCore(mine, "nicotine", d, "page", `${d}T09:00:00Z`);
    logSubstanceUnitCore(mine, "nicotine", d, "page", `${d}T10:00:00Z`);
    for (const hour of ["11", "12", "13"])
      logSubstanceUnitCore(
        theirs,
        "nicotine",
        d,
        "page",
        `${d}T${hour}:00:00Z`
      );

    const theirRow = db
      .prepare(
        `SELECT id FROM substance_daily_totals
          WHERE profile_id = ? AND substance = 'nicotine' AND date = ?`
      )
      .get(theirs, d) as { id: number };
    const deleted = deleteSubstanceDailyTotalCore(
      theirs,
      "nicotine",
      theirRow.id
    );
    if (deleted.kind !== "deleted")
      throw new Error("their day was not deleted");
    expect(restoreDeletedRow(theirs, deleted.undoId)).toBe(true);

    // Both halves on both sides: their day is whole again and mine never moved.
    expect(uses(mine, "nicotine")).toHaveLength(2);
    expect(dayRows(mine, "nicotine")).toEqual([
      { date: d, units: 2, notes: null },
    ]);
    expect(uses(theirs, "nicotine")).toHaveLength(3);
    expect(dayRows(theirs, "nicotine")).toEqual([
      { date: d, units: 3, notes: null },
    ]);
  });

  // AND THE OTHER TWO PREDICATES OF THAT CAPTURE ARE THE SAME QUESTION INSIDE ONE
  // PROFILE. The events `childWhere` is (profile, substance, date); the test above
  // holds the first. Drop either of the others and a day delete carries off rows it
  // never counted — the same day's OTHER substance, or the SAME substance's other
  // days — and each of those counters is left standing over an empty record, the
  // state #5026 exists to remove. One profile is the point rather than a shortcut:
  // this predicate pair needs no neighbour to go wrong.
  it("a day delete takes only that substance and only that date", () => {
    const p = newProfile("SU day delete scope");
    const d = today(p);
    const before = shiftDateStr(d, -1);
    logSubstanceUnitCore(p, "nicotine", d, "page", `${d}T09:00:00Z`);
    logSubstanceUnitCore(p, "cannabis", d, "page", `${d}T10:00:00Z`);
    logSubstanceUnitCore(p, "nicotine", before, "page", `${before}T21:00:00Z`);

    const row = db
      .prepare(
        `SELECT id FROM substance_daily_totals
          WHERE profile_id = ? AND substance = 'nicotine' AND date = ?`
      )
      .get(p, d) as { id: number };
    expect(deleteSubstanceDailyTotalCore(p, "nicotine", row.id).kind).toBe(
      "deleted"
    );

    // The day it named is gone on both halves…
    expect(dayRows(p, "nicotine")).toEqual([
      { date: before, units: 1, notes: null },
    ]);
    // …and the two uses it did not name are still there, each behind its own counter.
    expect(uses(p, "nicotine").map((u) => u.date)).toEqual([before]);
    expect(uses(p, "cannabis")).toHaveLength(1);
    expect(dayRows(p, "cannabis")).toEqual([
      { date: d, units: 1, notes: null },
    ]);
  });

  // A DAY DELETED BEFORE THIS DEPLOY IS STILL IN THE TRASH ON THE DAY OF IT. The
  // capture taken by `main` has one entity (`entry`) because there was no use ledger
  // under it; restore reads `payload.rows[entity] ?? []`, so the entity a pre-deploy
  // capture lacks comes back as NOTHING and says nothing about it. Trash retention is
  // 30 days, so every capture from the month before the deploy is live at deploy time
  // and Data → Trash is the door onto it — a restore would hand back a counter of 3
  // with an empty record, manufacturing the exact state this migration exists to
  // remove, AFTER it ran. So the migration rewrites the stored snapshots too, the way
  // 183-food-event-occurred-at did one table over.
  //
  // The fixture strips `events` from a real capture, which IS the pre-deploy payload,
  // and then runs the migration's own backfill seam over it — the deploy, in the order
  // it happens.
  it("a day deleted before the ledger shipped restores its uses, not just its count", () => {
    const p = newProfile("SU legacy trash restore");
    const d = today(p);
    for (const hour of ["08", "09", "10"])
      logSubstanceUnitCore(p, "nicotine", d, "page", `${d}T${hour}:00:00Z`);
    const row = db
      .prepare(
        `SELECT id FROM substance_daily_totals
          WHERE profile_id = ? AND substance = 'nicotine' AND date = ?`
      )
      .get(p, d) as { id: number };
    const deleted = deleteSubstanceDailyTotalCore(p, "nicotine", row.id);
    if (deleted.kind !== "deleted") throw new Error("the day was not deleted");

    const stored = db
      .prepare(`SELECT payload FROM deleted_rows WHERE id = ?`)
      .get(deleted.undoId) as { payload: string };
    const legacy = JSON.parse(stored.payload) as {
      rows: Record<string, unknown[]>;
    };
    delete legacy.rows.events;
    db.prepare(`UPDATE deleted_rows SET payload = ? WHERE id = ?`).run(
      JSON.stringify(legacy),
      deleted.undoId
    );

    backfill(db);

    expect(restoreDeletedRow(p, deleted.undoId)).toBe(true);
    expect(dayRows(p, "nicotine")).toEqual([
      { date: d, units: 3, notes: null },
    ]);
    // Three uses behind the three the counter reads — and no instant invented for
    // any of them, exactly as the migration's derived rows carry none.
    expect(uses(p, "nicotine")).toEqual([
      { id: expect.any(Number), date: d, occurred_at: null, time_source: null },
      { id: expect.any(Number), date: d, occurred_at: null, time_source: null },
      { id: expect.any(Number), date: d, occurred_at: null, time_source: null },
    ]);
  });

  it("undoing a use retires the newest event, not just the count", () => {
    const p = newProfile("SU events undo");
    const day = today(p);
    logSubstanceUnitCore(p, "nicotine", day, "page", `${day}T09:00:00Z`);
    logSubstanceUnitCore(p, "nicotine", day, "page", `${day}T10:00:00Z`);
    expect(uses(p, "nicotine")).toHaveLength(2);
    expect(undoSubstanceUnitCore(p, "nicotine", day)).toEqual({
      kind: "undone",
      units: 1,
      substance: "nicotine",
    });
    // The 10:00 tap is the one that went — an undo is the inverse of the tap that just
    // happened, so a count that fell by one with the WRONG row removed would pass a
    // count-only assertion and fail this one.
    expect(
      db
        .prepare(
          `SELECT recorded_at FROM substance_log_events WHERE profile_id = ?`
        )
        .all(p)
    ).toEqual([{ recorded_at: `${day}T09:00:00Z` }]);
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
      eventId: expect.any(Number),
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

  it("carries a custom substance through the history door like the curated three", () => {
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

    // The entry flows through the shared cadence ledger, so the trend sees it — the
    // row's day may be in the current week or the previous one depending on where
    // today() falls, which is exactly why this sums the window instead of indexing it.
    expect(
      getSubstanceWeeklyTrend(p, "Energy drinks", 2).reduce(
        (n, w) => n + w.count,
        0
      )
    ).toBe(2);

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
    for (let i = 0; i < 9; i += 1)
      logSubstanceUnitCore(p, "Kratom", day, "page");

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
// broke four contracts every other food path holds. Two of the four were about its
// day-count CORRECTION of alcohol — a re-date leaving no instant behind, and a shrink
// being undoable — and that correction is gone (#5026 item 1), so what those two
// demonstrated is now asserted where it is still reachable: the instant that cannot
// outlive its row's day in lib/__db_tests__/food-log-event-correction.test.ts, and the
// #2642 capture `deleteFoodLogEventCore` writes in
// lib/__db_tests__/day-ledger-selection-edit.test.ts, which is the file that reads
// `deleted_rows` after that core runs. What is left here is the ADD, on both ledgers,
// and the surface stamp.

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

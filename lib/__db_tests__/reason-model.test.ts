// The shared reason model against a real schema (issue #656). The load-bearing
// "one question, one computation" pin at the EXPLANATION layer: ONE fixture (a
// family-cardiac-history profile with a stale flagged LDL and a fresh flagged total
// cholesterol) must yield the SAME structured reason on the Upcoming item, the
// attention-model item, and the Telegram digest model — never re-derived or dropped
// per surface. Plus item 4: a risk-elevated flagged biomarker gains a why-for-this-
// profile line on the hero.
//
// All fixture values are synthetic (obviously-fictional profile, plain lab names,
// a generic family-history string) — no real PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming } from "@/lib/queries/upcoming";
import { collectAttentionModel } from "@/lib/queries/attention";
import { groupUpcoming } from "@/lib/upcoming";
import { buildUpcomingDigest } from "@/lib/notifications/upcoming-digest";
import { primaryReason } from "@/lib/reasons";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addFamilyHistory(profileId: number, condition: string): void {
  db.prepare(
    "INSERT INTO family_history (profile_id, relation, condition) VALUES (?, 'parent', ?)"
  ).run(profileId, condition);
}

// A lab reading. `dateOffsetDays` sets the collection date (negative = past);
// created_at is set to now unless overridden so the fresh reading lights the flag
// window and the stale one doesn't.
function addLab(
  profileId: number,
  opts: {
    name: string;
    canonical: string;
    value: string;
    flag: string;
    dateOffsetDays: number;
    createdAtModifier?: string;
  }
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, flag, created_at)
     VALUES (?, ?, 'lab', ?, ?, 'mg/dL', ?, ?, datetime('now', ?))`
  ).run(
    profileId,
    shiftDateStr(today(profileId), opts.dateOffsetDays),
    opts.name,
    opts.value,
    opts.canonical,
    opts.flag,
    opts.createdAtModifier ?? "+0 seconds"
  );
}

const RISK_TEXT = "Family history of heart disease";
const RISK_SOURCE = "ACC/AHA (informational)";

describe("shared reason model (issue #656)", () => {
  it("carries the SAME risk reason on the Upcoming item, the attention item, and the digest", () => {
    const pid = createProfile("Reason Model A");
    const td = today(pid);
    addFamilyHistory(pid, "Heart disease");
    // A stale (2-year-old) flagged LDL → a retest item, risk-elevated.
    addLab(pid, {
      name: "LDL Cholesterol",
      canonical: "LDL Cholesterol",
      value: "190",
      flag: "high",
      dateOffsetDays: -730,
      createdAtModifier: "-730 days",
    });

    // 1) The Upcoming retest item carries the cited risk reason as DATA.
    const upcoming = collectUpcoming(pid, td);
    const retest = upcoming.find(
      (i) => i.domain === "biomarker" && i.title === "Retest LDL Cholesterol"
    );
    expect(
      retest,
      "a stale flagged LDL should produce a retest item"
    ).toBeDefined();
    expect(retest!.reasons).toContainEqual({
      code: "risk-elevated",
      text: RISK_TEXT,
      source: RISK_SOURCE,
    });
    // The cited risk line LEADS (why sooner), so it's the primary reason.
    expect(primaryReason(retest!.reasons)!.text).toBe(RISK_TEXT);
    // detail is unchanged / still flattens the reason (back-compat display).
    expect(retest!.detail).toContain(RISK_TEXT);

    // 2) The SAME item in the attention model carries the SAME reasons (the model
    // spreads collectUpcoming — one computation, not a second derivation).
    const model = collectAttentionModel(pid, td);
    const retestInModel = model.find((i) => i.key === retest!.key);
    expect(retestInModel).toBeDefined();
    expect(retestInModel!.reasons).toEqual(retest!.reasons);

    // 3) The digest surfaces that SAME reason as its top "why" line.
    const digest = buildUpcomingDigest(
      "Reason Model A",
      groupUpcoming(upcoming, td)
    );
    expect(digest).not.toBeNull();
    expect(digest!.highlights).toContainEqual({
      title: "Retest LDL Cholesterol",
      reason: RISK_TEXT,
    });
    // The one-computation invariant, stated directly: same string, three surfaces.
    expect(
      digest!.highlights.find((h) => h.title === "Retest LDL Cholesterol")!
        .reason
    ).toBe(primaryReason(retestInModel!.reasons)!.text);
  });

  it("a risk-elevated flagged biomarker gains a why-for-this-profile line on the hero (item 4)", () => {
    const pid = createProfile("Reason Model B");
    const td = today(pid);
    addFamilyHistory(pid, "Heart disease");
    // A FRESH flagged total cholesterol → a flag item in the hero's window,
    // risk-elevated (a lipid analyte under family-cardiovascular).
    addLab(pid, {
      name: "Total Cholesterol",
      canonical: "Total Cholesterol",
      value: "260",
      flag: "high",
      dateOffsetDays: 0,
    });

    const model = collectAttentionModel(pid, td);
    const flag = model.find((i) => i.domain === "biomarker-flag");
    expect(
      flag,
      "a fresh flagged lipid should produce a flag item"
    ).toBeDefined();
    // The why-line renders (detail extended), and the reasons carry the elevation.
    expect(flag!.detail).toContain(RISK_TEXT);
    expect(flag!.reasons).toEqual([
      { code: "biomarker-flagged", text: "High" },
      { code: "risk-elevated", text: RISK_TEXT, source: RISK_SOURCE },
    ]);
  });

  it("a situational dose is due WITH a 'due because <situation> is active' reason (item 5)", () => {
    const pid = createProfile("Reason Model C");
    const td = today(pid);
    // An active situation + a situational supplement gated on it.
    db.prepare(
      "INSERT INTO situations (profile_id, name, active) VALUES (?, 'Illness', 1)"
    ).run(pid);
    const item = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, situation)
           VALUES (?, 'Zinc', 1, 'supplement', 'situational', 'low', 'Illness')`
        )
        .run(pid).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '15 mg', 'morning', 'any', 0)`
    ).run(item);

    const dose = collectUpcoming(pid, td).find(
      (i) => i.domain === "dose" && i.title === "Zinc"
    );
    expect(
      dose,
      "a situational dose should be due while its situation is active"
    ).toBeDefined();
    expect(dose!.reasons).toEqual([
      { code: "situation-active", text: "Due because Illness is active" },
    ]);
    // The same reason can now reach the digest — one computation, not a page-only tag.
    expect(primaryReason(dose!.reasons)!.text).toBe(
      "Due because Illness is active"
    );
  });
});

// DB INTEGRATION TIER (issue #580): the closed loop — a food-group serving log feeds a
// food-habit frequency target's weekly progress, which links to a protocol as its
// intervention, whose before/during comparison reads the biomarker family as the
// declared outcome. Proves the pieces compose end-to-end against the real schema.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getFrequencyTargetProgress,
  getProtocol,
  getProtocolPractice,
  getProtocolAdherence,
  getProtocolUsage,
  getProtocolComparison,
} from "@/lib/queries";
import { setWeekMode } from "@/lib/settings";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

function logServing(profileId: number, group: string, date: string) {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
     ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
}

describe("food-habit → protocol loop (#580)", () => {
  it("servings feed target progress, and a protocol adopts the target with a biomarker outcome", () => {
    const { profileId, anchor } = makeProfile("food-loop");

    // A food-habit target: fatty fish 2×/week.
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'food_group', 'fatty_fish', 2)`
        )
        .run(profileId).lastInsertRowid
    );

    // Two fatty-fish servings this week (met), plus older during-window servings.
    logServing(profileId, "fatty_fish", anchor);
    logServing(profileId, "fatty_fish", shiftDateStr(anchor, -1));
    logServing(profileId, "fatty_fish", shiftDateStr(anchor, -20));

    // Progress reads the #579 rollup: 2 servings this week → met.
    const progress = getFrequencyTargetProgress(profileId).find(
      (p) => p.target.id === targetId
    );
    expect(progress).toBeTruthy();
    expect(progress!.count).toBe(2);
    expect(progress!.met).toBe(true);

    // A protocol adopts the target as its intervention + declares the omega-3 biomarker
    // as the outcome metric.
    const start = shiftDateStr(anchor, -30);
    const protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols
             (profile_id, name, start_date, end_date, notes, outcome_keys,
              frequency_target_id, owns_frequency_target)
           VALUES (?, 'Fatty fish 2x/week', ?, NULL, NULL, ?, ?, 1)`
        )
        .run(
          profileId,
          start,
          JSON.stringify(["biomarker:Omega-3 Total (OmegaCheck)"]),
          targetId
        ).lastInsertRowid
    );

    // Omega-3 readings before (low) and during (higher) the protocol window.
    const insReading = db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, value_num, unit, canonical_name)
       VALUES (?, ?, 'lab', 'Omega-3 Total (OmegaCheck)', ?, '% by wt', 'Omega-3 Total (OmegaCheck)')`
    );
    insReading.run(profileId, shiftDateStr(start, -10), 4.0); // baseline
    insReading.run(profileId, shiftDateStr(anchor, -2), 6.0); // during

    const protocol = getProtocol(profileId, protocolId)!;

    // The protocol's practice is the food-habit target (not gated to activity types).
    const practice = getProtocolPractice(profileId, protocol);
    expect(practice).toEqual({
      scopeKind: "food_group",
      value: "fatty_fish",
      perWeek: 2,
    });

    // Adherence is the SAME progress (one computation).
    const adherence = getProtocolAdherence(profileId, protocol);
    expect(adherence?.count).toBe(2);
    expect(adherence?.met).toBe(true);

    // Usage counts distinct fatty-fish days in [start, today] (3 logged days).
    const usage = getProtocolUsage(profileId, protocol, anchor);
    expect(usage.sessions).toBe(3);
    expect(usage.lastUsed).toBe(anchor);

    // The before/during comparison runs against the biomarker outcome unchanged.
    const comparison = getProtocolComparison(profileId, protocol, anchor, "kg");
    expect(comparison.outcomes.length).toBeGreaterThan(0);
    expect(comparison.outcomes[0].label).toContain("Omega-3");
  });

  it("getFrequencyTargetProgress carries the paced state (#748 item 3)", () => {
    const { profileId, anchor } = makeProfile("food-pace");
    // Rolling mode makes the week window a mature, deterministic 7 days regardless of
    // the calendar day the test runs, so a shortfall is unambiguously "behind".
    setWeekMode(profileId, "rolling");

    const met = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'food_group', 'fatty_fish', 2)`
        )
        .run(profileId).lastInsertRowid
    );
    const behind = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'food_group', 'berries', 3)`
        )
        .run(profileId).lastInsertRowid
    );

    // Two fatty-fish servings this week → met; berries untouched → behind (full week).
    logServing(profileId, "fatty_fish", anchor);
    logServing(profileId, "fatty_fish", shiftDateStr(anchor, -1));

    const rows = getFrequencyTargetProgress(profileId);
    const metRow = rows.find((p) => p.target.id === met)!;
    const behindRow = rows.find((p) => p.target.id === behind)!;
    expect(metRow.pace).toBe("met");
    expect(metRow.met).toBe(true);
    expect(behindRow.pace).toBe("behind");
    expect(behindRow.met).toBe(false);
  });

  it("the partial unique index forbids two food-habit targets for one group (#748 item 4)", () => {
    const { profileId } = makeProfile("food-unique");
    const insert = () =>
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'food_group', 'legumes', 2)`
        )
        .run(profileId);
    insert();
    // A second raw insert for the same (profile, food_group) violates migration 038's
    // partial unique index — the app path upserts instead of hitting this.
    expect(insert).toThrow(/UNIQUE/i);

    // The index is PARTIAL: training scopes (region/group/type) still admit duplicates.
    const insertRegion = () =>
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
           VALUES (?, 'region', 'chest', 2)`
        )
        .run(profileId);
    insertRegion();
    expect(insertRegion).not.toThrow();
  });
});

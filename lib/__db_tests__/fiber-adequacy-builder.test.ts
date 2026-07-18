// DB INTEGRATION TIER — the #448 end-to-end fixture for the fiber-adequacy coaching
// builder (issue #976). Seeds a realistic week: logged plant servings (the estimated
// floor) + a CONFIRMED psyllium dose (the supplemented basis) + a SKIPPED dose (must not
// count) + a capsule-unit fiber item (grams honestly unknown) → the combined below-target
// finding, floor-caveated. Also pins tier discipline (joins collectCoachingFindings,
// parses against RULE_FINDING_PREFIXES, never leaves the coaching tier).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  buildFiberAdequacyFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import { getFiberAdequacy } from "@/lib/queries";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { FIBER_ADEQUACY_PREFIX, fiberAdequacySignalKey } from "@/lib/fiber";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function setSex(profileId: number, sex: "male" | "female") {
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', ?)"
  ).run(profileId, sex);
}

function logFood(
  profileId: number,
  date: string,
  slug: string,
  servings: number
) {
  db.prepare(
    "INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)"
  ).run(profileId, date, slug, servings);
}

// Create an intake item + one dose, and confirm/skip it on `date` with a snapshot amount.
function seedDose(
  profileId: number,
  name: string,
  amount: string,
  date: string,
  status: "taken" | "skipped"
) {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority)
         VALUES (?, ?, 1, 'supplement', 'daily', 'low')`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, ?, 'morning', 'any', 0)`
      )
      .run(itemId, amount).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, taken_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    doseId,
    itemId,
    date,
    status === "taken" ? amount : null,
    `${date} 08:00:00`,
    status
  );
}

function seedTrackedFiber(profileId: number, date: string, grams: number) {
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health_connect', 'fiber_g', ?, ?, ?, ?)`
  ).run(profileId, date, `${date}T08:00:00Z`, `${date}T08:00:00Z`, grams);
}

describe("buildFiberAdequacyFindings (#976)", () => {
  it("sums the food floor + confirmed dose grams, ignores skipped, flags unknown units, surfaces a calm below finding", () => {
    const p = newProfile("fiber-below");
    setSex(p, "male"); // adult male DRI target = 38 g/day
    const anchor = today(p);

    // Estimated floor: legumes 2×8 + whole_grains 1×3 = 19 g on one logged day.
    logFood(p, anchor, "legumes", 2);
    logFood(p, anchor, "whole_grains", 1);
    // Supplemented: a CONFIRMED 5 g psyllium dose today.
    seedDose(p, "Psyllium Husk", "5 g", anchor, "taken");
    // A SKIPPED psyllium dose must NOT count (would otherwise inflate the total).
    seedDose(p, "Psyllium Husk PM", "5 g", anchor, "skipped");
    // A capsule-unit fiber item, CONFIRMED — grams honestly unknown (flag, not fabricated).
    seedDose(p, "Fiber capsules", "2 capsules", anchor, "taken");

    const a = getFiberAdequacy(p);
    expect(a).not.toBeNull();
    // 19 estimated + 5 supplemented = 24 g (skipped dose excluded), combined basis.
    expect(a?.intake.basis).toBe("combined");
    expect(Math.round(a!.intake.grams)).toBe(24);
    expect(a?.intake.unknownSupplement).toBe(true);
    expect(a?.status).toBe("below"); // 24 < 38

    const findings = buildFiberAdequacyFindings(p);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(fiberAdequacySignalKey());
    expect(f.dedupeKey.startsWith(FIBER_ADEQUACY_PREFIX)).toBe(true);
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(f.tone).toBe("info");
    expect(f.detail).toMatch(/floor/i);
    expect(f.detail).not.toMatch(/deficien/i);
    expect(f.actionHref).toBe("/nutrition");

    // Joins the unified coaching rollup (dismiss-once-silence-everywhere).
    const rolled = collectCoachingFindings(p, anchor, "kg").map(
      (x) => x.dedupeKey
    );
    expect(rolled).toContain(f.dedupeKey);
  });

  it("a tracked fiber_g reading OVERRIDES the estimated+supplemented sum", () => {
    const p = newProfile("fiber-tracked");
    setSex(p, "female"); // target 25
    const anchor = today(p);
    logFood(p, anchor, "legumes", 1); // would estimate 8
    seedDose(p, "Metamucil", "5 g", anchor, "taken");
    seedTrackedFiber(p, anchor, 30); // measured total wins

    const a = getFiberAdequacy(p);
    expect(a?.intake.basis).toBe("tracked");
    expect(Math.round(a!.intake.grams)).toBe(30);
    expect(a?.intake.estimatedGrams).toBe(0);
    expect(a?.intake.supplementedGrams).toBe(0);
    expect(a?.status).toBe("within"); // 30 ≥ 25, under the ceiling
    expect(buildFiberAdequacyFindings(p)).toEqual([]);
  });

  it("stays silent with no food, no supplements, and no tracked reading", () => {
    const p = newProfile("fiber-nodata");
    setSex(p, "male");
    expect(getFiberAdequacy(p)).toBeNull();
    expect(buildFiberAdequacyFindings(p)).toEqual([]);
  });

  it("a lone unknown-unit fiber dose surfaces the honest note (0 g)", () => {
    const p = newProfile("fiber-unknown-only");
    setSex(p, "male");
    const anchor = today(p);
    seedDose(p, "Fiber capsules", "1 capsule", anchor, "taken");

    const a = getFiberAdequacy(p);
    expect(a).not.toBeNull();
    expect(a?.intake.grams).toBe(0);
    expect(a?.intake.unknownSupplement).toBe(true);
    // The note renders instead of a fabricated figure.
    expect(a?.status).toBe("below");
  });
});

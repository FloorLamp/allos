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
import { getFiberAdequacy, getFiberOnDate } from "@/lib/queries";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { FIBER_ADEQUACY_PREFIX, fiberAdequacySignalKey } from "@/lib/fiber";
import { shiftDateStr } from "@/lib/date";

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
    "INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)"
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
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should')`
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
    `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, recorded_at, status)
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
    `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'health_connect', 'fiber_g', ?, ?, ?, ?)`
  ).run(profileId, date, `${date}T08:00:00Z`, `${date}T08:00:00Z`, grams);
}

describe("buildFiberAdequacyFindings (#976)", () => {
  it("reads only the selected historical day's food and confirmed fiber doses", () => {
    const p = newProfile("fiber-on-date");
    setSex(p, "male");
    const anchor = today(p);
    const yesterday = shiftDateStr(anchor, -1);
    logFood(p, yesterday, "legumes", 1); // 8 g
    seedDose(p, "Psyllium yesterday", "5 g", yesterday, "taken");
    logFood(p, anchor, "whole_grains", 3); // must not enter yesterday
    seedDose(p, "Psyllium today", "7 g", anchor, "taken");

    const day = getFiberOnDate(p, yesterday);
    expect(day?.intake.basis).toBe("combined");
    expect(Math.round(day!.intake.grams)).toBe(13);
    expect(day?.status).toBe("below");
  });

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

  // THE LARGER FLOOR, end to end (#4127). A tracked reading no longer overrides the
  // profile's own logging: the two floors are compared and the larger is shown, with both
  // named. The first profile is the discriminating one — its in-app ledger is the larger
  // side, so the retired override would report 20 g where this app holds 28, and would
  // turn a met target into a shortfall finding.
  it("shows the larger of the tracked reading and the in-app ledger, and reports both", () => {
    const bigger = newProfile("fiber-in-app-larger");
    setSex(bigger, "female"); // target 25, soft ceiling 40
    const anchor = today(bigger);
    logFood(bigger, anchor, "legumes", 2); // 16 g estimated
    seedDose(bigger, "Metamucil", "12 g", anchor, "taken"); // + 12 g = 28 in-app
    seedTrackedFiber(bigger, anchor, 20); // the health app has sent less so far

    const a = getFiberAdequacy(bigger);
    expect(a?.intake.basis).toBe("both-sources");
    expect(Math.round(a!.intake.grams)).toBe(28);
    expect(a?.intake.estimatedGrams).toBe(16);
    expect(a?.intake.supplementedGrams).toBe(12);
    expect(a?.status).toBe("within"); // 28 ≥ 25 — the override read this day as below
    expect(buildFiberAdequacyFindings(bigger)).toEqual([]);
    // The single-date gather agrees with the week's — one question, one computation.
    const day = getFiberOnDate(bigger, anchor);
    expect(day?.intake.basis).toBe("both-sources");
    expect(Math.round(day!.intake.grams)).toBe(28);

    // The other direction: the health app's reading is the larger floor, and the in-app
    // ledger is still reported beneath it rather than zeroed.
    const tracked = newProfile("fiber-tracked-larger");
    setSex(tracked, "female");
    const trackedAnchor = today(tracked);
    logFood(tracked, trackedAnchor, "legumes", 1); // 8 g
    seedDose(tracked, "Metamucil", "5 g", trackedAnchor, "taken"); // 13 g in-app
    seedTrackedFiber(tracked, trackedAnchor, 30);

    const b = getFiberAdequacy(tracked);
    expect(b?.intake.basis).toBe("both-sources");
    expect(Math.round(b!.intake.grams)).toBe(30);
    expect(b?.intake.estimatedGrams).toBe(8);
    expect(b?.intake.supplementedGrams).toBe(5);
    expect(b?.status).toBe("within");
    expect(buildFiberAdequacyFindings(tracked)).toEqual([]);
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

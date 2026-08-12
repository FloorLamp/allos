// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// #1490's subject-context BUILDER, under the #448 discipline: the pure ranker
// (lib/__tests__/trends-card-rank.test.ts) takes a pre-gathered context, so it
// structurally cannot see a builder that reads the wrong store, the wrong status,
// or the wrong window. Every confirmed defect in the #45 engines lived exactly
// there — so each of the issue's scenarios gets a realistic seeded fixture here and
// asserts the END-TO-END card order, not just the intermediate facts.
//
// The scenarios (from the issue): peds → growth first; weight-goal → weight first;
// no-HRV-data → HRV sinks; no signals → today's layout EXACTLY.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setProfileBirthdate, setProfileSex } from "@/lib/settings";
import { buildTrendsSubjectContext, getBodyCardPins } from "@/lib/queries";
import { saveItem, setSavedOrder } from "@/lib/queries/saved";
import { upsertMoodLog } from "@/lib/offline/writes";
import {
  BODY_CARD_LAYOUT,
  bodyCardOrder,
  rankBodyCards,
  type BodyCardId,
} from "@/lib/trends-card-rank";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

// N consecutive daily samples ending `endOffset` days before today.
function seedSamples(
  profileId: number,
  metric: string,
  anchor: string,
  count: number,
  endOffset = 0
): void {
  const stmt = db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'test-device', ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < count; i++) {
    const d = shiftDateStr(anchor, -(endOffset + i));
    stmt.run(profileId, metric, d, `${d}T00:00:00`, `${d}T00:01:00`, 10 + i);
  }
}

function seedWeights(
  profileId: number,
  anchor: string,
  count: number,
  endOffset = 0
): void {
  const stmt = db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, ?, 'manual')`
  );
  for (let i = 0; i < count; i++) {
    stmt.run(profileId, shiftDateStr(anchor, -(endOffset + i)), 70 + i * 0.1);
  }
}

function seedVital(
  profileId: number,
  anchor: string,
  name: string,
  count: number
): void {
  const stmt = db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name, canonical_name, value, value_num, unit)
     VALUES (?, ?, 'vitals', ?, ?, ?, ?, 'mmHg')`
  );
  for (let i = 0; i < count; i++) {
    const d = shiftDateStr(anchor, -i);
    stmt.run(profileId, d, name, name, String(120 + i), 120 + i);
  }
}

const at = (order: readonly BodyCardId[], id: BodyCardId) => order.indexOf(id);

describe("buildTrendsSubjectContext — no signals (the identity case)", () => {
  it("gives a profile with no facts and no data TODAY'S LAYOUT EXACTLY", () => {
    // A bare profile: no age, no goals, no conditions, no series at all. Every
    // presence is "none", so the data floor holds for nobody and the base layout is
    // the whole answer — the regression guard that a ranked default never becomes a
    // reshuffle for a profile the app knows nothing about.
    const { profileId, anchor } = makeProfile("rank-identity");
    const ctx = buildTrendsSubjectContext(profileId, anchor);
    expect(ctx.growthTracked).toBe(false);
    expect(ctx.goalMetrics).toEqual([]);
    expect(ctx.monitors).toEqual([]);
    expect(rankBodyCards(ctx)).toEqual([...BODY_CARD_LAYOUT]);
  });

  it("gives EVERY layout card a presence entry", () => {
    // Structural guard: a card the builder forgets to measure defaults to the
    // neutral bucket, which under the data-present floor would float it above a
    // genuinely empty card — turning "nothing tracked yet" into a reshuffle. The
    // identity test above only catches it while `sun` is the forgotten one.
    const { profileId, anchor } = makeProfile("rank-presence-coverage");
    const ctx = buildTrendsSubjectContext(profileId, anchor);
    for (const id of BODY_CARD_LAYOUT) {
      expect(ctx.presence[id], `presence missing for ${id}`).toBeDefined();
    }
  });

  it("keeps today's layout for an adult whose data is uniformly present", () => {
    // The other half of the identity case: an ordinary adult with a typical, evenly
    // tracked set. Presence is the same bucket everywhere, so no signal separates
    // the cards and the static layout survives.
    const { profileId, anchor } = makeProfile("rank-identity-adult");
    setProfileBirthdate(profileId, "1985-04-02");
    seedWeights(profileId, anchor, 10);
    seedSamples(profileId, "steps", anchor, 10);
    seedVital(profileId, anchor, "Blood Pressure Systolic", 10);

    const ctx = buildTrendsSubjectContext(profileId, anchor);
    const order = rankBodyCards(ctx);
    // Relative order among the tracked cards is untouched by presence alone — it is
    // the base layout's, which since #1659 is everyday-first: composition, then the
    // daily activity block, then the clinical vitals a signal would have to lift.
    expect(at(order, "weight")).toBeLessThan(at(order, "steps"));
    expect(at(order, "steps")).toBeLessThan(at(order, "systolic"));
  });
});

describe("buildTrendsSubjectContext — pediatric", () => {
  it("leads with growth for a child, height ahead of weight", () => {
    const { profileId, anchor } = makeProfile("rank-peds");
    setProfileSex(profileId, "female");
    setProfileBirthdate(profileId, shiftDateStr(anchor, -365 * 6)); // ~6 years old
    seedSamples(profileId, "height_cm", anchor, 6);
    seedWeights(profileId, anchor, 6);

    const ctx = buildTrendsSubjectContext(profileId, anchor);
    expect(ctx.growthTracked).toBe(true);
    // Growth presence is derived from the height series.
    expect(ctx.presence.growth).toBe("rich");

    const order = rankBodyCards(ctx);
    expect(order[0]).toBe("growth");
    expect(at(order, "height")).toBeLessThan(at(order, "weight"));
  });

  it("does not treat an adult as growth-tracked", () => {
    const { profileId, anchor } = makeProfile("rank-adult-age");
    setProfileBirthdate(profileId, shiftDateStr(anchor, -365 * 42));
    const ctx = buildTrendsSubjectContext(profileId, anchor);
    expect(ctx.growthTracked).toBe(false);
    expect(rankBodyCards(ctx)[0]).not.toBe("growth");
  });
});

describe("buildTrendsSubjectContext — live goals", () => {
  it("leads with weight for an adult carrying a live weight goal", () => {
    const { profileId, anchor } = makeProfile("rank-weight-goal");
    setProfileBirthdate(profileId, "1990-01-01");
    seedWeights(profileId, anchor, 8);
    db.prepare(
      `INSERT INTO goals (profile_id, title, status, body_metric, target_value, archived)
       VALUES (?, 'Reach 68 kg', 'active', 'weight', 68, 0)`
    ).run(profileId);

    const ctx = buildTrendsSubjectContext(profileId, anchor);
    expect(ctx.goalMetrics).toEqual(["weight"]);
    expect(rankBodyCards(ctx)[0]).toBe("weight");
  });

  it("ignores an archived or targetless goal (the same liveness the overlay uses)", () => {
    const { profileId, anchor } = makeProfile("rank-dead-goal");
    db.prepare(
      `INSERT INTO goals (profile_id, title, status, body_metric, target_value, archived)
       VALUES (?, 'Old goal', 'active', 'weight', 68, 1)`
    ).run(profileId);
    db.prepare(
      `INSERT INTO goals (profile_id, title, status, body_metric, target_value, archived)
       VALUES (?, 'Vague goal', 'active', 'body_fat', NULL, 0)`
    ).run(profileId);
    expect(buildTrendsSubjectContext(profileId, anchor).goalMetrics).toEqual(
      []
    );
  });
});

describe("buildTrendsSubjectContext — monitored conditions", () => {
  it("leads with blood pressure for an active hypertension diagnosis", () => {
    const { profileId, anchor } = makeProfile("rank-htn");
    db.prepare(
      `INSERT INTO conditions (profile_id, name, code, code_system, status)
       VALUES (?, 'Essential hypertension', 'I10', 'ICD-10', 'active')`
    ).run(profileId);
    seedVital(profileId, anchor, "Blood Pressure Systolic", 6);
    seedVital(profileId, anchor, "Blood Pressure Diastolic", 6);

    const ctx = buildTrendsSubjectContext(profileId, anchor);
    expect(ctx.monitors).toEqual(["blood-pressure"]);
    expect(rankBodyCards(ctx).slice(0, 2)).toEqual(["systolic", "diastolic"]);
  });

  it("ignores a RESOLVED condition", () => {
    const { profileId, anchor } = makeProfile("rank-htn-resolved");
    db.prepare(
      `INSERT INTO conditions (profile_id, name, code, code_system, status)
       VALUES (?, 'Essential hypertension', 'I10', 'ICD-10', 'resolved')`
    ).run(profileId);
    expect(buildTrendsSubjectContext(profileId, anchor).monitors).toEqual([]);
  });

  it("never crosses profiles", () => {
    const a = makeProfile("rank-scope-a");
    const b = makeProfile("rank-scope-b");
    db.prepare(
      `INSERT INTO conditions (profile_id, name, code, code_system, status)
       VALUES (?, 'Essential hypertension', 'I10', 'ICD-10', 'active')`
    ).run(a.profileId);
    seedWeights(a.profileId, a.anchor, 8);
    const ctxB = buildTrendsSubjectContext(b.profileId, b.anchor);
    expect(ctxB.monitors).toEqual([]);
    expect(ctxB.presence.weight).toBe("none");
  });
});

describe("buildTrendsSubjectContext — data presence", () => {
  it("sinks a never-measured card below every card with data (no-HRV-data)", () => {
    const { profileId, anchor } = makeProfile("rank-no-hrv");
    seedSamples(profileId, "steps", anchor, 20);
    seedWeights(profileId, anchor, 20);

    const ctx = buildTrendsSubjectContext(profileId, anchor);
    expect(ctx.presence.hrv).toBe("none");
    expect(ctx.presence.steps).toBe("rich");

    const order = rankBodyCards(ctx);
    expect(at(order, "hrv")).toBeGreaterThan(at(order, "steps"));
    expect(at(order, "hrv")).toBeGreaterThan(at(order, "weight"));
  });

  it("floats a richly-tracked series above a neutral one higher in the static layout", () => {
    // No athlete classifier: this profile's HRV simply has data and its blood
    // pressure does not.
    const { profileId, anchor } = makeProfile("rank-hrv-rich");
    seedSamples(profileId, "hrv_ms", anchor, 30);
    const ctx = buildTrendsSubjectContext(profileId, anchor);
    expect(ctx.presence.hrv).toBe("rich");
    expect(at(rankBodyCards(ctx), "hrv")).toBe(0);
  });

  it("treats a stale series as sparse, not rich", () => {
    const { profileId, anchor } = makeProfile("rank-stale");
    seedSamples(profileId, "steps", anchor, 30, 200); // ended ~200 days ago
    expect(buildTrendsSubjectContext(profileId, anchor).presence.steps).toBe(
      "sparse"
    );
  });

  it("derives BMI presence from its thinnest input", () => {
    const { profileId, anchor } = makeProfile("rank-bmi-derived");
    seedWeights(profileId, anchor, 20); // weight rich, height absent
    const ctx = buildTrendsSubjectContext(profileId, anchor);
    expect(ctx.presence.weight).toBe("rich");
    expect(ctx.presence.bmi).toBe("none");
  });

  it("measures each check-in rating on the days that carry IT (#1408)", () => {
    // The three ratings share one row, so counting the mood rows for all of them
    // would rank two mostly-empty cards as rich: a daily one-tap user who answered
    // energy twice and never opened Calm would get an energy card ranked as though
    // it were tracked daily, and a Calm card ranked above metrics they do track.
    const { profileId, anchor } = makeProfile("rank-checkin-ratings");
    for (let i = 0; i < 20; i++) {
      upsertMoodLog(profileId, shiftDateStr(anchor, -i), {
        valence: 4,
        energy: i < 2 ? 3 : null,
      });
    }
    const ctx = buildTrendsSubjectContext(profileId, anchor);
    expect(ctx.presence.mood).toBe("rich");
    expect(ctx.presence.energy).toBe("sparse");
    expect(ctx.presence.calm).toBe("none");
  });
});

// ── The ★ substrate drives the Body order (#1643) ───────────────────────────
//
// The pure tier owns the COMPOSITION (pinned first, ranked remainder); what only a
// database can show is that the pins really are the profile's saved order — the same
// rows the Overview grid's ★ writes and its drag re-sequences — resolved through the
// one series-key ↔ card-id mapping. `makeProfile` inserts a bare profile row, so
// nothing is starred until a test says so.
describe("getBodyCardPins — the body census ★ arrangement", () => {
  const star = (profileId: number, key: string): void => {
    saveItem(profileId, "trend-metric", key);
  };

  it("is empty for a profile that has starred nothing", () => {
    const { profileId } = makeProfile("pins-none");
    expect(getBodyCardPins(profileId)).toEqual([]);
  });

  it("reads the saved store in SAVED order, newest star first", () => {
    const { profileId } = makeProfile("pins-saved-order");
    star(profileId, "weight");
    star(profileId, "steps");
    // Unpositioned rows order newest-first, so the latest ★ leads.
    expect(getBodyCardPins(profileId)).toEqual(["steps", "weight"]);
  });

  it("follows setSavedOrder — the write behind the Overview drag", () => {
    const { profileId } = makeProfile("pins-reordered");
    star(profileId, "weight");
    star(profileId, "steps");
    star(profileId, "mood");
    setSavedOrder(profileId, [
      { kind: "trend-metric", key: "weight" },
      { kind: "trend-metric", key: "mood" },
      { kind: "trend-metric", key: "steps" },
    ]);
    expect(getBodyCardPins(profileId)).toEqual(["weight", "mood", "steps"]);
  });

  it("resolves the stored legacy saved ids onto their card ids", () => {
    const { profileId } = makeProfile("pins-legacy-ids");
    star(profileId, "bodyfat");
    star(profileId, "resting_hr");
    expect(new Set(getBodyCardPins(profileId))).toEqual(
      new Set(["body-fat", "resting-hr"])
    );
  });

  it("skips saved refs that name no Body card", () => {
    const { profileId } = makeProfile("pins-non-body");
    star(profileId, "volume"); // training volume — a saved metric, not a Body card
    saveItem(profileId, "biomarker", "ApoB");
    star(profileId, "steps");
    expect(getBodyCardPins(profileId)).toEqual(["steps"]);
  });

  it("leads the tab with the pins, and ranks the remainder behind them", () => {
    const { profileId, anchor } = makeProfile("pins-end-to-end");
    seedWeights(profileId, anchor, 20);
    seedSamples(profileId, "steps", anchor, 20);
    seedVital(profileId, anchor, "Blood Pressure Systolic", 20);
    const ctx = buildTrendsSubjectContext(profileId, anchor);

    // Nothing pinned: the everyday-first ranked default (#1659).
    const unpinned = bodyCardOrder(ctx, getBodyCardPins(profileId));
    expect(at(unpinned, "weight")).toBeLessThan(at(unpinned, "systolic"));
    expect(at(unpinned, "steps")).toBeLessThan(at(unpinned, "systolic"));

    // Star the BP card and it leads — user intent over the neutral ranking.
    star(profileId, "systolic");
    const pinned = bodyCardOrder(ctx, getBodyCardPins(profileId));
    expect(pinned[0]).toBe("systolic");
    expect(pinned.slice(1)).toEqual(unpinned.filter((id) => id !== "systolic"));
  });

  it("keeps a growth-tracked profile's structural lead above its pins", () => {
    // MEMBERSHIP beats ★ (#1643): the pediatric lead is the membership-tier fork
    // #1490 moved into the signal table, so starring weight does not displace it.
    const { profileId, anchor } = makeProfile("pins-peds");
    setProfileSex(profileId, "male");
    setProfileBirthdate(profileId, shiftDateStr(anchor, -365 * 7));
    seedSamples(profileId, "height_cm", anchor, 6);
    star(profileId, "weight");

    const ctx = buildTrendsSubjectContext(profileId, anchor);
    const order = bodyCardOrder(ctx, getBodyCardPins(profileId));
    expect(order[0]).toBe("growth");
    expect(at(order, "height")).toBeLessThan(at(order, "weight"));
  });
});

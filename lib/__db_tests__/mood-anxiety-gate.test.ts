// DB INTEGRATION TIER — the check-in Calm-scale relevance resolver (issue #1313).
// The pure OR matrix is unit-tested in lib/__tests__/mood-anxiety-gate.test.ts; this
// tier exercises the query-layer GATHER (isAnxietyScaleRelevant) against seeded
// fixtures, one per signal, since the pure tier structurally can't see the DB reads
// (#448's input-layer lesson). Each signal in isolation must flip the gate on, and a
// profile with none stays hidden.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { isAnxietyScaleRelevant } from "@/lib/queries";
import { setAnxietyScaleOptIn } from "@/lib/settings";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("isAnxietyScaleRelevant (the #1313 gate resolver)", () => {
  beforeAll(() => {
    // Import triggers migrate(); nothing else to set up.
  });

  it("hides for a profile with no signal", () => {
    const p = newProfile("Blank (gate)");
    expect(isAnxietyScaleRelevant(p)).toBe(false);
  });

  it("signal 1 — a prior mood_logs anxiety reading reveals it (continuity)", () => {
    const p = newProfile("Prior Anxiety (gate)");
    db.prepare(
      `INSERT INTO mood_logs (profile_id, date, valence, anxiety) VALUES (?, '2026-07-01', 3, 4)`
    ).run(p);
    expect(isAnxietyScaleRelevant(p)).toBe(true);
  });

  it("signal 2 — a GAD-7 medical_records row reveals it", () => {
    const p = newProfile("GAD7 (gate)");
    db.prepare(
      `INSERT INTO medical_records (date, category, name, value_num, canonical_name, profile_id)
       VALUES ('2026-06-01', 'instrument', 'GAD-7', 8, 'GAD-7', ?)`
    ).run(p);
    expect(isAnxietyScaleRelevant(p)).toBe(true);
  });

  it("signal 3 — an active anxiety condition reveals it (curated keyword)", () => {
    const p = newProfile("Cond (gate)");
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status) VALUES (?, 'Generalized anxiety disorder', 'active')`
    ).run(p);
    expect(isAnxietyScaleRelevant(p)).toBe(true);
  });

  it("signal 3 — an active NON-anxiety condition alone does not reveal it", () => {
    const p = newProfile("Cond Neg (gate)");
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status) VALUES (?, 'Hypertension', 'active')`
    ).run(p);
    expect(isAnxietyScaleRelevant(p)).toBe(false);
  });

  it("signal 4 — an active med with a curated anxiolytic RxCUI reveals it", () => {
    const p = newProfile("Med (gate)");
    // sertraline ingredient RxCUI; active medication.
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, kind, active, rxcui) VALUES (?, 'Zoloft', 'medication', 1, '36437')`
    ).run(p);
    expect(isAnxietyScaleRelevant(p)).toBe(true);
  });

  it("signal 5 — an ongoing protocol whose outcome is the anxiety series reveals it", () => {
    const p = newProfile("Protocol (gate)");
    db.prepare(
      `INSERT INTO protocols (profile_id, name, start_date, end_date, outcome_keys)
       VALUES (?, 'Daily meditation', '2026-06-01', NULL, ?)`
    ).run(p, JSON.stringify(["biomarker:GAD-7"]));
    expect(isAnxietyScaleRelevant(p)).toBe(true);
  });

  it("signal 5 — an ENDED protocol targeting anxiety does not reveal it", () => {
    const p = newProfile("Protocol Ended (gate)");
    db.prepare(
      `INSERT INTO protocols (profile_id, name, start_date, end_date, outcome_keys)
       VALUES (?, 'Old meditation', '2026-01-01', '2026-03-01', ?)`
    ).run(p, JSON.stringify(["biomarker:GAD-7"]));
    expect(isAnxietyScaleRelevant(p)).toBe(false);
  });

  it("signal 6 — the explicit opt-in reveals it", () => {
    const p = newProfile("OptIn (gate)");
    expect(isAnxietyScaleRelevant(p)).toBe(false);
    setAnxietyScaleOptIn(p, true);
    expect(isAnxietyScaleRelevant(p)).toBe(true);
  });

  it("is profile-scoped — one profile's signal never reveals another's scale", () => {
    const withSignal = newProfile("Has (scope)");
    const without = newProfile("Without (scope)");
    db.prepare(
      `INSERT INTO mood_logs (profile_id, date, valence, anxiety) VALUES (?, '2026-07-02', 3, 2)`
    ).run(withSignal);
    expect(isAnxietyScaleRelevant(withSignal)).toBe(true);
    expect(isAnxietyScaleRelevant(without)).toBe(false);
  });
});

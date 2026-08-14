// DB INTEGRATION TIER. Applies every SEED_PERSONA character
// (scripts/seed-personas.ts) against a real migrated schema. The persona
// module is ~1k lines of hand-written INSERTs mirroring scripts/seed.ts's
// column lists; nothing but a live handle can catch a drifted column, a
// broken foreign key, or a helper whose signature moved. Each persona seeds
// its own throwaway profile (apply() is profileId-parameterized), so the
// per-persona datasets can't mask each other's failures.
//
// The ctx wiring below mirrors scripts/seed.ts's persona branch exactly — if
// the two drift, this tier is where it shows.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { utcInstant } from "@/lib/date";
import { zonedWallTimeToUtc } from "@/lib/calendar-ics";
import { reconcileFlags } from "@/lib/queries";
import { saveFitnessEntry } from "@/lib/fitness-assessment";
import { getTimezone } from "@/lib/settings";
import { seedStandardMetricSaves } from "@/lib/standard-metric-seeds";
import { episodesForSituation } from "@/lib/symptom-episode";
import {
  diffSituations,
  serializeSituationEvents,
} from "@/lib/trend-annotations";
import {
  completeOnboardingState,
  initialOnboardingState,
  normalizeOnboardingFocuses,
  serializeOnboardingState,
} from "@/lib/onboarding";
import { shiftDateStr } from "@/lib/date";
import { PERSONAS } from "../../scripts/seed-personas";
import type { PersonaContext } from "../../scripts/seed-personas";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function ctxFor(profileId: number): PersonaContext {
  const daysAgo = (n: number) => shiftDateStr(today(profileId), -n);
  return {
    db,
    profileId,
    daysAgo,
    shiftDateStr,
    occurredAt: (day, hhmm) => {
      const [y, m, d] = day.split("-").map(Number);
      const [h, min] = hhmm.split(":").map(Number);
      return utcInstant(
        zonedWallTimeToUtc(y, m, d, h, min, getTimezone(profileId))
      );
    },
    reconcileFlags,
    saveFitnessEntry,
    seedStandardMetricSaves: (pid) => seedStandardMetricSaves(db, pid),
    diffSituations,
    serializeSituationEvents,
    episodesForSituation,
    onboardingStateJson: (profilePath, focuses) =>
      serializeOnboardingState(
        completeOnboardingState(
          {
            ...initialOnboardingState(),
            profilePath,
            focuses: normalizeOnboardingFocuses(focuses),
            basicsComplete: true,
            layoutReviewed: true,
            notificationIntent: "later",
            notificationsReviewed: true,
            checklistDismissed: true,
          },
          new Date().toISOString()
        )
      ),
  };
}

const setting = (profileId: number, key: string): string | undefined =>
  (
    db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?"
      )
      .get(profileId, key) as { value: string } | undefined
  )?.value;

const count = (profileId: number, table: string): number =>
  (
    db
      .prepare(`SELECT COUNT(*) c FROM ${table} WHERE profile_id = ?`)
      .get(profileId) as { c: number }
  ).c;

// Applied once (in beforeAll — the shared db project rebinds the singleton
// after module import, so module-scope writes would be wiped), shared by the
// per-persona invariants and the spot checks.
const seeded = new Map<string, number>();

describe("persona seeds against a live schema", () => {
  beforeAll(() => {
    for (const persona of PERSONAS) {
      const profileId = newProfile(`persona:${persona.name}`);
      persona.apply(ctxFor(profileId));
      seeded.set(persona.name, profileId);
    }
  });

  for (const persona of PERSONAS) {
    it(`${persona.name}: attributes, onboarding, and records land`, () => {
      const profileId = seeded.get(persona.name)!;
      expect(setting(profileId, "birthdate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["male", "female"]).toContain(setting(profileId, "sex"));
      const onboarding = JSON.parse(setting(profileId, "onboarding_state")!);
      expect(onboarding.status).toBe("complete");
      expect(count(profileId, "medical_records")).toBeGreaterThan(0);
      // A foreign-key mistake anywhere in the persona's inserts shows up here.
      const fkErrors = db.pragma("foreign_key_check") as unknown[];
      expect(fkErrors).toEqual([]);
    });
  }

  // Household members are created by the persona itself; look them up by the
  // profile name each addFamilyProfile call writes.
  const memberId = (name: string): number =>
    (
      db.prepare(`SELECT id FROM profiles WHERE name = ?`).get(name) as {
        id: number;
      }
    ).id;

  it("household: Dave's rising LDL flags against the canonical range", () => {
    const profileId = seeded.get("household")!;
    const ldl = db
      .prepare(
        `SELECT flag FROM medical_records
         WHERE profile_id = ? AND canonical_name = 'LDL Cholesterol'
         ORDER BY date DESC LIMIT 1`
      )
      .get(profileId) as { flag: string | null };
    expect(ldl.flag).toBe("high");
  });

  it("household: both twins exist with growth series and ACTIVE illness episodes", () => {
    for (const twin of ["Riley", "Rowan"]) {
      const id = memberId(twin);
      const heights = (
        db
          .prepare(
            `SELECT COUNT(*) c FROM metric_samples WHERE profile_id = ? AND metric = 'height_cm'`
          )
          .get(id) as { c: number }
      ).c;
      expect(heights, twin).toBeGreaterThanOrEqual(6);
      expect(count(id, "intake_items"), twin).toBe(0);
      expect(count(id, "immunizations"), twin).toBeGreaterThanOrEqual(15);
      const openEpisode = db
        .prepare(
          `SELECT COUNT(*) c FROM illness_episodes WHERE profile_id = ? AND end_date IS NULL`
        )
        .get(id) as { c: number };
      expect(openEpisode.c, twin).toBe(1);
      const symptoms = count(id, "symptom_logs");
      expect(symptoms, twin).toBeGreaterThanOrEqual(4);
    }
    // Riley's fever curve flagged like an import would flag it.
    const fever = db
      .prepare(
        `SELECT COUNT(*) c FROM medical_records
         WHERE profile_id = ? AND canonical_name = 'Body Temperature' AND flag = 'high'`
      )
      .get(memberId("Riley")) as { c: number };
    expect(fever.c).toBeGreaterThanOrEqual(1);
  });

  it("household: Margaret has the six-med stack including the warfarin+NSAID pair", () => {
    const id = memberId("Margaret");
    const meds = db
      .prepare(
        `SELECT name, rx FROM intake_items
         WHERE profile_id = ? AND kind = 'medication' AND active = 1`
      )
      .all(id) as { name: string; rx: number }[];
    expect(meds.length).toBe(6);
    const byName = new Map(meds.map((m) => [m.name, m]));
    expect(byName.has("Warfarin")).toBe(true);
    expect(byName.has("Ibuprofen")).toBe(true);
    // Prescriber-bearing meds are Rx (the RxOtcBadge reads intake_items.rx);
    // the self-directed OTC NSAID stays 0.
    expect(byName.get("Warfarin")!.rx).toBe(1);
    expect(byName.get("Ibuprofen")!.rx).toBe(0);
  });

  it("marathon-runner: two connected sources and the cross-source duplicate run", () => {
    const profileId = seeded.get("marathon-runner")!;
    const connections = db
      .prepare(
        `SELECT provider FROM integration_connections
         WHERE profile_id = ? AND status = 'connected' ORDER BY provider`
      )
      .all(profileId) as { provider: string }[];
    expect(connections.map((c) => c.provider)).toEqual([
      "health-connect",
      "strava",
    ]);
    // The long run arrived from BOTH providers: same day, two sources.
    const dupe = db
      .prepare(
        `SELECT COUNT(DISTINCT source) c FROM activities
         WHERE profile_id = ? AND distance_km = 29.0 AND source IS NOT NULL`
      )
      .get(profileId) as { c: number };
    expect(dupe.c).toBe(2);
  });

  it("diabetic-cgm: documents on both partners and Priya's asthma picture", () => {
    const ray = seeded.get("diabetic-cgm")!;
    const priya = memberId("Priya");
    expect(count(ray, "medical_documents")).toBe(1);
    expect(count(priya, "medical_documents")).toBe(1);
    // Ray's latest lab draw was re-pointed at his document.
    const linked = db
      .prepare(
        `SELECT COUNT(*) c FROM medical_records
         WHERE profile_id = ? AND document_id IS NOT NULL AND source = 'extracted'`
      )
      .get(ray) as { c: number };
    expect(linked.c).toBeGreaterThanOrEqual(4);
    const asthma = db
      .prepare(
        `SELECT COUNT(*) c FROM conditions WHERE profile_id = ? AND code = 'J45.40'`
      )
      .get(priya) as { c: number };
    expect(asthma.c).toBe(1);
    const peakFlow = db
      .prepare(
        `SELECT COUNT(*) c FROM metric_samples
         WHERE profile_id = ? AND metric = 'peak_flow_lmin'`
      )
      .get(priya) as { c: number };
    expect(peakFlow.c).toBe(42); // 21 days × 2 blows
  });

  it("pregnant: PHQ-9 with answers, ultrasounds, variants, and 15-year-old Maya", () => {
    const sofia = seeded.get("pregnant")!;
    const phq = db
      .prepare(
        `SELECT id, value_num FROM medical_records
         WHERE profile_id = ? AND category = 'instrument' AND canonical_name = 'PHQ-9'`
      )
      .get(sofia) as { id: number; value_num: number };
    expect(phq.value_num).toBe(7);
    const answers = db
      .prepare(
        `SELECT COUNT(*) c FROM instrument_responses WHERE medical_record_id = ?`
      )
      .get(phq.id) as { c: number };
    expect(answers.c).toBe(9);
    expect(count(sofia, "imaging_studies")).toBe(2);
    expect(count(sofia, "genomic_variants")).toBe(2);
    const maya = memberId("Maya");
    expect(setting(maya, "birthdate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(count(maya, "immunizations")).toBeGreaterThanOrEqual(5);
    expect(count(maya, "activities")).toBe(3);
  });

  it("biohacker: Oura nights with stages + Withings weigh-ins beside the manual log", () => {
    const profileId = seeded.get("biohacker")!;
    const providers = db
      .prepare(
        `SELECT provider FROM integration_connections
         WHERE profile_id = ? AND status = 'connected' ORDER BY provider`
      )
      .all(profileId) as { provider: string }[];
    expect(providers.map((p) => p.provider)).toEqual(["oura", "withings"]);
    const deep = db
      .prepare(
        `SELECT COUNT(*) c FROM metric_samples
         WHERE profile_id = ? AND source = 'oura' AND metric = 'sleep_deep_min'`
      )
      .get(profileId) as { c: number };
    expect(deep.c).toBe(30);
    // oura resting-HR + withings weigh-ins + the fitness-check 'manual' rows,
    // beside the weekly hand log (source NULL).
    const sources = db
      .prepare(
        `SELECT DISTINCT source FROM body_metrics WHERE profile_id = ? AND source IS NOT NULL ORDER BY source`
      )
      .all(profileId) as { source: string }[];
    expect(sources.map((s) => s.source)).toContain("oura");
    expect(sources.map((s) => s.source)).toContain("withings");
    const manualRows = db
      .prepare(
        `SELECT COUNT(*) c FROM body_metrics WHERE profile_id = ? AND source IS NULL AND weight_kg IS NOT NULL`
      )
      .get(profileId) as { c: number };
    expect(manualRows.c).toBeGreaterThanOrEqual(8);
  });

  it("pregnant: declares the risk attribute and stops cycles at the LMP", () => {
    const profileId = seeded.get("pregnant")!;
    expect(setting(profileId, "risk_pregnant")).toBe("1");
    const latest = db
      .prepare(`SELECT MAX(period_start) s FROM cycles WHERE profile_id = ?`)
      .get(profileId) as { s: string };
    // The LMP is ~140 days back — nothing since.
    expect(latest.s < shiftDateStr(today(profileId), -100)).toBe(true);
  });

  it("diabetic-cgm: a dense timed glucose series", () => {
    const profileId = seeded.get("diabetic-cgm")!;
    const glucose = db
      .prepare(
        `SELECT COUNT(*) c FROM medical_records
         WHERE profile_id = ? AND canonical_name = 'Glucose' AND occurred_at IS NOT NULL`
      )
      .get(profileId) as { c: number };
    expect(glucose.c).toBe(56); // 14 days × 4 timed readings
  });

  it("biohacker: a 20-item supplement stack and three practices", () => {
    const profileId = seeded.get("biohacker")!;
    const supplements = db
      .prepare(
        `SELECT COUNT(*) c FROM intake_items
         WHERE profile_id = ? AND (kind IS NULL OR kind != 'medication')`
      )
      .get(profileId) as { c: number };
    expect(supplements.c).toBeGreaterThanOrEqual(20);
    const practices = db
      .prepare(
        `SELECT COUNT(DISTINCT practice) c FROM practice_logs WHERE profile_id = ?`
      )
      .get(profileId) as { c: number };
    expect(practices.c).toBe(3);
  });
});

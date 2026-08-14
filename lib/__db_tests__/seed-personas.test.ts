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
    occurredAt: (day, hhmm) => {
      const [y, m, d] = day.split("-").map(Number);
      const [h, min] = hhmm.split(":").map(Number);
      return utcInstant(
        zonedWallTimeToUtc(y, m, d, h, min, getTimezone(profileId))
      );
    },
    reconcileFlags,
    saveFitnessEntry,
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

  it("midlife-ldl: the rising LDL flags against the canonical range", () => {
    const profileId = seeded.get("midlife-ldl")!;
    const ldl = db
      .prepare(
        `SELECT flag FROM medical_records
         WHERE profile_id = ? AND canonical_name = 'LDL Cholesterol'
         ORDER BY date DESC LIMIT 1`
      )
      .get(profileId) as { flag: string | null };
    expect(ldl.flag).toBe("high");
  });

  it("toddler: growth series present, adult stores untouched", () => {
    const profileId = seeded.get("toddler")!;
    const heights = (
      db
        .prepare(
          `SELECT COUNT(*) c FROM metric_samples WHERE profile_id = ? AND metric = 'height_cm'`
        )
        .get(profileId) as { c: number }
    ).c;
    expect(heights).toBeGreaterThanOrEqual(6);
    expect(count(profileId, "activities")).toBe(0);
    expect(count(profileId, "intake_items")).toBe(0);
    expect(count(profileId, "immunizations")).toBeGreaterThanOrEqual(15);
  });

  it("senior-75: six active medications including the warfarin+NSAID pair", () => {
    const profileId = seeded.get("senior-75")!;
    const meds = db
      .prepare(
        `SELECT name, rx FROM intake_items
         WHERE profile_id = ? AND kind = 'medication' AND active = 1`
      )
      .all(profileId) as { name: string; rx: number }[];
    expect(meds.length).toBe(6);
    const byName = new Map(meds.map((m) => [m.name, m]));
    expect(byName.has("Warfarin")).toBe(true);
    expect(byName.has("Ibuprofen")).toBe(true);
    // Prescriber-bearing meds are Rx (the RxOtcBadge reads intake_items.rx);
    // the self-directed OTC NSAID stays 0.
    expect(byName.get("Warfarin")!.rx).toBe(1);
    expect(byName.get("Ibuprofen")!.rx).toBe(0);
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

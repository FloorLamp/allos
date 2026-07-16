import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getOnboardingDataPresence } from "@/lib/onboarding-data";
import {
  hasConnectedDataSource,
  upsertConnection,
} from "@/lib/integrations/connections";
import { getOnboardingState } from "@/lib/settings";

function profile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("onboarding DB boundary", () => {
  it("marks only a fresh bootstrap profile for first-run setup", () => {
    expect(getOnboardingState(1)).toMatchObject({
      version: 1,
      status: "not_started",
      focuses: [],
    });

    const legacy = profile("Legacy Profile");
    expect(getOnboardingState(legacy)).toBeNull();
  });

  it("detects first value by profile and domain", () => {
    const a = profile("Onboarding A");
    const b = profile("Onboarding B");
    const supplementsOnly = profile("Onboarding Supplements Only");
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title)
       VALUES (?, '2026-07-15', 'cardio', 'First walk')`
    ).run(a);
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, kind)
       VALUES (?, 'Example medication', 'medication')`
    ).run(b);
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, kind)
       VALUES (?, 'Example supplement', 'supplement')`
    ).run(supplementsOnly);

    expect(getOnboardingDataPresence(a)).toEqual({
      medicalRecords: false,
      medications: false,
      fitness: true,
      metricsLabs: false,
      preventiveCare: false,
    });
    expect(getOnboardingDataPresence(b)).toEqual({
      medicalRecords: false,
      medications: true,
      fitness: false,
      metricsLabs: false,
      preventiveCare: false,
    });
    expect(getOnboardingDataPresence(supplementsOnly).medications).toBe(false);
  });

  it("distinguishes a connected source from manual fitness data", () => {
    const manual = profile("Manual Fitness");
    const connected = profile("Connected Fitness");
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title)
       VALUES (?, '2026-07-15', 'cardio', 'Manual walk')`
    ).run(manual);

    expect(hasConnectedDataSource(manual)).toBe(false);
    expect(hasConnectedDataSource(connected)).toBe(false);

    upsertConnection(connected, "strava", { status: "connected" });
    expect(hasConnectedDataSource(connected)).toBe(true);
    expect(hasConnectedDataSource(manual)).toBe(false);

    upsertConnection(connected, "strava", { status: "needs_reauth" });
    expect(hasConnectedDataSource(connected)).toBe(false);
  });
});

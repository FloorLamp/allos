// DB INTEGRATION TIER — equipment usage payoff (issue #343).
//
// getEquipmentUsage / getEquipmentUsageById / getEquipmentSessions compute the
// per-item usage summary (sessions, last used, Σ volume, Σ distance) shared by the
// /equipment index badges and the detail page. This exercises the real schema:
// the set-level implement link (exercise_sets.equipment_id) drives volume, the
// session-level gear link (activities.equipment_id) drives distance, and a single
// activity used at both levels counts once. The db singleton is a per-file temp DB
// (setup.ts); profile 1 exists via bootstrapAuth.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { createEquipment } from "@/lib/equipment";
import {
  getEquipmentUsage,
  getEquipmentUsageById,
  getEquipmentSessions,
} from "@/lib/queries/equipment";

function newActivity(
  profileId: number,
  date: string,
  opts: {
    type?: string;
    title?: string;
    distance_km?: number | null;
    equipment_id?: number | null;
  } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, distance_km, equipment_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        date,
        opts.type ?? "strength",
        opts.title ?? "Session",
        opts.distance_km ?? null,
        opts.equipment_id ?? null
      ).lastInsertRowid
  );
}

function addSet(
  activityId: number,
  opts: {
    exercise?: string;
    weight_kg?: number | null;
    reps?: number | null;
    equipment_id?: number | null;
  } = {}
): void {
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, equipment_id)
     VALUES (?, ?, 1, ?, ?, ?)`
  ).run(
    activityId,
    opts.exercise ?? "Bench Press",
    opts.weight_kg ?? null,
    opts.reps ?? null,
    opts.equipment_id ?? null
  );
}

describe("getEquipmentUsage", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM exercise_sets").run();
    db.prepare("DELETE FROM activities WHERE profile_id = 1").run();
    db.prepare("DELETE FROM equipment WHERE profile_id = 1").run();
  });

  it("sums set-level volume (both sides) and counts distinct sessions", () => {
    const bar = createEquipment(1, {
      name: "PR Bar",
      weight_kg: 20,
      category: "Barbell",
    });
    const a1 = newActivity(1, "2026-07-01");
    addSet(a1, { weight_kg: 100, reps: 5, equipment_id: bar.id }); // 500
    addSet(a1, { weight_kg: 100, reps: 5, equipment_id: bar.id }); // 500 (same session)
    const a2 = newActivity(1, "2026-07-05");
    addSet(a2, { weight_kg: 60, reps: 5, equipment_id: bar.id }); // 300

    const u = getEquipmentUsageById(1, bar.id)!;
    expect(u.sessions).toBe(2); // two distinct activities
    expect(u.totalVolumeKg).toBe(1300);
    expect(u.totalDistanceKm).toBe(0);
    expect(u.lastUsed).toBe("2026-07-05");
  });

  it("sums session-level distance for a bike/shoes gear", () => {
    const bike = createEquipment(1, {
      name: "Road Bike",
      weight_kg: null,
      category: "Bike",
    });
    newActivity(1, "2026-07-02", {
      type: "cardio",
      distance_km: 20,
      equipment_id: bike.id,
    });
    newActivity(1, "2026-07-06", {
      type: "cardio",
      distance_km: 30,
      equipment_id: bike.id,
    });

    const u = getEquipmentUsageById(1, bike.id)!;
    expect(u.sessions).toBe(2);
    expect(u.totalDistanceKm).toBe(50);
    expect(u.totalVolumeKg).toBe(0);
    expect(u.lastUsed).toBe("2026-07-06");
  });

  it("counts a session once even when used at both set and session level", () => {
    const bar = createEquipment(1, {
      name: "Dual Bar",
      weight_kg: 20,
      category: "Barbell",
    });
    const a = newActivity(1, "2026-07-03", { equipment_id: bar.id });
    addSet(a, { weight_kg: 50, reps: 4, equipment_id: bar.id });

    const u = getEquipmentUsageById(1, bar.id)!;
    expect(u.sessions).toBe(1); // one activity, not two
    expect(u.totalVolumeKg).toBe(200);
  });

  it("returns null for gear with no usage and is profile-scoped", () => {
    const bar = createEquipment(1, {
      name: "Unused Bar",
      weight_kg: 20,
      category: "Barbell",
    });
    expect(getEquipmentUsageById(1, bar.id)).toBeNull();
    // A foreign profile's read never sees profile 1's equipment usage.
    expect(getEquipmentUsage(999).size).toBe(0);
  });

  it("getEquipmentSessions returns per-activity points oldest→newest", () => {
    const bar = createEquipment(1, {
      name: "Trend Bar",
      weight_kg: 20,
      category: "Barbell",
    });
    const a2 = newActivity(1, "2026-07-08", { title: "Later" });
    addSet(a2, { weight_kg: 80, reps: 5, equipment_id: bar.id });
    const a1 = newActivity(1, "2026-07-04", { title: "Earlier" });
    addSet(a1, { weight_kg: 100, reps: 5, equipment_id: bar.id });

    const pts = getEquipmentSessions(1, bar.id);
    expect(pts.map((p) => p.date)).toEqual(["2026-07-04", "2026-07-08"]);
    expect(pts.map((p) => p.volumeKg)).toEqual([500, 400]);
    expect(pts[0].title).toBe("Earlier");
  });
});

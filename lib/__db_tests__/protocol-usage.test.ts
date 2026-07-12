// DB INTEGRATION TIER — protocol practice/usage reads (issue #344).
//
// getProtocolUsage (usage-during-window: distinct activity days that used the
// linked gear and/or logged the practice type within [start, end??today]),
// getProtocolPractice (the configured type + per-week), and getProtocolAdherence
// (the SAME weekly-count computation the routine widget uses) against the real
// schema. The db singleton is a per-file temp DB (setup.ts); profile 1 exists.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { createEquipment } from "@/lib/equipment";
import {
  getProtocol,
  getProtocolUsage,
  getProtocolPractice,
  getProtocolAdherence,
} from "@/lib/queries";

function insertTypeTarget(profileId: number, type: string, perWeek: number) {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
         VALUES (?, 'type', ?, ?)`
      )
      .run(profileId, type, perWeek).lastInsertRowid
  );
}

function insertProtocol(
  profileId: number,
  opts: {
    start: string;
    end?: string | null;
    equipment_id?: number | null;
    frequency_target_id?: number | null;
  }
) {
  return Number(
    db
      .prepare(
        `INSERT INTO protocols
           (profile_id, name, start_date, end_date, equipment_id, frequency_target_id)
         VALUES (?, 'P', ?, ?, ?, ?)`
      )
      .run(
        profileId,
        opts.start,
        opts.end ?? null,
        opts.equipment_id ?? null,
        opts.frequency_target_id ?? null
      ).lastInsertRowid
  );
}

function insertActivity(
  profileId: number,
  date: string,
  type: string,
  equipment_id: number | null
) {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, equipment_id)
     VALUES (?, ?, ?, 'Session', ?)`
  ).run(profileId, date, type, equipment_id);
}

describe("getProtocolUsage / getProtocolPractice / getProtocolAdherence", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM activities WHERE profile_id = 1").run();
    db.prepare("DELETE FROM protocols WHERE profile_id = 1").run();
    db.prepare("DELETE FROM frequency_targets WHERE profile_id = 1").run();
    db.prepare("DELETE FROM equipment WHERE profile_id = 1").run();
  });

  it("counts distinct in-window days matching the linked gear or practice type", () => {
    const sauna = createEquipment(1, {
      name: "Sauna",
      weight_kg: null,
      category: "Sauna",
    });
    const tid = insertTypeTarget(1, "cardio", 4);
    const pid = insertProtocol(1, {
      start: "2026-06-01",
      end: "2026-06-30",
      equipment_id: sauna.id,
      frequency_target_id: tid,
    });

    // In-window, gear-linked (counts).
    insertActivity(1, "2026-06-03", "sport", sauna.id);
    // In-window, practice type cardio (counts).
    insertActivity(1, "2026-06-10", "cardio", null);
    // Same day, gear-linked AND cardio — still one distinct day.
    insertActivity(1, "2026-06-10", "cardio", sauna.id);
    // Out of window (before start) — excluded.
    insertActivity(1, "2026-05-20", "cardio", sauna.id);
    // Out of window (after end) — excluded.
    insertActivity(1, "2026-07-05", "cardio", null);
    // Unrelated type, no gear — excluded.
    insertActivity(1, "2026-06-15", "strength", null);

    const p = getProtocol(1, pid)!;
    const usage = getProtocolUsage(1, p, "2026-07-31");
    expect(usage.sessions).toBe(2); // 06-03 and 06-10
    expect(usage.lastUsed).toBe("2026-06-10");
  });

  it("uses today as the window end for an ongoing protocol", () => {
    const tid = insertTypeTarget(1, "cardio", 3);
    const pid = insertProtocol(1, {
      start: "2000-01-01",
      end: null,
      frequency_target_id: tid,
    });
    insertActivity(1, today(1), "cardio", null);
    const p = getProtocol(1, pid)!;
    const usage = getProtocolUsage(1, p, today(1));
    expect(usage.sessions).toBe(1);
  });

  it("returns zero usage when neither gear nor practice is linked", () => {
    const pid = insertProtocol(1, { start: "2026-06-01" });
    const p = getProtocol(1, pid)!;
    expect(getProtocolUsage(1, p, "2026-07-01")).toEqual({
      sessions: 0,
      lastUsed: null,
    });
  });

  it("getProtocolPractice resolves the type + per-week; adherence reuses the weekly count", () => {
    const tid = insertTypeTarget(1, "cardio", 4);
    const pid = insertProtocol(1, {
      start: "2000-01-01",
      end: null,
      frequency_target_id: tid,
    });
    const p = getProtocol(1, pid)!;
    expect(getProtocolPractice(1, p)).toEqual({ type: "cardio", perWeek: 4 });

    // A cardio activity this week counts toward the SAME frequency-target progress.
    insertActivity(1, today(1), "cardio", null);
    const adherence = getProtocolAdherence(1, p);
    expect(adherence?.target.id).toBe(tid);
    expect(adherence?.per_week).toBe(4);
    expect(adherence?.count).toBeGreaterThanOrEqual(1);
  });

  it("practice/adherence are null when unlinked", () => {
    const pid = insertProtocol(1, { start: "2026-06-01" });
    const p = getProtocol(1, pid)!;
    expect(getProtocolPractice(1, p)).toBeNull();
    expect(getProtocolAdherence(1, p)).toBeNull();
  });
});

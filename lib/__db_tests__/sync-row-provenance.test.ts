// DB INTEGRATION TIER — per-row sync provenance (issue #1333, deferred #1212 parts
// 1-2). The keyed upserts record WHICH records they inserted/updated into
// integration_sync_rows (only the value-changing dispositions — an unchanged re-send
// is deliberately not persisted, the volume cap). A Connected-sources event drills
// into those rows via getSyncRowProvenance, which resolves each to a profile-scoped
// deep link. Retention is inherited: pruning the event cascades its rows away.

import { describe, it, expect, beforeEach } from "vitest";
import { db, writeTx } from "@/lib/db";
import {
  upsertActivities,
  upsertBodyMetrics,
  upsertPracticeLogs,
  upsertVitals,
  type NormActivity,
  type NormBodyMetric,
  type NormVital,
} from "@/lib/integrations/normalize";
import type { ProvenanceEntry } from "@/lib/integrations/sync-log";
import {
  recordSyncEvent,
  recordSyncRows,
  pruneSyncEvents,
} from "@/lib/integrations/connections";
import { getSyncRowProvenance } from "@/lib/queries/integrations";

let profileId: number;

function activity(extId: string, title: string): NormActivity {
  return {
    external_id: extId,
    date: "2026-03-01",
    type: "cardio",
    title,
    duration_min: 30,
    distance_km: 5,
    start_time: null,
    end_time: null,
  };
}

function provenanceRowCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM integration_sync_rows").get() as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  db.exec("DELETE FROM integration_sync_rows");
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM activities");
  db.exec("DELETE FROM body_metrics");
  db.exec("DELETE FROM medical_records");
  db.exec("DELETE FROM practice_logs");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('SYNC-PROV')").run()
      .lastInsertRowid
  );
});

describe("integration_sync_rows provenance (#1333)", () => {
  it("records inserted/updated dispositions but not unchanged re-sends", () => {
    const sink: ProvenanceEntry[] = [];
    // First sync: one activity + one body metric + one vital — all inserted.
    writeTx(() =>
      upsertActivities(
        profileId,
        [activity("hc:a1", "Morning run")],
        "health-connect",
        sink
      )
    );
    writeTx(() =>
      upsertBodyMetrics(
        profileId,
        [{ date: "2026-03-01", weight_kg: 80 } as NormBodyMetric],
        "health-connect",
        sink
      )
    );
    const vital: NormVital = {
      external_id: "hc:v1",
      date: "2026-03-01",
      category: "vitals",
      name: "Resting Heart Rate",
      canonical: "Resting Heart Rate",
      value_num: 55,
      unit: "bpm",
    };
    writeTx(() => upsertVitals(profileId, [vital], "health-connect", sink));

    expect(sink).toHaveLength(3);
    expect(sink.map((s) => s.disposition).sort()).toEqual([
      "inserted",
      "inserted",
      "inserted",
    ]);
    expect(new Set(sink.map((s) => s.target_table))).toEqual(
      new Set(["activities", "body_metrics", "medical_records"])
    );

    // Second sync of the SAME rows with no change: all unchanged → sink stays empty.
    const sink2: ProvenanceEntry[] = [];
    writeTx(() =>
      upsertActivities(
        profileId,
        [activity("hc:a1", "Morning run")],
        "health-connect",
        sink2
      )
    );
    writeTx(() =>
      upsertBodyMetrics(
        profileId,
        [{ date: "2026-03-01", weight_kg: 80 } as NormBodyMetric],
        "health-connect",
        sink2
      )
    );
    writeTx(() => upsertVitals(profileId, [vital], "health-connect", sink2));
    expect(sink2).toHaveLength(0);

    // Third sync: change the activity title → one updated entry.
    const sink3: ProvenanceEntry[] = [];
    writeTx(() =>
      upsertActivities(
        profileId,
        [activity("hc:a1", "Evening run")],
        "health-connect",
        sink3
      )
    );
    expect(sink3).toHaveLength(1);
    expect(sink3[0]).toMatchObject({
      target_table: "activities",
      disposition: "updated",
    });
  });

  it("persists the rows against an event and the drill-in resolves working links", () => {
    const sink: ProvenanceEntry[] = [];
    writeTx(() =>
      upsertActivities(
        profileId,
        [activity("hc:a1", "Morning run")],
        "health-connect",
        sink
      )
    );
    writeTx(() =>
      upsertBodyMetrics(
        profileId,
        [{ date: "2026-03-02", weight_kg: 81 } as NormBodyMetric],
        "health-connect",
        sink
      )
    );
    const eventId = recordSyncEvent(profileId, "health-connect", {
      ok: true,
      inserted: 2,
      updated: 0,
      unchanged: 0,
    });
    recordSyncRows(eventId, sink);

    const links = getSyncRowProvenance(profileId, eventId!);
    expect(links).toHaveLength(2);
    const act = links.find((l) => l.targetTable === "activities")!;
    expect(act.label).toBe("Morning run");
    expect(act.disposition).toBe("inserted");
    expect(act.deleted).toBe(false);
    expect(act.href).toContain("/timeline?from=2026-03-01");
    const body = links.find((l) => l.targetTable === "body_metrics")!;
    expect(body.href).toContain("/timeline?from=2026-03-02");

    // Another profile can't resolve this event's provenance.
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('OTHER')").run()
        .lastInsertRowid
    );
    expect(getSyncRowProvenance(other, eventId!)).toHaveLength(0);
  });

  it("records and resolves wellness-practice rows", () => {
    const sink: ProvenanceEntry[] = [];
    const practice = {
      external_id: "fitbit-takeout:practice-1",
      practice: "Meditation",
      date: "2026-03-03",
      time: "07:30",
      duration_min: 20,
    };
    writeTx(() =>
      upsertPracticeLogs(profileId, [practice], "fitbit-takeout", sink)
    );
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({
      target_table: "practice_logs",
      disposition: "inserted",
    });

    const eventId = recordSyncEvent(profileId, "fitbit-takeout", {
      ok: true,
      inserted: 1,
    });
    recordSyncRows(eventId, sink);

    const links = getSyncRowProvenance(profileId, eventId!);
    expect(links).toMatchObject([
      {
        targetTable: "practice_logs",
        disposition: "inserted",
        date: "2026-03-03",
        label: "Meditation",
        deleted: false,
      },
    ]);
    expect(links[0].href).toContain("/timeline?from=2026-03-03");

    const updated: ProvenanceEntry[] = [];
    writeTx(() =>
      upsertPracticeLogs(
        profileId,
        [{ ...practice, duration_min: 25 }],
        "fitbit-takeout",
        updated
      )
    );
    expect(updated).toMatchObject([
      { target_table: "practice_logs", disposition: "updated" },
    ]);

    const unchanged: ProvenanceEntry[] = [];
    writeTx(() =>
      upsertPracticeLogs(
        profileId,
        [{ ...practice, duration_min: 25 }],
        "fitbit-takeout",
        unchanged
      )
    );
    expect(unchanged).toEqual([]);
  });

  it("marks a since-deleted target as removed but still lists it", () => {
    const sink: ProvenanceEntry[] = [];
    writeTx(() =>
      upsertActivities(
        profileId,
        [activity("hc:a1", "Gone run")],
        "health-connect",
        sink
      )
    );
    const eventId = recordSyncEvent(profileId, "health-connect", { ok: true });
    recordSyncRows(eventId, sink);
    // Delete the underlying activity.
    db.prepare("DELETE FROM activities WHERE profile_id = ?").run(profileId);
    const links = getSyncRowProvenance(profileId, eventId!);
    expect(links).toHaveLength(1);
    expect(links[0].deleted).toBe(true);
  });

  it("cascades away when its event is pruned by the retention sweep (#388)", () => {
    const sink: ProvenanceEntry[] = [];
    writeTx(() =>
      upsertActivities(
        profileId,
        [activity("hc:a1", "Old run")],
        "health-connect",
        sink
      )
    );
    const eventId = recordSyncEvent(profileId, "health-connect", { ok: true });
    recordSyncRows(eventId, sink);
    expect(provenanceRowCount()).toBe(1);
    // Age the event well past the retention window so the sweep removes it. (Its
    // provenance rows carry an ON DELETE CASCADE FK; foreign_keys is ON at runtime.)
    db.prepare(
      "UPDATE integration_sync_events SET at = datetime('now', '-400 days') WHERE id = ?"
    ).run(eventId);
    // A newer event keeps the pruner from retaining the aged one as newest-per-provider.
    recordSyncEvent(profileId, "health-connect", { ok: true });
    pruneSyncEvents();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM integration_sync_events WHERE id = ?"
        )
        .get(eventId)
    ).toMatchObject({ n: 0 });
    expect(provenanceRowCount()).toBe(0);
  });
});

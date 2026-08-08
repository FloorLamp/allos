// DB INTEGRATION TIER — a real high-frequency day through the read model (#1991).
//
// The pure tier pins the grouping rule; this pins what the SOURCE PAGE actually
// receives: a day of ~70 Health Connect pushes resolving to one day line with one
// anomaly in it, and — the regression pin for the live defect — a drill-in that
// promises exactly the number of rows it will list, never the run's split total.
//
// All fixture values are synthetic. No PHI.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  recordSyncEvent,
  recordSyncRows,
  upsertConnection,
} from "@/lib/integrations/connections";
import { getIntegrationState, SETUP_HISTORY_LIMIT } from "@/lib/queries";
import {
  drilldownCoverage,
  groupSyncDays,
  syncDayAttention,
  syncDayLabel,
} from "@/lib/integrations/sync-history-days";
import { syncRunNounForKind } from "@/lib/integrations/provider-state";

const PROVIDER = "health-connect";
// The exporter's rolling window: mostly unchanged re-sends, a few new rows.
const PUSHES = 70;
// One push in the middle dropped rows it could not map — the anomaly the stream
// was burying.
const ANOMALY_INDEX = 40;
const ANOMALY_SKIPPED = 6;

let profileId: number;
let newestEventId: number;
let anomalyEventId: number;

// A push at hour:minute on a fixed day, stored the way the ingest stores it (UTC).
function stamp(minutesFromMidnight: number): string {
  const h = String(Math.floor(minutesFromMidnight / 60)).padStart(2, "0");
  const m = String(minutesFromMidnight % 60).padStart(2, "0");
  return `2026-07-08T${h}:${m}:00Z`;
}

function backdate(id: number, at: string): void {
  db.prepare(`UPDATE integration_sync_events SET at = ? WHERE id = ?`).run(
    at,
    id
  );
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('HC-DAY')").run()
      .lastInsertRowid
  );
  // The profile's day boundary is the reader's; pin it so the fixture's UTC stamps
  // and the grouped day cannot drift apart.
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')`
  ).run(profileId);
  upsertConnection(profileId, PROVIDER, { status: "connected", config: null });

  // ~70 pushes across one day, 20 minutes apart, starting at 00:10.
  const ids: number[] = [];
  for (let i = 0; i < PUSHES; i++) {
    const isAnomaly = i === ANOMALY_INDEX;
    const id = recordSyncEvent(profileId, PROVIDER, {
      ok: true,
      inserted: i % 10 === 0 ? 5 : 0,
      updated: 0,
      unchanged: 73,
      skipped: isAnomaly ? ANOMALY_SKIPPED : 0,
    })!;
    backdate(id, stamp(10 + i * 20));
    ids.push(id);
    if (isAnomaly) anomalyEventId = id;
  }
  newestEventId = ids[ids.length - 1];

  // The newest push wrote 30 records by its split, but only TWO of them carry an
  // openable identity — the rest are minute-grain rows recordSyncRows deliberately
  // skips (they have no row id). This is the live defect's exact shape.
  db.prepare(
    `UPDATE integration_sync_events SET inserted = 20, updated = 10, unchanged = 73
      WHERE id = ?`
  ).run(newestEventId);
  const activityId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, source)
         VALUES (?, '2026-07-08', 'cardio', 'HC day-group run', 'health-connect')`
      )
      .run(profileId).lastInsertRowid
  );
  const bodyId = Number(
    db
      .prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
         VALUES (?, '2026-07-08', 79.4, 'health-connect')`
      )
      .run(profileId).lastInsertRowid
  );
  recordSyncRows(newestEventId, [
    {
      target_table: "activities",
      target_id: activityId,
      disposition: "inserted",
    },
    { target_table: "body_metrics", target_id: bodyId, disposition: "updated" },
  ]);
});

describe("a day of ~70 pushes, as the source page receives it", () => {
  it("collapses to ONE day line carrying the day's totals", () => {
    const state = getIntegrationState(
      profileId,
      PROVIDER,
      SETUP_HISTORY_LIMIT
    )!;
    const days = groupSyncDays(state.history, state.timeZone);
    expect(days).toHaveLength(1);
    const [day] = days;
    expect(day.day).toBe("2026-07-08");
    // The page renders SETUP_HISTORY_LIMIT runs deep, and every one of them is on
    // this day — the point being that they are one line, not that many.
    expect(day.runs).toBe(state.history.length);
    expect(day.runs).toBeGreaterThan(1);
    expect(
      syncDayLabel(day, syncRunNounForKind(state.kind)!, state.vocabulary)
    ).toMatch(/^\d+ pushes · \d+ new · \d+ changed$/);
  });

  it("surfaces the day's ONE anomaly instead of burying it in the stream", () => {
    // Reach past the display limit so the anomaly (40 pushes back) is in view; the
    // grouping is the same computation at any depth.
    const state = getIntegrationState(profileId, PROVIDER, PUSHES)!;
    const [day] = groupSyncDays(state.history, state.timeZone);
    expect(day.runs).toBe(PUSHES);
    expect(syncDayAttention(day)).toEqual({
      label: `${ANOMALY_SKIPPED} skipped`,
      tone: "caution",
    });

    // Opening the day itemizes only the newest push and the anomaly; the other 68
    // are ranges, and every one of them is still accounted for.
    const itemized = day.entries.filter((e) => e.kind === "run");
    expect(itemized.map((e) => e.kind === "run" && e.ev.id)).toEqual([
      state.history[0].id,
      anomalyEventId,
    ]);
    const ranged = day.entries
      .filter((e) => e.kind === "range")
      .reduce((n, e) => n + (e.kind === "range" ? e.runs.length : 0), 0);
    expect(itemized.length + ranged).toBe(PUSHES);
  });
});

describe("the drill-in promises what it can list (the #1991 regression pin)", () => {
  it("counts provenance rows, NOT the run's split total", () => {
    const state = getIntegrationState(
      profileId,
      PROVIDER,
      SETUP_HISTORY_LIMIT
    )!;
    const newest = state.history[0];
    expect(newest.id).toBe(newestEventId);

    // The split says 30 records were written…
    const written = (newest.inserted ?? 0) + (newest.updated ?? 0);
    expect(written).toBe(30);
    // …and exactly two of them can be opened.
    expect(state.provenanceCounts[newestEventId]).toBe(2);

    const coverage = drilldownCoverage(
      written,
      state.provenanceCounts[newestEventId] ?? 0
    );
    expect(coverage.itemizable).toBe(2);
    expect(coverage.remainder).toBe(28);
    expect(coverage.offer).toBe(true);
  });

  it("offers no drill-in for a run that recorded nothing openable", () => {
    const state = getIntegrationState(profileId, PROVIDER, PUSHES)!;
    const plain = state.history.find((e) => e.id === anomalyEventId)!;
    expect(state.provenanceCounts[plain.id]).toBeUndefined();
    expect(
      drilldownCoverage(
        (plain.inserted ?? 0) + (plain.updated ?? 0),
        state.provenanceCounts[plain.id] ?? 0
      ).offer
    ).toBe(false);
  });
});

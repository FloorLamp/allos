// DB INTEGRATION TIER — the Review body-metric conflict read (issue #1615).
//
// The pure detector has its own coverage; what this pins is the end-to-end query
// path (loadBodyMetricConflictRows → findBodyMetricConflicts → undecidedPairs) over
// REAL rows written through the shared upserts, plus the load-bearing consequence of
// the fix: an exact-equal cross-source pair leaves BOTH rows in place and writes no
// decision, tombstone, or edit lock. Every value below is a plainly fictional reading.

import { describe, it, expect, beforeAll } from "vitest";
import { toKg } from "@/lib/units";
import { db } from "@/lib/db";
import { upsertBodyMetrics } from "@/lib/integrations/normalize";
import { getBodyMetricConflicts, getReviewPairCount } from "@/lib/queries";

const EQUAL_DAY = "2026-04-10";
const DIFFERING_DAY = "2026-04-11";
const MIXED_DAY = "2026-04-12";

let profileId: number;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function rowsOn(day: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND date = ?"
      )
      .get(profileId, day) as { n: number }
  ).n;
}

beforeAll(() => {
  profileId = newProfile("BM-CONFLICT");
  // Agreeing cross-source day: 55 bpm from both devices.
  upsertBodyMetrics(
    profileId,
    [{ date: EQUAL_DAY, resting_hr: 55 }],
    "health-connect"
  );
  upsertBodyMetrics(profileId, [{ date: EQUAL_DAY, resting_hr: 55 }], "oura");
  // Disagreeing cross-source day: 55 vs 56 bpm.
  upsertBodyMetrics(
    profileId,
    [{ date: DIFFERING_DAY, resting_hr: 55 }],
    "health-connect"
  );
  upsertBodyMetrics(
    profileId,
    [{ date: DIFFERING_DAY, resting_hr: 56 }],
    "oura"
  );
  // Mixed day: resting HR agrees, weight does not.
  upsertBodyMetrics(
    profileId,
    [{ date: MIXED_DAY, resting_hr: 55, weight_kg: toKg(70, "kg") }],
    "health-connect"
  );
  upsertBodyMetrics(
    profileId,
    [{ date: MIXED_DAY, resting_hr: 55, weight_kg: toKg(70.4, "kg") }],
    "withings"
  );
});

describe("getBodyMetricConflicts and exact-equal cross-source rows", () => {
  it("does not flag the day both sources agree on", () => {
    const days = getBodyMetricConflicts(profileId).map((p) => p.a.date);
    expect(days).not.toContain(EQUAL_DAY);
  });

  it("keeps BOTH source rows for the agreeing day, untouched", () => {
    expect(rowsOn(EQUAL_DAY)).toBe(2);
    const rows = db
      .prepare(
        `SELECT source, edited FROM body_metrics
          WHERE profile_id = ? AND date = ? ORDER BY source`
      )
      .all(profileId, EQUAL_DAY) as { source: string; edited: number | null }[];
    expect(rows.map((r) => r.source)).toEqual(["health-connect", "oura"]);
    // No auto-merge: nothing was edit-locked, tombstoned, or decided.
    expect(rows.every((r) => !r.edited)).toBe(true);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM import_tombstones WHERE profile_id = ?"
          )
          .get(profileId) as { n: number }
      ).n
    ).toBe(0);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM import_pair_decisions WHERE profile_id = ?"
          )
          .get(profileId) as { n: number }
      ).n
    ).toBe(0);
  });

  it("still flags the day the sources disagree on", () => {
    const pair = getBodyMetricConflicts(profileId).find(
      (p) => p.a.date === DIFFERING_DAY
    );
    expect(pair).toBeTruthy();
    expect(pair!.measures).toEqual(["resting HR"]);
    expect(new Set([pair!.a.source, pair!.b.source])).toEqual(
      new Set(["health-connect", "oura"])
    );
  });

  it("names only the disagreeing measure on a mixed day", () => {
    const pair = getBodyMetricConflicts(profileId).find(
      (p) => p.a.date === MIXED_DAY
    );
    expect(pair).toBeTruthy();
    expect(pair!.measures).toEqual(["weight"]);
    expect(pair!.reason).toBe("Same-day weight from two rows");
  });

  it("keeps the equal cross-source day out of the Review badge count", () => {
    // Exactly the two reviewable days (differing + mixed) — the agreeing day adds
    // nothing to the badge.
    expect(getBodyMetricConflicts(profileId)).toHaveLength(2);
    expect(getReviewPairCount(profileId)).toBe(2);
  });

  it("still reviews two equal MANUAL rows on one day", () => {
    const p = newProfile("BM-CONFLICT-MANUAL");
    // Manual rows carry a NULL source and are exempt from the natural key, so two
    // identical weigh-ins really do persist as two rows — duplicate RECORDS, not an
    // intentional multi-source observation.
    const insert = db.prepare(
      "INSERT INTO body_metrics (profile_id, date, resting_hr) VALUES (?, ?, ?)"
    );
    insert.run(p, "2026-04-13", 55);
    insert.run(p, "2026-04-13", 55);
    const pairs = getBodyMetricConflicts(p);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].measures).toEqual(["resting HR"]);
  });
});

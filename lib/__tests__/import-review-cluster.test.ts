// PURE TIER — N-way clustering + generalized keeper + auto-merge decision (#1081).
// No DB: every function here takes already-loaded rows and returns plain data.

import { describe, it, expect } from "vitest";
import {
  findActivityDuplicates,
  clusterActivityDuplicates,
  preferActivityKeeperId,
  autoMergeCluster,
  highConfidenceTwinIds,
  orderDropsForFold,
  type ActivityDupInput,
} from "@/lib/import-review/detect";

// Build a candidate activity row; every duplicate lives in the SAME DATE bucket
// (#2271 dropped `type` from the bucket key). Overlapping clock windows drive the
// HIGH cross-source detection.
function row(
  over: Partial<ActivityDupInput> & { id: number }
): ActivityDupInput {
  return {
    date: "2026-07-07",
    type: "cardio",
    source: null,
    external_id: null,
    duration_min: 30,
    distance_km: 5,
    start_time: "08:00",
    end_time: "08:30",
    edited: 0,
    ...over,
  };
}

describe("clusterActivityDuplicates (#1081)", () => {
  it("collapses four cross-source overlapping rows into ONE cluster of 4", () => {
    const rows = [
      row({ id: 1, source: null }), // manual
      row({
        id: 2,
        source: "strava",
        external_id: "strava:x",
        start_time: "08:01",
        end_time: "08:31",
      }),
      row({
        id: 3,
        source: "health-connect",
        external_id: "hc:x",
        start_time: "08:02",
        end_time: "08:32",
      }),
      row({
        id: 4,
        source: "oura",
        external_id: "oura:x",
        start_time: "08:03",
        end_time: "08:33",
      }),
    ];
    const clusters = clusterActivityDuplicates(findActivityDuplicates(rows));
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.id).sort()).toEqual([1, 2, 3, 4]);
    expect(clusters[0].confidence).toBe("high");
    // Every constituent pair signature is recorded (C(4,2) = 6).
    expect(clusters[0].pairSignatures).toHaveLength(6);
  });

  it("keeps two distinct non-overlapping sessions as TWO clusters", () => {
    const rows = [
      row({ id: 1, source: null, start_time: "08:00", end_time: "08:30" }),
      row({
        id: 2,
        source: "strava",
        external_id: "s:am",
        start_time: "08:02",
        end_time: "08:32",
      }),
      row({ id: 3, source: null, start_time: "18:00", end_time: "18:30" }),
      row({
        id: 4,
        source: "strava",
        external_id: "s:pm",
        start_time: "18:01",
        end_time: "18:31",
      }),
    ];
    const clusters = clusterActivityDuplicates(findActivityDuplicates(rows));
    expect(clusters).toHaveLength(2);
    for (const c of clusters) expect(c.members).toHaveLength(2);
  });

  it("re-derives the SAME cluster signature after a merge+re-sync (new ids, same tokens)", () => {
    const before = clusterActivityDuplicates(
      findActivityDuplicates([
        row({ id: 1, source: null }),
        row({
          id: 2,
          source: "strava",
          external_id: "strava:x",
          start_time: "08:01",
          end_time: "08:31",
        }),
      ])
    );
    // The Strava row is re-inserted under a DIFFERENT id but the same external_id.
    const after = clusterActivityDuplicates(
      findActivityDuplicates([
        row({ id: 1, source: null }),
        row({
          id: 99,
          source: "strava",
          external_id: "strava:x",
          start_time: "08:01",
          end_time: "08:31",
        }),
      ])
    );
    expect(before[0].signature).toBe(after[0].signature);
  });
});

describe("preferActivityKeeperId reduce (#1081)", () => {
  it("prefers a sourced row over a manual one across N members", () => {
    const members = [
      row({ id: 1, source: null }),
      row({ id: 2, source: "strava", external_id: "s:x" }),
      row({ id: 3, source: null }),
    ];
    expect(preferActivityKeeperId(members)).toBe(2);
  });

  it("breaks a sourced tie by richness, then lowest id", () => {
    const rich = row({
      id: 5,
      source: "strava",
      external_id: "s:a",
      avg_hr: 150,
    } as Partial<ActivityDupInput> & { id: number });
    const lean = row({
      id: 2,
      source: "oura",
      external_id: "o:a",
      duration_min: null,
      distance_km: null,
    });
    // rich has more populated fold fields → wins despite the higher id.
    expect(preferActivityKeeperId([lean, rich])).toBe(5);
  });
});

describe("orderDropsForFold (#1081)", () => {
  it("orders drops deterministically by activityToken (reproducible across re-sync)", () => {
    const a = row({ id: 9, source: "strava", external_id: "strava:a" });
    const b = row({ id: 3, source: "oura", external_id: "oura:b" });
    // ext:oura:b sorts before ext:strava:a, independent of the raw ids.
    expect(orderDropsForFold([a, b]).map((r) => r.id)).toEqual([3, 9]);
  });
});

describe("autoMergeCluster (#1081)", () => {
  const overlappingCrossSource = [
    row({ id: 1, source: null }),
    row({
      id: 2,
      source: "strava",
      external_id: "strava:x",
      start_time: "08:01",
      end_time: "08:31",
    }),
    row({
      id: 3,
      source: "health-connect",
      external_id: "hc:x",
      start_time: "08:02",
      end_time: "08:32",
    }),
  ];

  it("fires on an unambiguous cross-source overlapping cluster, keeper = sourced+richest", () => {
    const d = autoMergeCluster(overlappingCrossSource);
    expect(d).not.toBeNull();
    // The manual row (id 1) is dropped; a sourced row survives.
    expect(d!.dropIds).toContain(1);
    expect(d!.keepId).not.toBe(1);
    expect([d!.keepId, ...d!.dropIds].sort()).toEqual([1, 2, 3]);
  });

  it("fires on an overlapping cluster whose members DISAGREE about the type (#2271)", () => {
    // autoMergeCluster never looked at `type` — the candidacy gate upstream was the
    // only obstacle. This pins that: one gym session, one provider that declined to
    // classify it and one that called it `strength`, overlapping windows.
    const crossType = clusterActivityDuplicates(
      findActivityDuplicates([
        row({
          id: 384,
          type: "unclassified",
          source: "health-connect",
          external_id: "hc:gym",
          start_time: "14:30",
          end_time: "15:30",
          distance_km: null,
        }),
        row({
          id: 385,
          type: "strength",
          source: "strava",
          external_id: "strava:gym",
          start_time: "14:30",
          end_time: "15:29",
          distance_km: null,
        }),
      ])
    );
    expect(crossType).toHaveLength(1);
    const d = autoMergeCluster(crossType[0].members);
    expect(d).not.toBeNull();
    expect([d!.keepId, ...d!.dropIds].sort()).toEqual([384, 385]);
  });

  it("bails when the cluster is same-source only (no cross-source provenance)", () => {
    const sameSource = [
      row({
        id: 1,
        source: "strava",
        external_id: "strava:a",
        start_time: "08:00",
        end_time: "08:30",
      }),
      row({
        id: 2,
        source: "strava",
        external_id: "strava:b",
        start_time: "08:01",
        end_time: "08:31",
      }),
    ];
    expect(autoMergeCluster(sameSource)).toBeNull();
  });

  it("bails when a member lacks a clock window", () => {
    const noWindow = [
      row({ id: 1, source: null, start_time: null, end_time: null }),
      row({ id: 2, source: "strava", external_id: "strava:x" }),
    ];
    expect(autoMergeCluster(noWindow)).toBeNull();
  });

  it("bails on a MATERIAL distance/duration conflict (silent data loss)", () => {
    const conflicting = [
      row({ id: 1, source: null, distance_km: 5 }),
      row({
        id: 2,
        source: "strava",
        external_id: "strava:x",
        distance_km: 8,
        start_time: "08:01",
        end_time: "08:31",
      }),
    ];
    expect(autoMergeCluster(conflicting)).toBeNull();
  });

  it("bails when TWO members are edit-locked (ambiguous)", () => {
    const twoEdited = [
      row({ id: 1, source: null, edited: 1 }),
      row({
        id: 2,
        source: "strava",
        external_id: "strava:x",
        edited: 1,
        start_time: "08:01",
        end_time: "08:31",
      }),
    ];
    expect(autoMergeCluster(twoEdited)).toBeNull();
  });

  it("keeps the single edit-locked member as keeper (explicit user intent)", () => {
    const oneEdited = [
      row({ id: 1, source: null, edited: 1 }), // manual, but hand-edited
      row({
        id: 2,
        source: "strava",
        external_id: "strava:x",
        start_time: "08:01",
        end_time: "08:31",
      }),
    ];
    const d = autoMergeCluster(oneEdited);
    expect(d).not.toBeNull();
    expect(d!.keepId).toBe(1); // the edited row wins despite being the manual one
    expect(d!.dropIds).toEqual([2]);
  });
});

// ── The post-workout dispatch's duplicate awareness (#2570) ──────────────────

describe("highConfidenceTwinIds", () => {
  // THE SHAPE THE ISSUE IS ABOUT: one bike ride mirrored into a hub by the same app,
  // 32 seconds apart, so the start-instant identity kept both. One provider called it
  // biking; the other wrote it untyped. Same source, so auto-merge declines it — and
  // before #2570 nothing else was watching either.
  const hubA = row({
    id: 391,
    source: "health-connect",
    external_id: "health-connect:fixture-a",
    start_time: "09:04",
    end_time: "10:01",
  });
  const hubB = row({
    id: 392,
    type: "unclassified",
    source: "health-connect",
    external_id: "health-connect:fixture-b",
    start_time: "09:03",
    end_time: "10:01",
  });

  it("names the other row of a same-source overlapping pair", () => {
    const pairs = findActivityDuplicates([hubA, hubB]);
    expect(pairs.map((p) => p.confidence)).toEqual(["high"]);
    expect(highConfidenceTwinIds(pairs, 391)).toEqual([392]);
    expect(highConfidenceTwinIds(pairs, 392)).toEqual([391]);
  });

  it("names every high-confidence partner when a session landed as four rows", () => {
    const rich = row({
      id: 400,
      source: "strava",
      external_id: "strava:fixture",
      start_time: "09:04",
      end_time: "10:01",
    });
    const pairs = findActivityDuplicates([hubA, hubB, rich]);
    expect(highConfidenceTwinIds(pairs, 400).sort()).toEqual([391, 392]);
  });

  it("ignores a MEDIUM proximity match — declining a send needs better than a guess", () => {
    // A medium pair is medium precisely because a human is meant to look at it. A
    // second real workout that merely resembles the first must still be announced.
    const later = row({
      id: 500,
      source: "strava",
      external_id: "strava:later",
      start_time: "17:10",
      end_time: "17:40",
    });
    const manualLater = row({ id: 501, start_time: null, end_time: null });
    const pairs = findActivityDuplicates([later, manualLater]);
    expect(pairs.every((p) => p.confidence === "medium")).toBe(true);
    expect(highConfidenceTwinIds(pairs, 500)).toEqual([]);
  });

  it("says nothing about a row nothing was detected against", () => {
    expect(highConfidenceTwinIds([], 391)).toEqual([]);
    expect(
      highConfidenceTwinIds(findActivityDuplicates([hubA, hubB]), 999)
    ).toEqual([]);
  });
});

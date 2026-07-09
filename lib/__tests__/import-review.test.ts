import { describe, it, expect } from "vitest";
import {
  parseMinutesOfDay,
  activityWindow,
  windowsOverlap,
  proximityMatch,
  crossSource,
  sameSourceDuplicate,
  activityToken,
  pairSignature,
  findActivityDuplicates,
  bodyMetricToken,
  sharedMeasures,
  findBodyMetricConflicts,
  undecidedPairs,
  foldActivityFields,
  activityRichness,
  preferActivityKeeper,
  type ActivityDupInput,
  type BodyMetricConflictInput,
} from "@/lib/import-review/detect";

// A fully-specified activity row for detection tests; overrides tweak one field.
function act(over: Partial<ActivityDupInput>): ActivityDupInput {
  return {
    id: 1,
    date: "2026-07-08",
    type: "cardio",
    source: null,
    external_id: null,
    duration_min: null,
    distance_km: null,
    start_time: null,
    end_time: null,
    ...over,
  };
}

function bm(over: Partial<BodyMetricConflictInput>): BodyMetricConflictInput {
  return {
    id: 1,
    date: "2026-07-08",
    weight_kg: null,
    body_fat_pct: null,
    resting_hr: null,
    source: null,
    ...over,
  };
}

describe("parseMinutesOfDay", () => {
  it("parses HH:MM", () => {
    expect(parseMinutesOfDay("08:30")).toBe(8 * 60 + 30);
    expect(parseMinutesOfDay("00:00")).toBe(0);
    expect(parseMinutesOfDay("23:59")).toBe(23 * 60 + 59);
  });
  it("parses the time part of an ISO timestamp", () => {
    expect(parseMinutesOfDay("2026-07-08T06:15")).toBe(6 * 60 + 15);
    expect(parseMinutesOfDay("2026-07-08T06:15:00Z")).toBe(6 * 60 + 15);
  });
  it("returns null for missing/invalid", () => {
    expect(parseMinutesOfDay(null)).toBeNull();
    expect(parseMinutesOfDay("")).toBeNull();
    expect(parseMinutesOfDay("morning")).toBeNull();
    expect(parseMinutesOfDay("25:00")).toBeNull();
    expect(parseMinutesOfDay("08:70")).toBeNull();
  });
});

describe("activityWindow", () => {
  it("returns [start,end] when both present", () => {
    expect(activityWindow({ start_time: "08:00", end_time: "09:00" })).toEqual({
      start: 480,
      end: 540,
    });
  });
  it("collapses to a point when end missing or <= start", () => {
    expect(activityWindow({ start_time: "08:00", end_time: null })).toEqual({
      start: 480,
      end: 480,
    });
    expect(activityWindow({ start_time: "08:00", end_time: "07:00" })).toEqual({
      start: 480,
      end: 480,
    });
  });
  it("returns null without a usable start", () => {
    expect(activityWindow({ start_time: null, end_time: "09:00" })).toBeNull();
  });
});

describe("windowsOverlap", () => {
  it("detects overlap and touching endpoints", () => {
    expect(windowsOverlap({ start: 0, end: 60 }, { start: 30, end: 90 })).toBe(
      true
    );
    expect(windowsOverlap({ start: 0, end: 60 }, { start: 60, end: 90 })).toBe(
      true
    ); // touch
    expect(windowsOverlap({ start: 30, end: 30 }, { start: 0, end: 60 })).toBe(
      true
    ); // point inside
  });
  it("rejects disjoint windows", () => {
    expect(windowsOverlap({ start: 0, end: 60 }, { start: 61, end: 90 })).toBe(
      false
    );
  });
});

describe("proximityMatch", () => {
  it("matches within 10% on a compared dimension", () => {
    expect(
      proximityMatch(
        { duration_min: 30, distance_km: 5 },
        { duration_min: 32, distance_km: 5.2 }
      )
    ).toBe(true);
  });
  it("rejects when a compared dimension is outside tolerance", () => {
    expect(
      proximityMatch(
        { duration_min: 30, distance_km: 5 },
        { duration_min: 30, distance_km: 6 } // 20% off
      )
    ).toBe(false);
  });
  it("requires at least one comparable dimension", () => {
    expect(
      proximityMatch(
        { duration_min: null, distance_km: null },
        { duration_min: 30, distance_km: 5 }
      )
    ).toBe(false);
  });
  it("compares only the dimensions both rows provide", () => {
    // duration matches; distance only on one side → not compared, still a match.
    expect(
      proximityMatch(
        { duration_min: 30, distance_km: null },
        { duration_min: 31, distance_km: 5 }
      )
    ).toBe(true);
  });
});

describe("crossSource", () => {
  it("treats null as the 'manual' bucket", () => {
    expect(crossSource({ source: null }, { source: "strava" })).toBe(true);
    expect(crossSource({ source: null }, { source: null })).toBe(false);
    expect(crossSource({ source: "strava" }, { source: "strava" })).toBe(false);
    expect(
      crossSource({ source: "strava" }, { source: "health-connect" })
    ).toBe(true);
  });
});

describe("sameSourceDuplicate", () => {
  it("flags two rows of the same non-manual source with different external_ids", () => {
    expect(
      sameSourceDuplicate(
        { source: "strava", external_id: "strava:1" },
        { source: "strava", external_id: "strava:2" }
      )
    ).toBe(true);
  });
  it("rejects a same-external_id re-sync (never pairs a row with itself)", () => {
    expect(
      sameSourceDuplicate(
        { source: "strava", external_id: "strava:1" },
        { source: "strava", external_id: "strava:1" }
      )
    ).toBe(false);
  });
  it("rejects two manual rows (a deliberate user act)", () => {
    expect(
      sameSourceDuplicate(
        { source: null, external_id: null },
        { source: null, external_id: null }
      )
    ).toBe(false);
  });
  it("rejects different sources (that is the cross-source path)", () => {
    expect(
      sameSourceDuplicate(
        { source: "strava", external_id: "strava:1" },
        { source: "health-connect", external_id: "hc:1" }
      )
    ).toBe(false);
  });
  it("rejects a same-source pair when either external_id is missing", () => {
    expect(
      sameSourceDuplicate(
        { source: "strava", external_id: "strava:1" },
        { source: "strava", external_id: null }
      )
    ).toBe(false);
  });
});

describe("activityToken + pairSignature stability", () => {
  it("uses external_id when present, id otherwise", () => {
    expect(activityToken({ id: 5, external_id: "strava:123" })).toBe(
      "ext:strava:123"
    );
    expect(activityToken({ id: 5, external_id: null })).toBe("id:5");
  });
  it("is order-independent", () => {
    expect(pairSignature("id:5", "ext:strava:123")).toBe(
      pairSignature("ext:strava:123", "id:5")
    );
  });
  it("re-derives identically after a merge+re-sync gives the integration row a NEW id", () => {
    // Before merge: manual id=5, strava id=9 external_id 'strava:123'.
    const before = pairSignature(
      activityToken({ id: 5, external_id: null }),
      activityToken({ id: 9, external_id: "strava:123" })
    );
    // After merge deletes the strava row and re-sync re-inserts it with id=42,
    // its external_id is unchanged → same token → same signature.
    const after = pairSignature(
      activityToken({ id: 5, external_id: null }),
      activityToken({ id: 42, external_id: "strava:123" })
    );
    expect(after).toBe(before);
  });
});

describe("findActivityDuplicates", () => {
  it("flags a high-confidence cross-source pair by overlapping times", () => {
    const rows = [
      act({ id: 1, source: null, start_time: "08:00", end_time: "08:45" }),
      act({
        id: 2,
        source: "strava",
        external_id: "strava:1",
        start_time: "08:05",
        end_time: "08:50",
      }),
    ];
    const pairs = findActivityDuplicates(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("high");
    // Deterministic a/b order: token 'ext:strava:1' sorts before 'id:1'.
    expect(pairs[0].a.id).toBe(2);
    expect(pairs[0].b.id).toBe(1);
  });

  it("flags a high-confidence SAME-SOURCE pair by overlapping times (issue #64)", () => {
    // Upstream double-feed: Strava ingested one workout twice (different external_ids).
    const rows = [
      act({
        id: 1,
        source: "strava",
        external_id: "strava:garmin-1",
        start_time: "08:00",
        end_time: "08:45",
      }),
      act({
        id: 2,
        source: "strava",
        external_id: "strava:hc-1",
        start_time: "08:05",
        end_time: "08:50",
      }),
    ];
    const pairs = findActivityDuplicates(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("high");
    expect(pairs[0].reason).toMatch(/one source/);
  });

  it("does NOT flag a same-source pair at disjoint times", () => {
    const rows = [
      act({
        id: 1,
        source: "strava",
        external_id: "strava:1",
        start_time: "06:00",
        end_time: "06:30",
      }),
      act({
        id: 2,
        source: "strava",
        external_id: "strava:2",
        start_time: "18:00",
        end_time: "18:30",
      }),
    ];
    expect(findActivityDuplicates(rows)).toHaveLength(0);
  });

  it("does NOT apply the proximity fallback to same-source pairs (no clock times)", () => {
    // Two similar same-day sessions from one source with no windows are usually
    // legitimate — proximity alone must NOT flag them (contrast cross-source).
    const rows = [
      act({
        id: 1,
        source: "strava",
        external_id: "strava:1",
        duration_min: 30,
        distance_km: 5,
      }),
      act({
        id: 2,
        source: "strava",
        external_id: "strava:2",
        duration_min: 31,
        distance_km: 5.1,
      }),
    ];
    expect(findActivityDuplicates(rows)).toHaveLength(0);
  });

  it("does NOT flag two same-source rows sharing an external_id (a re-sync)", () => {
    const rows = [
      act({
        id: 1,
        source: "strava",
        external_id: "strava:1",
        start_time: "08:00",
        end_time: "08:45",
      }),
      act({
        id: 2,
        source: "strava",
        external_id: "strava:1",
        start_time: "08:00",
        end_time: "08:45",
      }),
    ];
    expect(findActivityDuplicates(rows)).toHaveLength(0);
  });

  it("does NOT flag two overlapping MANUAL rows (a deliberate user act)", () => {
    const rows = [
      act({ id: 1, source: null, start_time: "08:00", end_time: "08:45" }),
      act({ id: 2, source: null, start_time: "08:10", end_time: "08:55" }),
    ];
    expect(findActivityDuplicates(rows)).toHaveLength(0);
  });

  it("keeps a same-source pair's signature stable across a re-sync (issue #64)", () => {
    const before = findActivityDuplicates([
      act({
        id: 1,
        source: "strava",
        external_id: "strava:a",
        start_time: "08:00",
        end_time: "08:45",
      }),
      act({
        id: 2,
        source: "strava",
        external_id: "strava:b",
        start_time: "08:05",
        end_time: "08:50",
      }),
    ]);
    // Both rows re-inserted under fresh ids on the next rolling-window sync; their
    // external_ids (hence tokens, hence signature) are unchanged.
    const after = findActivityDuplicates([
      act({
        id: 91,
        source: "strava",
        external_id: "strava:a",
        start_time: "08:00",
        end_time: "08:45",
      }),
      act({
        id: 92,
        source: "strava",
        external_id: "strava:b",
        start_time: "08:05",
        end_time: "08:50",
      }),
    ]);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0].signature).toBe(before[0].signature);
  });

  it("does NOT flag two timed sessions at disjoint times", () => {
    const rows = [
      act({ id: 1, source: null, start_time: "06:00", end_time: "06:30" }),
      act({
        id: 2,
        source: "strava",
        external_id: "strava:1",
        start_time: "18:00",
        end_time: "18:30",
      }),
    ];
    expect(findActivityDuplicates(rows)).toHaveLength(0);
  });

  it("falls back to medium confidence via duration/distance proximity when times are missing", () => {
    const rows = [
      act({ id: 1, source: null, duration_min: 30, distance_km: 5 }),
      act({
        id: 2,
        source: "health-connect",
        external_id: "hc:1",
        duration_min: 31,
        distance_km: 5.1,
      }),
    ];
    const pairs = findActivityDuplicates(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("medium");
  });

  it("ignores same-external_id re-syncs and same-day-different-type pairs", () => {
    const rows = [
      // Two strava rows sharing an external_id — a re-sync, already deduped by the
      // unique index; NOT a same-source duplicate (issue #64 needs distinct ids).
      act({
        id: 1,
        source: "strava",
        external_id: "strava:1",
        start_time: "08:00",
        end_time: "08:30",
      }),
      act({
        id: 2,
        source: "strava",
        external_id: "strava:1",
        start_time: "08:00",
        end_time: "08:30",
      }),
      // Cross-source but different type → different bucket.
      act({
        id: 3,
        type: "strength",
        source: null,
        start_time: "08:00",
        end_time: "08:30",
      }),
    ];
    expect(findActivityDuplicates(rows)).toHaveLength(0);
  });

  it("orders high-confidence pairs before medium", () => {
    const rows = [
      // medium pair on 2026-07-09
      act({
        id: 10,
        date: "2026-07-09",
        source: null,
        duration_min: 40,
        distance_km: 8,
      }),
      act({
        id: 11,
        date: "2026-07-09",
        source: "strava",
        external_id: "strava:9",
        duration_min: 41,
        distance_km: 8.1,
      }),
      // high pair on 2026-07-08
      act({ id: 1, source: null, start_time: "08:00", end_time: "08:30" }),
      act({
        id: 2,
        source: "strava",
        external_id: "strava:1",
        start_time: "08:00",
        end_time: "08:30",
      }),
    ];
    const pairs = findActivityDuplicates(rows);
    expect(pairs.map((p) => p.confidence)).toEqual(["high", "medium"]);
  });
});

describe("body-metric conflict detection", () => {
  it("bodyMetricToken uses source@date when sourced, id otherwise", () => {
    expect(
      bodyMetricToken({ id: 3, date: "2026-07-08", source: "health-connect" })
    ).toBe("bm:health-connect@2026-07-08");
    expect(bodyMetricToken({ id: 3, date: "2026-07-08", source: null })).toBe(
      "id:3"
    );
  });

  it("sharedMeasures lists only measures both rows report", () => {
    expect(
      sharedMeasures(
        bm({ weight_kg: 70, resting_hr: 55 }),
        bm({ weight_kg: 71, body_fat_pct: 18 })
      )
    ).toEqual(["weight"]);
  });

  it("flags same-day rows sharing a measure (including duplicate manual rows)", () => {
    const rows = [
      bm({ id: 1, source: null, weight_kg: 70 }),
      bm({ id: 2, source: "health-connect", weight_kg: 70.2 }),
      // A second manual weigh-in the same day → duplicate manual rows are flagged.
      bm({ id: 3, source: null, weight_kg: 69.8 }),
    ];
    const pairs = findBodyMetricConflicts(rows);
    // 3 rows all sharing weight → 3 pairs (1-2, 1-3, 2-3).
    expect(pairs).toHaveLength(3);
    for (const p of pairs) expect(p.measures).toContain("weight");
  });

  it("does not flag rows that share no measure", () => {
    const rows = [
      bm({ id: 1, source: null, weight_kg: 70 }),
      bm({ id: 2, source: "health-connect", resting_hr: 55 }),
    ];
    expect(findBodyMetricConflicts(rows)).toHaveLength(0);
  });
});

describe("undecidedPairs (decision durability)", () => {
  it("drops pairs whose signature is already decided", () => {
    const pairs = [{ signature: "a|b" }, { signature: "c|d" }];
    const decided = new Set(["a|b"]);
    expect(undecidedPairs(pairs, decided)).toEqual([{ signature: "c|d" }]);
  });

  it("keeps a resolved integration pair suppressed after a re-sync renumbers the row", () => {
    const manual = act({ id: 5, source: null, duration_min: 30 });
    const stravaBefore = act({
      id: 9,
      source: "strava",
      external_id: "strava:1",
      duration_min: 31,
    });
    const sig = findActivityDuplicates([manual, stravaBefore])[0].signature;
    const decided = new Set([sig]);

    // Next sync re-inserts the strava row with a fresh id (42).
    const stravaAfter = act({
      id: 42,
      source: "strava",
      external_id: "strava:1",
      duration_min: 31,
    });
    const redetected = findActivityDuplicates([manual, stravaAfter]);
    expect(redetected).toHaveLength(1);
    expect(undecidedPairs(redetected, decided)).toHaveLength(0);
  });
});

describe("foldActivityFields", () => {
  it("keeps the keeper's value and fills gaps from the discarded row", () => {
    const keep = { notes: "hard run", duration_min: 30, distance_km: null };
    const drop = { notes: "easy", duration_min: 99, distance_km: 5 };
    const folded = foldActivityFields(keep, drop);
    expect(folded.notes).toBe("hard run"); // keeper wins
    expect(folded.duration_min).toBe(30); // keeper wins
    expect(folded.distance_km).toBe(5); // filled from drop
    expect(folded.avg_hr).toBeNull(); // absent on both
  });

  // Issue #93: a stored 0 on a measurement column is a source's "didn't record
  // it" filler, not data — the other row's real value must win the fold.
  it("treats a zero measurement as missing so the other row's value wins", () => {
    const keep = { distance_km: 0, duration_min: 30, avg_hr: 0 };
    const drop = { distance_km: 8.2, duration_min: 0, avg_hr: null };
    const folded = foldActivityFields(keep, drop);
    expect(folded.distance_km).toBe(8.2); // keeper's 0 is a gap → filled
    expect(folded.duration_min).toBe(30); // real keeper value still wins
    expect(folded.avg_hr).toBe(0); // no real value on either → keeper's stored 0 preserved
  });

  it("keeps legitimate zeroes on non-measurement columns", () => {
    const keep = { avg_temp_c: 0, workout_type: 0 };
    const drop = { avg_temp_c: 21, workout_type: 3 };
    const folded = foldActivityFields(keep, drop);
    expect(folded.avg_temp_c).toBe(0); // 0 °C is a real reading
    expect(folded.workout_type).toBe(0); // 0 is a meaningful enum value
  });
});

describe("activityRichness + preferActivityKeeper", () => {
  it("counts populated fold-fields", () => {
    expect(activityRichness({ notes: "x", duration_min: 30 })).toBe(2);
    expect(activityRichness({})).toBe(0);
  });

  it("zero-filled measurement columns don't count toward richness (#93)", () => {
    // A source row padded with zeroes must not out-rich a manual row with real
    // values — that default steers the merge into the lossy fold.
    const zeroPadded = { distance_km: 0, avg_hr: 0, avg_power_w: 0 };
    const real = { distance_km: 8.2, notes: "tempo" };
    expect(activityRichness(zeroPadded)).toBe(0);
    expect(activityRichness(real)).toBe(2);
  });

  it("prefers the integration row over a manual one", () => {
    const manual = { id: 5, source: null };
    const strava = { id: 9, source: "strava", duration_min: 30 };
    expect(preferActivityKeeper(manual, strava)).toBe(9);
    expect(preferActivityKeeper(strava, manual)).toBe(9);
  });

  it("breaks a same-provenance tie by richness then lower id", () => {
    const a = { id: 5, source: "strava", notes: "x", duration_min: 1 };
    const b = { id: 9, source: "strava", notes: "y" };
    expect(preferActivityKeeper(a, b)).toBe(5); // richer
    const c = { id: 5, source: null };
    const d = { id: 9, source: null };
    expect(preferActivityKeeper(c, d)).toBe(5); // tie → lower id
  });
});

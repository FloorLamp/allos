import { describe, it, expect } from "vitest";
import {
  parseMinutesOfDay,
  activityWindow,
  windowsOverlap,
  proximityMatch,
  proximityComparisons,
  clockOffsetMinutes,
  formatClockOffset,
  MAX_CLOCK_OFFSET_MIN,
  MIN_CLOCK_OFFSET_MIN,
  CLOCK_OFFSET_MINUTE_PARTS,
  clusterActivityDuplicates,
  autoMergeCluster,
  crossSource,
  sameSourceDuplicate,
  activityToken,
  pairSignature,
  findActivityDuplicates,
  activityWindowFrom,
  crossMidnightCandidate,
  EVENING_CANDIDATE_CLOCK,
  MORNING_CANDIDATE_CLOCK,
  bodyMetricToken,
  sharedMeasures,
  conflictingMeasures,
  findBodyMetricConflicts,
  undecidedPairs,
  suppressingSignatures,
  foldActivityFields,
  activityRichness,
  preferActivityKeeper,
  type ActivityDupInput,
  type BodyMetricConflictInput,
} from "@/lib/import-review/detect";
import { MINUTES_PER_DAY } from "@/lib/clock-skew";

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

  it("flags a same-source pair whose provider typed the SAME session two ways", () => {
    // Health Connect can hold ONE bike ride twice, written by the same app seconds
    // apart, typed OTHER_WORKOUT on one record and BIKING on the other — so the two
    // rows classify to different ActivityTypes. Grouping candidates by (date, type)
    // put them in separate buckets and never compared them, and the ride
    // double-counted in every distance rollup with nothing surfaced in Review.
    const rows = [
      act({
        id: 1,
        type: "sport",
        source: "health-connect",
        external_id: "health-connect:2026-07-24T14:28:47Z",
        start_time: "10:28",
        end_time: "12:29",
      }),
      act({
        id: 2,
        type: "cardio",
        source: "health-connect",
        external_id: "health-connect:2026-07-24T14:29:05Z",
        start_time: "10:29",
        end_time: "12:29",
      }),
    ];
    const pairs = findActivityDuplicates(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("high");
    expect(pairs[0].reason).toMatch(/one source/);
  });

  it("still does NOT pair two same-source sessions of different types at disjoint times", () => {
    // Dropping the type gate for same-source pairs is safe ONLY because overlapping
    // windows remain required: a morning run and an evening swim from one provider
    // must stay two activities.
    const rows = [
      act({
        id: 1,
        type: "cardio",
        source: "health-connect",
        external_id: "health-connect:a",
        start_time: "06:00",
        end_time: "06:30",
      }),
      act({
        id: 2,
        type: "sport",
        source: "health-connect",
        external_id: "health-connect:b",
        start_time: "18:00",
        end_time: "18:30",
      }),
    ];
    expect(findActivityDuplicates(rows)).toHaveLength(0);
  });

  it("keeps the type gate on the CROSS-source path (proximity would over-pair)", () => {
    // Cross-source also matches on mere proximity (10% duration/distance), so without
    // a type check a 30-minute run would pair with a 30-minute swim.
    const rows = [
      act({
        id: 1,
        type: "cardio",
        source: null,
        start_time: "08:00",
        end_time: "08:30",
      }),
      act({
        id: 2,
        type: "sport",
        source: "strava",
        external_id: "strava:1",
        start_time: "08:05",
        end_time: "08:35",
      }),
    ];
    expect(findActivityDuplicates(rows)).toHaveLength(0);
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

describe("clockOffsetMinutes (#2011, widened by #2063)", () => {
  it("reports a 1h and a 2h whole-hour start gap, in minutes", () => {
    expect(
      clockOffsetMinutes({ start: 545, end: 570 }, { start: 485, end: 510 })
    ).toBe(60);
    expect(
      clockOffsetMinutes({ start: 485, end: 510 }, { start: 605, end: 630 })
    ).toBe(120);
  });

  // The bug (#2063): every one of these is a real pair of UTC offsets one provider
  // can resolve instead of the other, and the old `gap % 60 !== 0` guard rejected
  // all of them.
  it.each([
    ["India +5:30 read as +5:00 or +6:00", 30],
    ["Nepal +5:45 read as +5:00", 45],
    ["Newfoundland -3:30 read as -2:00", 90],
    ["Chatham +12:45 read as +11:00", 105],
  ])("admits the fractional offset gap: %s", (_zone, gap) => {
    expect(
      clockOffsetMinutes(
        { start: 545, end: 570 },
        { start: 545 - gap, end: 570 - gap }
      )
    ).toBe(gap);
  });

  it("still rejects a gap no pair of UTC offsets could produce", () => {
    // 40 and 20 minutes apart: two sessions, not one session twice.
    expect(
      clockOffsetMinutes({ start: 545, end: 570 }, { start: 505, end: 530 })
    ).toBeNull();
    expect(
      clockOffsetMinutes({ start: 545, end: 570 }, { start: 465, end: 490 })
    ).toBeNull();
  });

  it("rejects the quarter hour — the documented out-of-scope residual", () => {
    // Chatham read as +13:00 is a real 15-minute misresolution, but :15 is also the
    // grid people schedule on, so the safety margin wins (see the constant's note).
    expect(CLOCK_OFFSET_MINUTE_PARTS).not.toContain(15);
    expect(
      clockOffsetMinutes({ start: 545, end: 570 }, { start: 530, end: 555 })
    ).toBeNull();
  });

  it("rejects a zero gap and anything past the maximum", () => {
    // Zero is the only offset-shaped gap below MIN_CLOCK_OFFSET_MIN, and it means
    // "the two clocks agree" — same-instant rows are the OVERLAP path's business.
    expect(MIN_CLOCK_OFFSET_MIN).toBe(30);
    expect(
      clockOffsetMinutes({ start: 545, end: 570 }, { start: 545, end: 575 })
    ).toBeNull();
    expect(
      clockOffsetMinutes(
        { start: 545, end: 570 },
        { start: 545 + MAX_CLOCK_OFFSET_MIN + 60, end: 570 }
      )
    ).toBeNull();
  });
});

describe("formatClockOffset", () => {
  it("keeps the whole hour's historical spelling and names the fractions", () => {
    expect(formatClockOffset(60)).toBe("1h");
    expect(formatClockOffset(120)).toBe("2h");
    expect(formatClockOffset(30)).toBe("30m");
    expect(formatClockOffset(45)).toBe("45m");
    expect(formatClockOffset(90)).toBe("1h30m");
    expect(formatClockOffset(105)).toBe("1h45m");
  });
});

describe("proximityComparisons", () => {
  it("counts the agreeing dimensions and returns null on a disagreement", () => {
    expect(
      proximityComparisons(
        { duration_min: 25, distance_km: 2.1 },
        { duration_min: 25, distance_km: 2.11 }
      )
    ).toBe(2);
    expect(
      proximityComparisons(
        { duration_min: 25, distance_km: null },
        { duration_min: 26, distance_km: 2.1 }
      )
    ).toBe(1);
    expect(
      proximityComparisons(
        { duration_min: 25, distance_km: 2.1 },
        { duration_min: 25, distance_km: 4 }
      )
    ).toBeNull();
    expect(
      proximityComparisons(
        { duration_min: null, distance_km: null },
        { duration_min: 25, distance_km: 2.1 }
      )
    ).toBe(0);
  });
});

// The reported case (#2011): one 25-minute walk imported from Health Connect and
// from Strava, whose copy carries a non-DST utc_offset and so lands exactly an hour
// early. The windows miss by 35 minutes, which used to be a final `return null` —
// the day then carried the walk twice in every distance/effort rollup.
describe("findActivityDuplicates — wrong-offset clock rescue (#2011)", () => {
  const hc = act({
    id: 1,
    source: "health-connect",
    external_id: "hc:walk-1",
    start_time: "09:05",
    end_time: "09:30",
    duration_min: 25,
    distance_km: 2.1,
  });
  // Same walk, one hour early. Zeroed max speed / elevation are the fingerprint of a
  // third-party push into Strava, which is where the bad offset comes from.
  const stravaOffset = act({
    id: 2,
    source: "strava",
    external_id: "strava:walk-1",
    start_time: "08:05",
    end_time: "08:30",
    duration_min: 25,
    distance_km: 2.11,
  });

  it("pairs the non-overlapping cross-source copies at MEDIUM and names the offset", () => {
    const pairs = findActivityDuplicates([hc, stravaOffset]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("medium");
    expect(pairs[0].reason).toBe(
      "Same day, similar duration/distance — clocks differ by 1h"
    );
  });

  it("pairs a two-hour offset too, and names it", () => {
    const pairs = findActivityDuplicates([
      hc,
      { ...stravaOffset, start_time: "07:05", end_time: "07:30" },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reason).toBe(
      "Same day, similar duration/distance — clocks differ by 2h"
    );
  });

  // #2063: the same walk on an Asia/Kolkata profile, one provider resolving +5:30 and
  // the other +5:00. The gap is 30 minutes — offset-shaped, and rejected outright
  // before this, so the day carried the walk twice for every household in a
  // half-hour zone.
  it("pairs a HALF-hour offset — India, Newfoundland — and names it", () => {
    const pairs = findActivityDuplicates([
      hc,
      { ...stravaOffset, start_time: "08:35", end_time: "09:00" },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("medium");
    expect(pairs[0].reason).toBe(
      "Same day, similar duration/distance — clocks differ by 30m"
    );
  });

  it("pairs a THREE-QUARTER offset — Chatham +12:45 read as +11:00 — and names it", () => {
    const pairs = findActivityDuplicates([
      hc,
      { ...stravaOffset, start_time: "07:20", end_time: "07:45" },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reason).toBe(
      "Same day, similar duration/distance — clocks differ by 1h45m"
    );
  });

  it("does NOT pair when the gap is not offset-shaped", () => {
    expect(
      findActivityDuplicates([
        hc,
        { ...stravaOffset, start_time: "08:25", end_time: "08:50" },
      ])
    ).toHaveLength(0);
  });

  it("does NOT pair beyond MAX_CLOCK_OFFSET_MIN", () => {
    expect(
      findActivityDuplicates([
        hc,
        { ...stravaOffset, start_time: "06:05", end_time: "06:30" },
      ])
    ).toHaveLength(0);
  });

  it("does NOT pair on one comparable measure alone", () => {
    expect(
      findActivityDuplicates([{ ...hc, distance_km: null }, stravaOffset])
    ).toHaveLength(0);
  });

  it("does NOT pair when duration or distance actually disagree", () => {
    expect(
      findActivityDuplicates([hc, { ...stravaOffset, distance_km: 4.2 }])
    ).toHaveLength(0);
  });

  it("does NOT rescue a SAME-source whole-hour pair — one source is one clock", () => {
    expect(
      findActivityDuplicates([
        { ...hc, source: "strava", external_id: "strava:walk-a" },
        { ...stravaOffset, external_id: "strava:walk-b" },
      ])
    ).toHaveLength(0);
  });

  it("does NOT pair two genuinely distinct sessions an hour apart at different minutes", () => {
    expect(
      findActivityDuplicates([
        act({
          id: 1,
          source: null,
          start_time: "08:00",
          end_time: "08:25",
          duration_min: 25,
          distance_km: 2.1,
        }),
        act({
          id: 2,
          source: "strava",
          external_id: "strava:pm",
          start_time: "09:12",
          end_time: "09:37",
          duration_min: 25,
          distance_km: 2.1,
        }),
      ])
    ).toHaveLength(0);
  });

  it("leaves the rescued pair for a human — autoMergeCluster refuses non-overlapping windows", () => {
    const pairs = findActivityDuplicates([hc, stravaOffset]);
    const cluster = clusterActivityDuplicates(pairs)[0];
    expect(cluster.confidence).toBe("medium");
    expect(autoMergeCluster(cluster.members)).toBeNull();
  });
});

// #2056. The rescue above compares two clocks; everything that FED it grouped
// candidates by calendar DATE, so a provider whose wrong offset pushes a
// late-evening session across midnight filed the two copies under different days and
// the classifier never saw the pair. Same defect, one date apart.
describe("findActivityDuplicates — the offset that crosses midnight (#2056)", () => {
  // The reported case: a 23:30 session, its copy reported at 00:30 the next day.
  const evening = act({
    id: 1,
    date: "2026-07-08",
    source: "health-connect",
    external_id: "hc:night-1",
    start_time: "23:30",
    end_time: "23:55",
    duration_min: 25,
    distance_km: 2.1,
  });
  const nextMorningCopy = act({
    id: 2,
    date: "2026-07-09",
    source: "strava",
    external_id: "strava:night-1",
    start_time: "00:30",
    end_time: "00:55",
    duration_min: 25,
    distance_km: 2.11,
  });

  it("measures both windows from ONE midnight", () => {
    // 23:30 on the base day, and 00:30 the NEXT day as minute 1470 — an hour later,
    // not 23 hours earlier, which is the arithmetic the whole rescue turns on.
    expect(activityWindowFrom(evening, evening.date)).toEqual({
      start: 1410,
      end: 1435,
    });
    expect(activityWindowFrom(nextMorningCopy, evening.date)).toEqual({
      start: MINUTES_PER_DAY + 30,
      end: MINUTES_PER_DAY + 55,
    });
  });

  it("pairs the copies at MEDIUM and says the pair crosses midnight", () => {
    const pairs = findActivityDuplicates([evening, nextMorningCopy]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("medium");
    expect(pairs[0].reason).toBe(
      "Across midnight, similar duration/distance — clocks differ by 1h"
    );
    // Both copies are in it, whichever way the tokens sorted.
    expect([pairs[0].a.id, pairs[0].b.id].sort()).toEqual([1, 2]);
  });

  it("names the cluster by the day the session STARTED", () => {
    const cluster = clusterActivityDuplicates(
      findActivityDuplicates([evening, nextMorningCopy])
    )[0];
    expect(cluster.date).toBe("2026-07-08");
    expect(cluster.members).toHaveLength(2);
  });

  it("still leaves it for a human — the windows do not genuinely overlap", () => {
    const cluster = clusterActivityDuplicates(
      findActivityDuplicates([evening, nextMorningCopy])
    )[0];
    expect(autoMergeCluster(cluster.members)).toBeNull();
  });

  it("does NOT pair two genuinely distinct next-day sessions", () => {
    // A late run and a mid-morning one the next day: adjacent days, same type, two
    // sources — and nowhere near the midnight between them, so never a candidate.
    expect(
      findActivityDuplicates([
        evening,
        { ...nextMorningCopy, start_time: "09:30", end_time: "09:55" },
      ])
    ).toHaveLength(0);
    // …and an evening session that is not near midnight either.
    expect(
      findActivityDuplicates([
        { ...evening, start_time: "19:30", end_time: "19:55" },
        { ...nextMorningCopy, start_time: "20:30", end_time: "20:55" },
      ])
    ).toHaveLength(0);
  });

  it("does NOT pair across midnight when the gap is not offset-shaped", () => {
    // 23:30 → 00:05 is 35 minutes: near midnight, but no UTC offset differs by it.
    expect(
      findActivityDuplicates([
        evening,
        { ...nextMorningCopy, start_time: "00:05", end_time: "00:30" },
      ])
    ).toHaveLength(0);
  });

  it("does NOT rescue a SAME-source pair across midnight", () => {
    // One source is one clock, so an hour between its two rows is an hour of the
    // person's actual day — the same stance the same-day path takes.
    expect(
      findActivityDuplicates([
        { ...evening, source: "strava", external_id: "strava:night-a" },
        { ...nextMorningCopy, external_id: "strava:night-b" },
      ])
    ).toHaveLength(0);
  });

  it("does NOT pair across midnight when the types differ", () => {
    expect(
      findActivityDuplicates([
        evening,
        { ...nextMorningCopy, type: "strength" },
      ])
    ).toHaveLength(0);
  });

  it("does NOT reach a day further than one", () => {
    expect(
      findActivityDuplicates([
        evening,
        { ...nextMorningCopy, date: "2026-07-10" },
      ])
    ).toHaveLength(0);
  });

  // The widening is a CANDIDATE gate, and a candidate gate that grows without bound
  // is a scan of the whole history. Pin what it admits.
  describe("crossMidnightCandidate is bounded to the near-midnight window", () => {
    const at = (date: string, start_time: string) => ({ date, start_time });

    it("admits only adjacent days, in either order", () => {
      expect(
        crossMidnightCandidate(
          at("2026-07-08", "23:30"),
          at("2026-07-09", "00:30")
        )
      ).toBe(true);
      expect(
        crossMidnightCandidate(
          at("2026-07-09", "00:30"),
          at("2026-07-08", "23:30")
        )
      ).toBe(true);
      expect(
        crossMidnightCandidate(
          at("2026-07-08", "23:30"),
          at("2026-07-08", "23:50")
        )
      ).toBe(false);
      expect(
        crossMidnightCandidate(
          at("2026-07-08", "23:30"),
          at("2026-07-10", "00:30")
        )
      ).toBe(false);
    });

    it("admits exactly the MAX_CLOCK_OFFSET_MIN band either side of midnight", () => {
      // The thresholds are DERIVED from the offset the rescue would forgive, so the
      // candidate set can never be wider than the classifier's own reach.
      expect(EVENING_CANDIDATE_CLOCK).toBe("22:00");
      expect(MORNING_CANDIDATE_CLOCK).toBe("02:00");
      expect(
        crossMidnightCandidate(
          at("2026-07-08", "22:00"),
          at("2026-07-09", "02:00")
        )
      ).toBe(true);
      expect(
        crossMidnightCandidate(
          at("2026-07-08", "21:59"),
          at("2026-07-09", "02:00")
        )
      ).toBe(false);
      expect(
        crossMidnightCandidate(
          at("2026-07-08", "22:00"),
          at("2026-07-09", "02:01")
        )
      ).toBe(false);
    });

    it("admits nothing without a clock on BOTH sides", () => {
      expect(
        crossMidnightCandidate(
          { date: "2026-07-08", start_time: null },
          at("2026-07-09", "00:30")
        )
      ).toBe(false);
      expect(
        crossMidnightCandidate(at("2026-07-08", "23:30"), {
          date: "2026-07-09",
          start_time: null,
        })
      ).toBe(false);
    });
  });

  it("does not multiply the candidate pairs on an ordinary week", () => {
    // Seven consecutive days, each carrying a manual and a Strava evening session at
    // ordinary hours. That is 7 same-day cross-source buckets and 6 adjacent-day
    // ones; NONE of the latter may become a pair, so the detection count is exactly
    // the same-day answer and the widening costs nothing on real data.
    const rows: ActivityDupInput[] = [];
    for (let i = 0; i < 7; i++) {
      const date = `2026-07-0${i + 1}`;
      rows.push(
        act({
          id: i * 2 + 1,
          date,
          source: null,
          start_time: "18:00",
          end_time: "18:30",
          duration_min: 30,
          distance_km: 5,
        }),
        act({
          id: i * 2 + 2,
          date,
          source: "strava",
          external_id: `strava:day-${i}`,
          start_time: "18:05",
          end_time: "18:35",
          duration_min: 30,
          distance_km: 5.05,
        })
      );
    }
    const pairs = findActivityDuplicates(rows);
    expect(pairs).toHaveLength(7);
    expect(pairs.every((p) => p.a.date === p.b.date)).toBe(true);
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

  // #1615: body_metrics keeps one row per (profile_id, date, source) on purpose (#14),
  // so two SOURCES agreeing on a day is normal multi-source storage — there is nothing
  // for the user to decide, and the destructive merge would throw away provenance.
  describe("exact-equal cross-source overlap is equivalence, not conflict", () => {
    it("omits a cross-source pair whose shared measure is exactly equal", () => {
      const rows = [
        bm({ id: 1, source: "health-connect", resting_hr: 55 }),
        bm({ id: 2, source: "oura", resting_hr: 55 }),
      ];
      expect(findBodyMetricConflicts(rows)).toHaveLength(0);
      expect(conflictingMeasures(rows[0], rows[1])).toEqual([]);
      // The overlap itself is still reported — only the CONFLICT is empty.
      expect(sharedMeasures(rows[0], rows[1])).toEqual(["resting HR"]);
    });

    it("keeps a cross-source pair whose shared measure differs", () => {
      const rows = [
        bm({ id: 1, source: "health-connect", resting_hr: 55 }),
        bm({ id: 2, source: "oura", resting_hr: 56 }),
      ];
      const pairs = findBodyMetricConflicts(rows);
      expect(pairs).toHaveLength(1);
      expect(pairs[0].measures).toEqual(["resting HR"]);
    });

    it("names only the disagreeing measure when another shared measure is equal", () => {
      const rows = [
        bm({ id: 1, source: "health-connect", resting_hr: 55, weight_kg: 70 }),
        bm({ id: 2, source: "withings", resting_hr: 55, weight_kg: 70.4 }),
      ];
      const pairs = findBodyMetricConflicts(rows);
      expect(pairs).toHaveLength(1);
      expect(pairs[0].measures).toEqual(["weight"]);
      expect(pairs[0].reason).toBe("Same-day weight from two rows");
    });

    it("still reviews two equal MANUAL rows — duplicate records, not multi-source", () => {
      const rows = [
        bm({ id: 1, source: null, resting_hr: 55 }),
        bm({ id: 2, source: null, resting_hr: 55 }),
      ];
      const pairs = findBodyMetricConflicts(rows);
      expect(pairs).toHaveLength(1);
      expect(pairs[0].measures).toEqual(["resting HR"]);
    });

    it("still reviews two equal rows from ONE source — upstream double-feed", () => {
      const rows = [
        bm({ id: 1, source: "health-connect", weight_kg: 70 }),
        bm({ id: 2, source: "health-connect", weight_kg: 70 }),
      ];
      expect(findBodyMetricConflicts(rows)).toHaveLength(1);
    });

    it("uses exact equality — no tolerance", () => {
      const rows = [
        bm({ id: 1, source: "health-connect", weight_kg: 70 }),
        bm({ id: 2, source: "withings", weight_kg: 70.01 }),
      ];
      expect(findBodyMetricConflicts(rows)).toHaveLength(1);
    });
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

describe("suppressingSignatures (#507 — merged never silences a re-formed pair)", () => {
  it("keeps kept-both / dismissed but EXCLUDES merged", () => {
    const decisions = new Map<string, "merged" | "kept-both" | "dismissed">([
      ["a|b", "merged"],
      ["c|d", "kept-both"],
      ["e|f", "dismissed"],
    ]);
    const set = suppressingSignatures(decisions);
    expect(set.has("a|b")).toBe(false); // merged resurfaces
    expect(set.has("c|d")).toBe(true);
    expect(set.has("e|f")).toBe(true);
  });

  it("a re-formed merged pair is NOT suppressed (resurfaces in Review)", () => {
    // The absorbed strava row was merged into the manual keeper; a resync re-inserted
    // it, so BOTH rows exist again and the detector re-forms the pair.
    const manual = act({ id: 5, source: null, duration_min: 30 });
    const strava = act({
      id: 9,
      source: "strava",
      external_id: "strava:1",
      duration_min: 31,
    });
    const pair = findActivityDuplicates([manual, strava])[0];
    const decided = suppressingSignatures(
      new Map([[pair.signature, "merged"]])
    );
    // undecidedPairs with the merged-excluded set keeps the pair visible.
    expect(
      undecidedPairs(findActivityDuplicates([manual, strava]), decided)
    ).toHaveLength(1);
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

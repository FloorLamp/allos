// DB INTEGRATION TIER — same-source duplicate detection through the real loader
// (issue #64). The pure suite (lib/__tests__/import-review.test.ts) covers the
// detection math; this file proves the SQL PRE-FILTER in loadActivityDupRows
// (lib/queries/integrations.ts) actually lets same-source buckets through to the
// detector. That pre-filter is the risk: it used to keep only buckets spanning >1
// provenance, so a bucket of two `strava` rows would never reach detection. Runs
// against a real (temp) SQLite handle via vitest.db.config.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { getActivityDuplicates } from "@/lib/queries";

let profileId: number;

const insAct = db.prepare(
  `INSERT INTO activities
     (profile_id, date, type, title, source, external_id,
      start_time, end_time, duration_min, distance_km)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('SAMESRC')").run()
      .lastInsertRowid
  );

  // (1) Same-source overlapping pair — upstream double-feed (two strava rows,
  // distinct external_ids, overlapping clock windows). MUST surface.
  insAct.run(
    profileId,
    "2026-07-01",
    "cardio",
    "Garmin run",
    "strava",
    "strava:garmin-1",
    "08:00",
    "08:45",
    45,
    8
  );
  insAct.run(
    profileId,
    "2026-07-01",
    "cardio",
    "HC run",
    "strava",
    "strava:hc-1",
    "08:05",
    "08:50",
    45,
    8
  );

  // (2) Same-source at DISJOINT times — two legitimate sessions. MUST NOT surface.
  insAct.run(
    profileId,
    "2026-07-02",
    "cardio",
    "AM ride",
    "strava",
    "strava:am",
    "06:00",
    "06:30",
    30,
    10
  );
  insAct.run(
    profileId,
    "2026-07-02",
    "cardio",
    "PM ride",
    "strava",
    "strava:pm",
    "18:00",
    "18:30",
    30,
    10
  );

  // (3) Two MANUAL rows overlapping — a deliberate user act. MUST NOT surface.
  insAct.run(
    profileId,
    "2026-07-03",
    "cardio",
    "Manual A",
    null,
    null,
    "08:00",
    "08:45",
    45,
    null
  );
  insAct.run(
    profileId,
    "2026-07-03",
    "cardio",
    "Manual B",
    null,
    null,
    "08:10",
    "08:55",
    45,
    null
  );

  // (4) Cross-source overlapping pair (the classic #59 case) — MUST still surface.
  insAct.run(
    profileId,
    "2026-07-04",
    "cardio",
    "Morning run",
    null,
    null,
    "07:00",
    "07:40",
    40,
    6
  );
  insAct.run(
    profileId,
    "2026-07-04",
    "cardio",
    "Afternoon Run",
    "strava",
    "strava:x-1",
    "07:05",
    "07:45",
    40,
    6
  );
});

describe("same-source duplicate detection (issue #64)", () => {
  it("surfaces the same-source overlapping pair through the loader pre-filter", () => {
    const pairs = getActivityDuplicates(profileId);
    const day1 = pairs.filter((p) => p.a.date === "2026-07-01");
    expect(day1).toHaveLength(1);
    expect(day1[0].confidence).toBe("high");
    const sources = [day1[0].a.source, day1[0].b.source];
    expect(sources).toEqual(["strava", "strava"]);
  });

  it("does not surface disjoint same-source, two manual, but keeps cross-source", () => {
    const pairs = getActivityDuplicates(profileId);
    const days = new Set(pairs.map((p) => p.a.date));
    expect(days.has("2026-07-02")).toBe(false); // disjoint same-source
    expect(days.has("2026-07-03")).toBe(false); // two manual
    expect(days.has("2026-07-04")).toBe(true); // cross-source still works
  });
});

// DB INTEGRATION TIER — condition read-layer collapse must not hide an ACTIVE
// condition behind a resolved same-name twin (#193).
//
// Two distinct same-name UNCODED conditions (a resolved older entry + a newer
// active recurrence, both manual) collapse to ONE representative on the shared
// (profile_id, code-or-name) identity. Before #193 the representative was chosen by
// (manual-over-imported, newest) only, and the status filter ran AFTER dedup — so a
// resolved representative could win the slot and an "active" filtered view would be
// EMPTIED even though an active twin existed. The fix (a) ranks an active row into
// the representative slot first, and (c) pushes the status filter INTO the
// representative selection so a filtered view is chosen from only matching rows.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Names are
// SYNTHETIC (no PHI).

import { describe, it, expect, beforeAll } from "vitest";
import { getConditions } from "@/lib/queries";
import { searchAll } from "@/lib/queries/search";
import { getTimelineEvents } from "@/lib/timeline";
import { db } from "@/lib/db";

const NAME = "Synthetic recurrent bronchitis"; // clearly-fake, uncoded condition

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Insert a MANUAL (document_id NULL, external_id NULL), UNCODED condition row.
function insertManualCondition(
  profileId: number,
  status: string,
  onset: string,
  resolved: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO conditions (profile_id, name, status, onset_date, resolved_date)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, NAME, status, onset, resolved).lastInsertRowid
  );
}

let profileId: number;
let resolvedId: number;
let activeId: number;

beforeAll(() => {
  profileId = newProfile("COND-STATUS");
  // Resolved 2015 entry inserted FIRST (lower id), active 2023 recurrence second
  // (higher id). Same uncoded name → they collapse to one representative group.
  resolvedId = insertManualCondition(
    profileId,
    "resolved",
    "2015-02-01",
    "2015-03-15"
  );
  activeId = insertManualCondition(profileId, "active", "2023-11-01", null);
});

describe("condition collapse never hides an active same-name twin (#193)", () => {
  it("unfiltered list shows ONE row, preferring the active twin", () => {
    const rows = getConditions(profileId).filter((c) => c.name === NAME);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(activeId);
    expect(rows[0].status).toBe("active");
  });

  it("active-filtered view shows the ACTIVE row (not empty)", () => {
    const rows = getConditions(profileId, { status: "active" }).filter(
      (c) => c.name === NAME
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(activeId);
    expect(rows[0].status).toBe("active");
  });

  it("resolved-filtered view still surfaces the resolved twin (filter applied before collapse)", () => {
    const rows = getConditions(profileId, { status: "resolved" }).filter(
      (c) => c.name === NAME
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(resolvedId);
    expect(rows[0].status).toBe("resolved");
  });

  it("Timeline (shared dedup) shows one condition event, the active one", () => {
    const events = getTimelineEvents(profileId).filter(
      (e) => e.category === "condition" && e.title === NAME
    );
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(`condition:${activeId}`);
  });

  it("Search (shared dedup) returns one condition hit, the active one", () => {
    const groups = searchAll(profileId, "Synthetic recurrent bronchitis");
    const conditionHits = groups
      .filter((g) => g.domain === "condition")
      .flatMap((g) => g.hits)
      .filter((h) => h.title === NAME);
    expect(conditionHits).toHaveLength(1);
    expect(conditionHits[0].key).toBe(`condition:${activeId}`);
  });
});

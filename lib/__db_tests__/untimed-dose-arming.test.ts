// DB INTEGRATION TIER — a taken administration that states NO instant (issue #4686).
//
// THE POPULATION THIS IS ABOUT. A past-day check-off writes `occurred_at = NULL`: the
// tap states which DAY the dose belongs to and nothing about the minute. Before this
// change every arming read coalesced that column onto `recorded_at` — when the app was
// TOLD — so the interval clock computed "6h since the last dose" from a capture stamp,
// and the answer was permissive by construction: a caregiver who skipped the 8pm
// ibuprofen and gave it at 01:30 was pushed "Redose window open" at 02:10.
//
// WHY THIS TIER, AND WHY A FILE OF ITS OWN. The tree had NO taken row with
// `occurred_at IS NULL` exercising the arming clock at all, which is how three one-line
// safety deletions survived all of the db suite during an earlier attempt. Every claim
// here is about a SQL predicate over `intake_item_logs` plus the orchestrator that
// reads it, and the two rows it must tell apart — a dose that states its minute and one
// that does not — are identical at every surface above.
//
// Fixtures are synthetic throwaway rows (per-file temp DB). No PHI.

import { describe, it, expect, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { utcSqlString } from "@/lib/date";
import { setProfileHomeAssistant, getProfileSetting } from "@/lib/settings";
import { ceilingWindowEndMinute } from "@/lib/prn-redose";
import {
  getMedicationFamilyStates,
  getRedoseArmingState,
  getPrnMedicationsForQuickLog,
} from "@/lib/queries";
import { runRedoseNotices, redoseMarkerKey } from "@/lib/notifications/redose";
import { prnRowStatus } from "@/lib/redose-format";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-untimed";

afterEach(() => {
  vi.unstubAllGlobals();
});

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

// An opted-in as-needed medication with the label's own numbers on it, so the
// notification gather's liability gate admits it.
function seedPrnMed(profileId: number): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, redose_notice,
            min_interval_hours, max_daily_count)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'may', 1, 6, 4)`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', 'anytime', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

// One taken administration. `at` null is the past-day check-off: the row names its
// adherence day and states no instant.
function logAdmin(
  itemId: number,
  doseId: number,
  date: string,
  capturedAt: Date,
  at: Date | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_logs
           (dose_id, item_id, date, recorded_at, occurred_at, status, amount)
         VALUES (?, ?, ?, ?, ?, 'taken', '200 mg')`
      )
      .run(
        doseId,
        itemId,
        date,
        utcSqlString(capturedAt),
        at ? utcSqlString(at) : null
      ).lastInsertRowid
  );
}

function armingFor(profileId: number, itemId: number) {
  return getMedicationFamilyStates(
    profileId,
    ceilingWindowEndMinute(new Date())
  ).get(itemId)!.arming;
}

describe("a dose that states no instant arms nothing (#4686)", () => {
  it("reads as unplaced rather than as the capture stamp", () => {
    const p = newProfile("UntimedOnly");
    const { itemId, doseId } = seedPrnMed(p);
    const capturedAt = new Date(Date.now() - 6.33 * 3_600_000);
    const id = logAdmin(itemId, doseId, today(p), capturedAt, null);
    expect(armingFor(p, itemId)).toEqual({
      kind: "unplaced",
      administrationId: id,
    });
    // The per-item read the notification path falls back to answers in the SAME union.
    expect(
      getRedoseArmingState(p, itemId, ceilingWindowEndMinute(new Date())).arming
    ).toEqual({ kind: "unplaced", administrationId: id });
  });

  // The failure two earlier attempts shipped: the unknown arm existed and could never
  // engage, because membership was decided by something other than "does a taken row
  // state no instant". A PLACED dose beside it must not take the arm back.
  it("stays unplaced even when a placed administration is also on file", () => {
    const p = newProfile("UntimedBesidePlaced");
    const { itemId, doseId } = seedPrnMed(p);
    const now = new Date();
    logAdmin(
      itemId,
      doseId,
      today(p),
      new Date(now.getTime() - 8 * 3_600_000),
      new Date(now.getTime() - 8 * 3_600_000)
    );
    const untimed = logAdmin(itemId, doseId, today(p), now, null);
    expect(armingFor(p, itemId)).toEqual({
      kind: "unplaced",
      administrationId: untimed,
    });
  });

  it("keeps the ceiling exact and says what to do about the missing minute", () => {
    const p = newProfile("UntimedCard");
    const { itemId, doseId } = seedPrnMed(p);
    const now = new Date();
    logAdmin(itemId, doseId, today(p), now, null);
    logAdmin(itemId, doseId, today(p), now, null);
    const med = getPrnMedicationsForQuickLog(p).find((m) => m.id === itemId)!;
    const row = prnRowStatus(med, "UTC", now);
    expect(row.status?.kind).toBe("unknown");
    expect(row.redoseLine).toBe(
      "Last dose has no time yet — add it in Dose history · 2 of 4 in 24h"
    );
    // A window nobody can compute is never a call to action.
    expect(row.redosePrimary).toBe(false);
  });
});

// THE NOTIFICATION ARM, PINNED (#4686). This is the path an earlier attempt's planted
// one-line deletion turned into a live "your minimum interval has passed" push with a
// Log-dose button while CI stayed green — the most consequential surface, because the
// user does not have to be looking at anything to receive it.
describe("runRedoseNotices — an unplaced administration never pushes", () => {
  it("sends nothing, though a clock reading the capture stamp would fire right now", async () => {
    const p = newProfile("UntimedNotice");
    const { itemId, doseId } = seedPrnMed(p);
    const now = new Date();
    // CAPTURED 6h20m AGO, and the twenty minutes are the point: the confirmed interval
    // is six hours and the notice's first attempt band is one observed tick wide, so a
    // clock armed off `recorded_at` lands squarely inside it and pushes. Nine hours ago
    // would prove nothing — that is past the bands, and the silence would be the
    // scheduler's rather than this decision's.
    logAdmin(
      itemId,
      doseId,
      today(p),
      new Date(now.getTime() - 6.33 * 3_600_000),
      null
    );
    setProfileHomeAssistant(p, {
      enabled: true,
      webhookUrl: HA_URL,
      secret: "",
      disabledKinds: [],
    });
    const fetchMock = stubFetch();

    await runRedoseNotices(p, today(p), now);
    expect(fetchMock).not.toHaveBeenCalled();
    // No marker either: nothing fired, so a later PLACED administration re-evaluates
    // cleanly rather than reading as already-notified.
    expect(getProfileSetting(p, redoseMarkerKey(itemId))).toBeUndefined();
  });

  it("still pushes once the same item has a placed administration past its interval", async () => {
    const p = newProfile("UntimedThenPlaced");
    const { itemId, doseId } = seedPrnMed(p);
    const now = new Date();
    const placedAt = new Date(now.getTime() - 7 * 3_600_000);
    logAdmin(itemId, doseId, today(p), placedAt, placedAt);
    setProfileHomeAssistant(p, {
      enabled: true,
      webhookUrl: HA_URL,
      secret: "",
      disabledKinds: [],
    });
    const fetchMock = stubFetch();
    await runRedoseNotices(p, today(p), now);
    // The positive control for the case above: the harness, the channel and the gather
    // all work, so "nothing was sent" there is the decision and not an inert fixture.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

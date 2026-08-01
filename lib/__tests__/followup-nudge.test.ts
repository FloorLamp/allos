// Pure-tier pins for the #1866 overdue-follow-up push: the conservative two-send
// cadence planner (crossing → first; weeks later → one repeat; then silence), the
// suppression FREEZE, the #325 self-healing marker sweep, the marker value
// round-trip, and the terminator vocabulary (normalizeSettleDisposition) + the
// shared per-record state-chip label (followUpStateLabel — a declined chain must
// never read as "due").

import { describe, it, expect } from "vitest";
import {
  planFollowUpNudges,
  parseFollowUpMarker,
  serializeFollowUpMarker,
  followUpNudgeMarkerKey,
  followUpIdFromMarker,
  FOLLOWUP_REPEAT_DAYS,
  FOLLOWUP_MAX_SENDS,
} from "@/lib/followup-nudge";
import { normalizeSettleDisposition, followUpStateLabel } from "@/lib/followup";
import { shiftDateStr } from "@/lib/date";

const TODAY = "2026-08-01";

describe("planFollowUpNudges — the two-send cadence (#1866)", () => {
  it("sends the FIRST nudge for a fresh overdue crossing (no marker)", () => {
    const plan = planFollowUpNudges([{ id: 7, sentDates: [] }], [], [], TODAY);
    expect(plan.toSend).toEqual([{ id: 7, stage: "first" }]);
    expect(plan.toClear).toEqual([]);
  });

  it("stays silent between the first send and the repeat threshold", () => {
    const first = shiftDateStr(TODAY, -(FOLLOWUP_REPEAT_DAYS - 1));
    const plan = planFollowUpNudges(
      [{ id: 7, sentDates: [first] }],
      [7],
      [],
      TODAY
    );
    expect(plan.toSend).toEqual([]);
    expect(plan.toClear).toEqual([]);
  });

  it("sends the ONE repeat exactly at/after FOLLOWUP_REPEAT_DAYS", () => {
    const first = shiftDateStr(TODAY, -FOLLOWUP_REPEAT_DAYS);
    const plan = planFollowUpNudges(
      [{ id: 7, sentDates: [first] }],
      [7],
      [],
      TODAY
    );
    expect(plan.toSend).toEqual([{ id: 7, stage: "repeat" }]);
  });

  it("after both sends it is silent FOREVER, however overdue it stays", () => {
    const d1 = shiftDateStr(TODAY, -400);
    const d2 = shiftDateStr(TODAY, -379);
    expect(FOLLOWUP_MAX_SENDS).toBe(2);
    const plan = planFollowUpNudges(
      [{ id: 7, sentDates: [d1, d2] }],
      [7],
      [],
      TODAY
    );
    expect(plan.toSend).toEqual([]);
    expect(plan.toClear).toEqual([]);
  });

  it("a live snooze FREEZES the cadence: no send, marker untouched (#227)", () => {
    const plan = planFollowUpNudges(
      [{ id: 7, sentDates: [] }],
      [],
      [7],
      TODAY
    );
    expect(plan.toSend).toEqual([]);
    expect(plan.toClear).toEqual([]);
    // The repeat is frozen too, not just the first send.
    const first = shiftDateStr(TODAY, -FOLLOWUP_REPEAT_DAYS);
    const plan2 = planFollowUpNudges(
      [{ id: 7, sentDates: [first] }],
      [7],
      [7],
      TODAY
    );
    expect(plan2.toSend).toEqual([]);
    expect(plan2.toClear).toEqual([]);
  });

  it("sweeps markers whose follow-up left the overdue set (#325 self-heal)", () => {
    // 9 was settled/resolved/deleted — no candidate — its marker clears; 7 is
    // mid-cadence and stays.
    const plan = planFollowUpNudges(
      [{ id: 7, sentDates: [shiftDateStr(TODAY, -3)] }],
      [9, 7, 12],
      [],
      TODAY
    );
    expect(plan.toClear).toEqual([9, 12]);
    expect(plan.toSend).toEqual([]);
  });
});

describe("marker value round-trip", () => {
  it("serializes and parses send dates, dropping junk", () => {
    expect(serializeFollowUpMarker(["2026-08-01", "2026-08-22"])).toBe(
      "2026-08-01,2026-08-22"
    );
    expect(parseFollowUpMarker("2026-08-01,2026-08-22")).toEqual([
      "2026-08-01",
      "2026-08-22",
    ]);
    expect(parseFollowUpMarker(null)).toEqual([]);
    expect(parseFollowUpMarker("")).toEqual([]);
    expect(parseFollowUpMarker("garbage,2026-08-01")).toEqual(["2026-08-01"]);
  });

  it("marker key ⇄ id round-trip; foreign key shapes yield NaN", () => {
    expect(followUpNudgeMarkerKey(42)).toBe("notify_last_followup_42");
    expect(followUpIdFromMarker("notify_last_followup_42")).toBe(42);
    expect(
      Number.isNaN(followUpIdFromMarker("notify_last_followup_assessed"))
    ).toBe(true);
  });
});

describe("terminator vocabulary + state chip label (#1866)", () => {
  it("normalizeSettleDisposition accepts only the closed set", () => {
    expect(normalizeSettleDisposition("done")).toBe("done");
    expect(normalizeSettleDisposition(" Declined ")).toBe("declined");
    expect(normalizeSettleDisposition("resolved")).toBeNull();
    expect(normalizeSettleDisposition("")).toBeNull();
    expect(normalizeSettleDisposition(undefined)).toBeNull();
  });

  it("followUpStateLabel: a settled chain never reads as due", () => {
    const base = {
      resolution: null,
      status: null as string | null,
      plannedDate: "2026-03-01",
    };
    expect(followUpStateLabel(base)).toBe("due 2026-03-01");
    expect(followUpStateLabel(base, "recheck due")).toBe(
      "recheck due 2026-03-01"
    );
    expect(
      followUpStateLabel({
        ...base,
        settledDisposition: "declined",
        status: "not-done",
      })
    ).toBe("declined");
    expect(
      followUpStateLabel({
        ...base,
        settledDisposition: "done",
        status: "completed",
      })
    ).toBe("done");
    expect(
      followUpStateLabel({ ...base, resolution: "stable", status: "completed" })
    ).toBe("resolved · stable");
    expect(
      followUpStateLabel({ resolution: null, status: null, plannedDate: null })
    ).toBe("tracked");
  });
});

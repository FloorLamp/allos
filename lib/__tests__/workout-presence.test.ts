import { describe, it, expect } from "vitest";
import {
  computeWorkoutPresence,
  householdPresenceChip,
  ACTIVE_MAX_QUIET_MIN,
  FINISHED_WINDOW_MIN,
  STALE_MIN,
  type PresenceActivityRow,
} from "../workout-presence";

// All fixtures use UTC so a date + "HH:MM" wall time maps directly to the same
// UTC instant, keeping the arithmetic obvious. The zone math itself is covered by
// lib/date's own tests; here we pin the presence state matrix.
const TZ = "UTC";
const DAY = "2026-07-17";
const NOW = new Date("2026-07-17T10:00:00Z");

function sql(hhmm: string, day = DAY): string {
  return `${day} ${hhmm}:00`;
}

function row(over: Partial<PresenceActivityRow>): PresenceActivityRow {
  return {
    id: 1,
    type: "strength",
    title: "Push day",
    date: DAY,
    start_time: null,
    end_time: null,
    duration_min: null,
    created_at: sql("09:00"),
    updated_at: null,
    source: null,
    ...over,
  };
}

function presence(rows: PresenceActivityRow[]) {
  return computeWorkoutPresence(rows, NOW, TZ, DAY);
}

describe("computeWorkoutPresence", () => {
  it("is idle with no rows", () => {
    expect(presence([]).state).toBe("idle");
  });

  it("is active for today's started-but-unended, freshly-touched session", () => {
    const p = presence([
      row({ start_time: "09:00", updated_at: sql("09:55") }),
    ]);
    expect(p.state).toBe("active");
    expect(p.activityId).toBe(1);
    expect(p.sinceMin).toBe(60); // 09:00 -> 10:00
    expect(p.stale).toBe(false);
  });

  it("uses created_at when updated_at is null (first save only)", () => {
    const p = presence([
      row({ start_time: "09:40", created_at: sql("09:40"), updated_at: null }),
    ]);
    expect(p.state).toBe("active");
    expect(p.sinceMin).toBe(20);
  });

  it("flags active as stale once the draft has been quiet >= STALE_MIN", () => {
    const quietStart = 60 - STALE_MIN; // touched exactly STALE_MIN ago at 09:15
    const p = presence([
      row({ start_time: "09:00", updated_at: sql("09:15") }),
    ]);
    expect(p.state).toBe("active");
    expect(p.stale).toBe(true);
    void quietStart;
  });

  it("stays active-not-stale just under STALE_MIN of quiet", () => {
    // Touched at 09:16 => 44 min quiet (< 45).
    const p = presence([
      row({ start_time: "09:00", updated_at: sql("09:16") }),
    ]);
    expect(p.state).toBe("active");
    expect(p.stale).toBe(false);
  });

  it("drops an abandoned draft (quiet > ACTIVE_MAX_QUIET_MIN) to idle", () => {
    // Touched 100 min ago (> 90).
    const p = presence([
      row({ start_time: "08:00", updated_at: sql("08:20") }),
    ]);
    expect(p.state).toBe("idle");
    void ACTIVE_MAX_QUIET_MIN;
  });

  it("is finished for a manual session ended inside the window", () => {
    const p = presence([
      row({ start_time: "09:00", end_time: "09:30", updated_at: sql("09:30") }),
    ]);
    expect(p.state).toBe("finished");
    expect(p.sinceMin).toBe(30);
  });

  it("treats the finished window as inclusive at exactly FINISHED_WINDOW_MIN", () => {
    // Ended 09:00 => 60 min ago, exactly the window edge.
    const p = presence([row({ start_time: "08:30", end_time: "09:00" })]);
    expect(p.state).toBe("finished");
    expect(p.sinceMin).toBe(FINISHED_WINDOW_MIN);
  });

  it("is idle once the end instant falls outside the window", () => {
    // Ended 08:55 => 65 min ago.
    const p = presence([row({ start_time: "08:00", end_time: "08:55" })]);
    expect(p.state).toBe("idle");
  });

  it("counts a fresh imported finish", () => {
    const p = presence([
      row({
        source: "strava",
        type: "cardio",
        start_time: "09:00",
        end_time: "09:40",
        created_at: sql("09:45"),
      }),
    ]);
    expect(p.state).toBe("finished");
    expect(p.sinceMin).toBe(20);
  });

  it("rejects a bulk sync about this morning's run (end outside window)", () => {
    // Ran 06:30-07:00, synced at 09:50 (row created 3h later).
    const p = presence([
      row({
        source: "strava",
        type: "cardio",
        start_time: "06:30",
        end_time: "07:00",
        created_at: sql("09:50"),
      }),
    ]);
    expect(p.state).toBe("idle");
  });

  it("rejects an imported finish whose row was first-seen too long ago (freshness cap)", () => {
    // End instant is recent (09:40, 20 min ago) but the row was created at 08:00
    // (120 min ago) — the freshness cap holds it out even though the window
    // would pass.
    const p = presence([
      row({
        source: "strava",
        type: "cardio",
        start_time: "09:00",
        end_time: "09:40",
        created_at: sql("08:00"),
      }),
    ]);
    expect(p.state).toBe("idle");
  });

  it("does NOT freshness-cap a manual finish (a long live session's row is old)", () => {
    // Started 08:30 (row created then), finished 09:45 — created_at is 90 min old
    // but a manual finish is not freshness-capped.
    const p = presence([
      row({
        start_time: "08:30",
        end_time: "09:45",
        created_at: sql("08:30"),
        updated_at: sql("09:45"),
      }),
    ]);
    expect(p.state).toBe("finished");
    expect(p.sinceMin).toBe(15);
  });

  it("derives an imported finish from start + duration when end_time is absent", () => {
    const p = presence([
      row({
        source: "health-connect",
        type: "cardio",
        start_time: "09:00",
        end_time: null,
        duration_min: 30, // ends 09:30 => 30 min ago
        created_at: sql("09:35"),
      }),
    ]);
    expect(p.state).toBe("finished");
    expect(p.sinceMin).toBe(30);
  });

  it("leaves an end-less, duration-less import as neither active nor finished", () => {
    // No way to know when it ended — never live (imported), never finished.
    const p = presence([
      row({
        source: "health-connect",
        type: "cardio",
        start_time: "09:50",
        end_time: null,
        duration_min: null,
        created_at: sql("09:55"),
      }),
    ]);
    expect(p.state).toBe("idle");
  });

  it("prefers active over a concurrently-finished row", () => {
    const p = presence([
      row({ id: 2, start_time: "08:00", end_time: "09:30" }), // finished 30m ago
      row({ id: 3, start_time: "09:30", updated_at: sql("09:58") }), // live now
    ]);
    expect(p.state).toBe("active");
    expect(p.activityId).toBe(3);
  });

  it("allows a small future skew on the end instant", () => {
    const p = presence([row({ start_time: "09:30", end_time: "10:03" })]);
    expect(p.state).toBe("finished");
    expect(p.sinceMin).toBe(0);
  });

  it("rejects an end instant too far in the future", () => {
    const p = presence([row({ start_time: "09:30", end_time: "10:10" })]);
    expect(p.state).toBe("idle");
  });

  it("ignores a started-unended row from a prior day (not today)", () => {
    const p = presence([
      row({
        date: "2026-07-16",
        start_time: "09:00",
        updated_at: "2026-07-16 09:55:00",
      }),
    ]);
    expect(p.state).toBe("idle");
  });

  it("never treats an imported row as active", () => {
    const p = presence([
      row({
        source: "strava",
        type: "cardio",
        start_time: "09:50",
        end_time: null,
        created_at: sql("09:55"),
      }),
    ]);
    expect(p.state).not.toBe("active");
  });
});

describe("householdPresenceChip", () => {
  it("labels an active session with elapsed minutes, live-only", () => {
    const p = presence([
      row({ start_time: "09:00", updated_at: sql("09:55") }),
    ]);
    expect(householdPresenceChip(p)).toBe("mid-workout · 60 min");
  });

  it("returns null for idle and finished (no live telemetry to show)", () => {
    expect(householdPresenceChip(presence([]))).toBeNull();
    const finished = presence([
      row({ start_time: "09:00", end_time: "09:30" }),
    ]);
    expect(finished.state).toBe("finished");
    expect(householdPresenceChip(finished)).toBeNull();
  });
});

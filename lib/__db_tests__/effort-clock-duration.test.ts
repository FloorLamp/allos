// DB INTEGRATION TIER (#448) — the read-time heal for clock-only cardio/sport
// sessions (#791). A sport/cardio activity logged with Start/End times but no
// typed per-component Duration stored NULL on its component even though the
// parent row carries the clock-derived minutes; effortEntries must fall back to
// that parent duration for a SOLE non-strength component, so its duration-only
// stats aggregate with real minutes instead of showing a 0-minute session. The
// sole-component guard is asserted with a negative mixed-session fixture: a
// strength+sport session must NOT attribute its strength minutes to the sport leg.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getSportByActivity, getCardioByActivity } from "@/lib/queries";
import type { ActivityComponent } from "@/lib/types";

// A stored components blob mirrors the real clock-only bug: the duration_min key
// is simply ABSENT (never written), so this fixture omits it rather than storing
// an explicit null — parseComponents reads either as "no duration".
type StoredComponent = Pick<ActivityComponent, "name" | "type"> &
  Partial<ActivityComponent>;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Insert an activity with a structured components blob (as saveActivity writes),
// its parent clock-derived duration_min, and optional start/end times.
function insertActivity(
  profileId: number,
  opts: {
    date: string;
    type: string;
    title: string;
    durationMin: number | null;
    components: StoredComponent[];
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, duration_min, start_time, end_time, components)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        opts.date,
        opts.type,
        opts.title,
        opts.durationMin,
        "08:00",
        "08:55",
        JSON.stringify(opts.components)
      ).lastInsertRowid
  );
}

describe("effortEntries clock-only duration heal (#791)", () => {
  it("aggregates a sole sport component's minutes from the parent clock duration", () => {
    const profileId = newProfile("Sport Clock");
    // Component duration_min is absent (the clock-only save bug); the parent row
    // carries the 55-minute clock span.
    insertActivity(profileId, {
      date: "2026-06-01",
      type: "sport",
      title: "Morning Tennis",
      durationMin: 55,
      components: [{ name: "Tennis", type: "sport" }],
    });

    const sports = getSportByActivity(profileId);
    expect(sports).toHaveLength(1);
    const tennis = sports[0];
    expect(tennis.sport).toBe("Tennis");
    expect(tennis.sessions).toBe(1);
    // The heal: real minutes, not a 0-minute session.
    expect(tennis.totalDurationMin).toBe(55);
    expect(tennis.longestDurationMin).toBe(55);
  });

  it("heals a sole cardio component the same way", () => {
    const profileId = newProfile("Cardio Clock");
    insertActivity(profileId, {
      date: "2026-06-02",
      type: "cardio",
      title: "Evening Run",
      durationMin: 42,
      components: [{ name: "Running", type: "cardio", distance_km: 6 }],
    });

    const cardio = getCardioByActivity(profileId, "km");
    expect(cardio).toHaveLength(1);
    expect(cardio[0].activity).toBe("Running");
    expect(cardio[0].totalDurationMin).toBe(42);
  });

  it("keeps a component's own duration over the parent (no clobber)", () => {
    const profileId = newProfile("Sport Own Duration");
    insertActivity(profileId, {
      date: "2026-06-03",
      type: "sport",
      title: "Afternoon Tennis",
      durationMin: 55,
      components: [{ name: "Tennis", type: "sport", duration_min: 40 }],
    });

    const sports = getSportByActivity(profileId);
    expect(sports[0].totalDurationMin).toBe(40);
  });

  it("does NOT leak strength minutes into the sport leg of a mixed session", () => {
    const profileId = newProfile("Mixed Session");
    // A strength + sport session: the parent row's 60 minutes belong to the whole
    // session, and the sport leg has no duration of its own. The sole-component
    // guard must hold the sport leg at 0, never inherit the strength minutes.
    insertActivity(profileId, {
      date: "2026-06-04",
      type: "strength",
      title: "Lift then Tennis",
      durationMin: 60,
      components: [
        { name: "Bench Press", type: "strength" },
        { name: "Tennis", type: "sport" },
      ],
    });

    const sports = getSportByActivity(profileId);
    expect(sports).toHaveLength(1);
    expect(sports[0].sport).toBe("Tennis");
    // No leak — the mixed leg stays a 0-minute effort (manual per-leg duration).
    expect(sports[0].totalDurationMin).toBe(0);
    expect(sports[0].longestDurationMin).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  recentSessionsView,
  recentSessionPartText,
  RECENT_SESSION_LIMIT,
  RECENT_SESSION_PART_LIMIT,
} from "@/lib/training-recent-sessions";
import type { DayGroup } from "@/lib/training-log-card";

// The fold behind Training → Overview's "What you did" (#2566). The Log's cards
// go in; which of them belong on the overview comes out. Nothing here formats a
// number — the cards arrive already formatted.

function card(
  id: number,
  title: string,
  over: Partial<DayGroup["cards"][number]> = {}
): DayGroup["cards"][number] {
  return {
    activity: {
      id,
      title,
      type: "strength",
      date: "2026-08-16",
      duration_min: 40,
      distance_km: null,
      intensity: null,
      start_time: null,
      end_time: null,
      components: null,
      notes: null,
    },
    timeText: null,
    durationText: "40 min",
    distanceText: null,
    speedText: null,
    heartRateText: null,
    calorieText: null,
    metrics: [],
    gear: null,
    parts: [],
    fault: null,
    provenance: {
      label: "Manual",
      createdAt: "",
      updatedAt: null,
      editLocked: false,
    },
    foldValues: {},
    routePolyline: null,
    videos: [],
    ...over,
  } as DayGroup["cards"][number];
}

function group(
  date: string,
  label: string,
  cards: DayGroup["cards"]
): DayGroup {
  return { date, label, cards };
}

const WINDOW = { weekStart: "2026-08-10", today: "2026-08-16" };

describe("recentSessionsView (#2566 — Overview's 'what you did')", () => {
  it("shows the week's sessions newest first, and states what it cut", () => {
    const view = recentSessionsView(
      [
        group("2026-08-16", "Today", [
          card(6, "Evening accessories"),
          card(5, "Squat day"),
        ]),
        group("2026-08-15", "Yesterday", [card(4, "Easy run")]),
        group("2026-08-13", "13 August", [card(3, "Hip mobility")]),
        group("2026-08-12", "12 August", [card(2, "Pickup game")]),
      ],
      WINDOW
    );
    expect(view.scope).toBe("week");
    expect(view.rows.map((r) => r.title)).toEqual([
      "Evening accessories",
      "Squat day",
      "Easy run",
      "Hip mobility",
    ]);
    expect(view.rows).toHaveLength(RECENT_SESSION_LIMIT);
    // The fifth session is not dropped in silence — the count is the handoff to
    // the Log, and a card that hides work without saying so is the bug this
    // number exists to prevent.
    expect(view.more).toBe(1);
  });

  it("excludes a future-dated activity — a plan is not a thing you did", () => {
    // The Log's newest page leads with tomorrow's planned run; the week spine
    // does not draw it, and neither does this.
    const view = recentSessionsView(
      [
        group("2026-08-17", "17 August", [card(9, "Planned run")]),
        group("2026-08-16", "Today", [card(8, "Squat day")]),
      ],
      WINDOW
    );
    expect(view.rows.map((r) => r.title)).toEqual(["Squat day"]);
    expect(view.more).toBe(0);
  });

  it("falls back to the ONE most recent session when the week is empty", () => {
    // "Nothing this week" is true about the week and useless as an answer to
    // "what did I last do" — so the last session stands in, labelled with its
    // own day rather than pretending to be this week's.
    const view = recentSessionsView(
      [
        group("2026-08-04", "4 August", [card(2, "Long ride")]),
        group("2026-07-28", "28 July", [card(1, "Deadlift day")]),
      ],
      WINDOW
    );
    expect(view.scope).toBe("earlier");
    expect(view.rows.map((r) => r.title)).toEqual(["Long ride"]);
    expect(view.rows[0].dayLabel).toBe("4 August");
    expect(view.more).toBe(0);
  });

  it("renders nothing at all when nothing has ever been logged", () => {
    const view = recentSessionsView([], WINDOW);
    expect(view.rows).toEqual([]);
    expect(view.more).toBe(0);
  });

  it("caps a long session's lines and counts the rest", () => {
    const parts = Array.from(
      { length: RECENT_SESSION_PART_LIMIT + 3 },
      (_, i) => ({
        kind: "strength" as const,
        name: `Lift ${i}`,
        muscle: null,
        text: `3 x 8 @ 60 kg`,
        status: null,
      })
    );
    const view = recentSessionsView(
      [group("2026-08-16", "Today", [card(1, "Big day", { parts })])],
      WINDOW
    );
    expect(view.rows[0].parts).toHaveLength(RECENT_SESSION_PART_LIMIT);
    expect(view.rows[0].moreParts).toBe(3);
  });

  it("builds the meta line from the card's own formatted values, in order", () => {
    const view = recentSessionsView(
      [
        group("2026-08-16", "Today", [
          card(1, "Easy run", {
            timeText: "07:15",
            durationText: "42 min",
            distanceText: "8.0 km",
            speedText: "11.4 km/h",
            heartRateText: "142 bpm",
            // No calorie estimate on this row — the gap closes up rather than
            // leaving a stray separator.
            calorieText: null,
          }),
        ]),
      ],
      WINDOW
    );
    expect(view.rows[0].meta).toEqual([
      "07:15",
      "42 min",
      "8.0 km",
      "11.4 km/h",
      "142 bpm",
    ]);
  });

  it("opens each session at the one destination it has", () => {
    // The shared resolver (#2870/#3061): every session opens its canonical
    // activity page. Never a second href rule.
    const view = recentSessionsView(
      [
        group("2026-08-16", "Today", [
          card(11, "Morning ride", {
            activity: {
              ...card(11, "Morning ride").activity,
              type: "cardio",
              title: "Morning ride",
            },
          }),
          card(12, "Squat day"),
        ]),
      ],
      WINDOW
    );
    expect(view.rows[0].href).toBe("/training/activity/11");
    expect(view.rows[1].href).toBe("/training/activity/12");
  });
});

describe("recentSessionPartText", () => {
  it("reads a strength part's set summary and a cardio part's detail", () => {
    expect(
      recentSessionPartText({
        kind: "strength",
        name: "Squat",
        muscle: "quads",
        text: "3 x 5 @ 100 kg",
        status: null,
      })
    ).toBe("3 x 5 @ 100 kg");
    expect(
      recentSessionPartText({
        kind: "cardio",
        name: "Run",
        detail: "8 km · 42 min",
      })
    ).toBe("8 km · 42 min");
  });
});

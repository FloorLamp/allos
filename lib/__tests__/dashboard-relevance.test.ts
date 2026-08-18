import { describe, expect, it } from "vitest";
import {
  DASHBOARD_ZONES,
  NO_DASHBOARD_RANK_REASONS,
  NOW_CARD_IDS,
  compareDashboardPlacements,
  dashboardTimingActive,
  rankDashboard,
  visibleDashboardPlacements,
  type DashboardNowSignals,
  type DashboardTiming,
  type RankableDashboardSurface,
} from "../dashboard-relevance";

const MIN = (hour: number, minute = 0) => hour * 60 + minute;

function now(
  overrides: Partial<DashboardNowSignals> = {}
): DashboardNowSignals {
  return {
    minutesOfDay: MIN(15),
    wakeMinutes: MIN(7),
    freshSleepSummary: false,
    sleepWaiting: false,
    napEndedMinAgo: null,
    workoutFinishedMinAgo: null,
    mealAnchors: [MIN(8), MIN(13), MIN(20)],
    eveningAnchor: MIN(20),
    checkInDone: false,
    ...overrides,
  };
}

function surface(
  placementId: string,
  currentPlacement: RankableDashboardSurface["currentPlacement"],
  currentOrder: number,
  overrides: Partial<RankableDashboardSurface> = {}
): RankableDashboardSurface {
  return {
    placementId,
    nodeKey: placementId,
    groupKey: null,
    subject: { scope: "profile", profileId: 7 },
    visible: true,
    available: true,
    promotable: false,
    rankReasons: { ...NO_DASHBOARD_RANK_REASONS },
    timing: { kind: "always" },
    currentPlacement,
    currentOrder,
    ...overrides,
  };
}

function matrixSurfaces(): RankableDashboardSurface[] {
  return [
    surface("needs-attention", "priority", 1),
    surface("illness-hero", "priority", 0, {
      subject: { scope: "household" },
    }),
    surface("recently-resolved", "pre-grid", 0),
    surface("session-recap", "pre-grid", 2, {
      promotable: true,
      timing: { kind: "since-event", ageMinutes: 0, maxMinutes: 60 },
    }),
    surface("symptom-log", "grid", 0, {
      promotable: true,
    }),
    surface("nutrition-today", "grid", 1, {
      promotable: true,
    }),
    surface("sleep-last-night", "grid", 2, {
      promotable: true,
      timing: {
        kind: "local-time",
        opensAt: MIN(7),
        closesAt: MIN(10),
        wrapsMidnight: false,
      },
    }),
    surface("naps-today", "grid", 3, {
      promotable: true,
      timing: { kind: "since-event", ageMinutes: 0, maxMinutes: 180 },
    }),
    surface("recent-labs", "grid", 4),
  ];
}

const compact = (surfaces: RankableDashboardSurface[], signals = now()) =>
  rankDashboard(surfaces, { now: signals }).map((placement) =>
    [placement.placementId, placement.zone, placement.visibility].join(":")
  );

describe("rankDashboard characterization manifest (#3080)", () => {
  it("preserves priority, pre-grid and saved grid order when no Now signal fires", () => {
    expect(compact(matrixSurfaces())).toEqual([
      "illness-hero:priority:visible",
      "needs-attention:priority:visible",
      "recently-resolved:pre-grid:visible",
      "session-recap:pre-grid:visible",
      "symptom-log:grid:visible",
      "nutrition-today:grid:visible",
      "sleep-last-night:grid:visible",
      "naps-today:grid:visible",
      "recent-labs:grid:visible",
    ]);
  });

  it.each([
    {
      label: "wake",
      signals: now({ minutesOfDay: MIN(9, 1), freshSleepSummary: true }),
      promoted: ["sleep-last-night"],
      reason: "windowOpen" as const,
    },
    {
      label: "meal",
      signals: now({ minutesOfDay: MIN(13) }),
      promoted: ["nutrition-today"],
      reason: "windowOpen" as const,
    },
    {
      label: "post-workout",
      signals: now({ workoutFinishedMinAgo: 5 }),
      promoted: ["session-recap"],
      reason: "changed" as const,
    },
    {
      label: "evening check-in",
      signals: now({ minutesOfDay: MIN(21) }),
      promoted: ["symptom-log", "nutrition-today"],
      reason: "owed" as const,
    },
  ])(
    "moves the existing node into Now inside the $label window",
    ({ signals, promoted, reason }) => {
      const placements = rankDashboard(matrixSurfaces(), { now: signals });
      expect(
        visibleDashboardPlacements(placements, "now").map(
          (placement) => placement.placementId
        )
      ).toEqual(promoted);
      for (const id of promoted) {
        expect(
          placements.filter((placement) => placement.nodeKey === id)
        ).toHaveLength(1);
      }
      expect(
        placements.find((placement) => placement.placementId === promoted[0])
          ?.rankReasons[reason]
      ).toBe(true);
    }
  );

  it("keeps a saved custom grid order as the home-order tie-break", () => {
    const surfaces = matrixSurfaces().map((candidate) =>
      candidate.placementId === "recent-labs"
        ? { ...candidate, currentOrder: -1 }
        : candidate
    );
    expect(
      visibleDashboardPlacements(
        rankDashboard(surfaces, { now: now() }),
        "grid"
      ).map((placement) => placement.placementId)
    ).toEqual([
      "recent-labs",
      "symptom-log",
      "nutrition-today",
      "sleep-last-night",
      "naps-today",
    ]);
  });

  it("never promotes hidden, unavailable, empty or dormant surfaces", () => {
    const surfaces = matrixSurfaces().map((candidate) => {
      if (candidate.placementId === "sleep-last-night") {
        return { ...candidate, visible: false };
      }
      if (candidate.placementId === "nutrition-today") {
        return { ...candidate, available: false };
      }
      if (candidate.placementId === "symptom-log") {
        return { ...candidate, promotable: false };
      }
      return candidate;
    });
    const placements = rankDashboard(surfaces, {
      now: now({
        minutesOfDay: MIN(20),
        wakeMinutes: MIN(18),
        freshSleepSummary: true,
      }),
    });
    expect(visibleDashboardPlacements(placements, "now")).toEqual([]);
    expect(
      placements.find(
        (placement) => placement.placementId === "sleep-last-night"
      )?.visibility
    ).toBe("hidden");
    expect(
      placements.find(
        (placement) => placement.placementId === "nutrition-today"
      )?.visibility
    ).toBe("unavailable");
  });

  it("keeps silence as a valid answer", () => {
    expect(
      visibleDashboardPlacements(
        rankDashboard(matrixSurfaces(), { now: now() }),
        "now"
      )
    ).toEqual([]);
  });
});

describe("orthogonal rank reasons", () => {
  it("never treats an open-window may action as owed or promotes it", () => {
    const offered = surface("stream-offer", "pre-grid", 0, {
      promotable: true,
      obligation: "may",
      rankReasons: {
        ...NO_DASHBOARD_RANK_REASONS,
        windowOpen: true,
      },
      timing: {
        kind: "local-time",
        opensAt: MIN(8),
        closesAt: MIN(9),
        wrapsMidnight: false,
      },
    });
    const [placement] = rankDashboard([offered], {
      now: now({ minutesOfDay: MIN(8, 30) }),
    });
    expect(placement.zone).toBe("pre-grid");
    expect(placement.rankReasons.owed).toBe(false);
  });

  it("also blocks a legacy window card when it is classified may", () => {
    const nutrition = surface("nutrition-today", "grid", 0, {
      promotable: true,
      obligation: "may",
      rankReasons: {
        ...NO_DASHBOARD_RANK_REASONS,
        windowOpen: true,
      },
    });
    const [placement] = rankDashboard([nutrition], {
      now: now({ minutesOfDay: MIN(13) }),
    });
    expect(placement.zone).toBe("grid");
  });

  it("lets every safety surface through while the ordinary cap remains two", () => {
    const surfaces = [
      ...["safety-a", "safety-b", "safety-c"].map((id, order) =>
        surface(id, "grid", order, {
          promotable: true,
          rankReasons: {
            ...NO_DASHBOARD_RANK_REASONS,
            safety: true,
          },
        })
      ),
      ...["owed-a", "owed-b", "owed-c"].map((id, order) =>
        surface(id, "grid", order + 3, {
          promotable: true,
          obligation: "must",
          rankReasons: {
            ...NO_DASHBOARD_RANK_REASONS,
            owed: true,
          },
        })
      ),
    ];
    const nowIds = visibleDashboardPlacements(
      rankDashboard(surfaces, { now: now() }),
      "now"
    ).map((placement) => placement.placementId);
    expect(nowIds).toEqual([
      "safety-a",
      "safety-b",
      "safety-c",
      "owed-a",
      "owed-b",
    ]);
  });

  it("does not make unavailable safety content renderable", () => {
    const unavailable = surface("safety", "pre-grid", 0, {
      available: false,
      promotable: true,
      rankReasons: {
        ...NO_DASHBOARD_RANK_REASONS,
        safety: true,
      },
    });
    const [placement] = rankDashboard([unavailable], { now: now() });
    expect(placement.zone).toBe("pre-grid");
    expect(placement.visibility).toBe("unavailable");
  });

  it("promotes visible safety content even when its timing is inactive", () => {
    const safety = surface("closed-window-safety", "grid", 0, {
      promotable: false,
      timing: {
        kind: "local-time",
        opensAt: MIN(8),
        closesAt: MIN(9),
        wrapsMidnight: false,
      },
      rankReasons: {
        ...NO_DASHBOARD_RANK_REASONS,
        safety: true,
      },
    });
    const [placement] = rankDashboard([safety], {
      now: now({ minutesOfDay: MIN(15) }),
    });
    expect(placement.zone).toBe("now");
  });

  it("centrally strips owed from may and blocks the legacy symptom path", () => {
    const symptom = surface("symptom-log", "grid", 0, {
      promotable: true,
      obligation: "may",
      rankReasons: {
        ...NO_DASHBOARD_RANK_REASONS,
        owed: true,
      },
    });
    const [placement] = rankDashboard([symptom], {
      now: now({ minutesOfDay: MIN(21) }),
    });
    expect(placement.zone).toBe("grid");
    expect(placement.rankReasons.owed).toBe(false);
  });

  it("moves a generic pre-grid safety placement by its stable identity", () => {
    const generic = surface("interaction-warning", "pre-grid", 4, {
      nodeKey: "interaction-warning-node",
      promotable: true,
      rankReasons: {
        ...NO_DASHBOARD_RANK_REASONS,
        safety: true,
      },
    });
    const [placement] = rankDashboard([generic], { now: now() });
    expect(placement).toMatchObject({
      placementId: "interaction-warning",
      nodeKey: "interaction-warning-node",
      zone: "now",
      visibility: "visible",
    });
  });
});

describe("manifest integrity", () => {
  it("uses a strict total placement comparator", () => {
    const decomposed = "e\u0301";
    const composed = "\u00e9";
    const placements = rankDashboard(
      [
        surface("priority-b", "priority", 1),
        surface("priority-a", "priority", 1),
        surface("pre-grid", "pre-grid", 0),
        surface("grid-b", "grid", 1),
        surface("grid-a", "grid", 1),
        surface(decomposed, "grid", 1),
        surface(composed, "grid", 1),
        surface("safety", "grid", 9, {
          promotable: true,
          rankReasons: {
            ...NO_DASHBOARD_RANK_REASONS,
            safety: true,
          },
        }),
      ],
      { now: now() }
    );
    const sign = (value: number) => Math.sign(value);

    for (const a of placements) {
      expect(compareDashboardPlacements(a, a)).toBe(0);
      for (const b of placements) {
        const ab = compareDashboardPlacements(a, b);
        const ba = compareDashboardPlacements(b, a);
        if (ab === 0 || ba === 0) expect(ab).toBe(ba);
        else expect(sign(ab)).toBe(-sign(ba));
        if (a.placementId !== b.placementId) expect(ab).not.toBe(0);
        for (const c of placements) {
          const bc = compareDashboardPlacements(b, c);
          if (ab <= 0 && bc <= 0) {
            expect(compareDashboardPlacements(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  it("is invariant to input order and terminates ties on placementId", () => {
    const decomposed = "e\u0301";
    const composed = "\u00e9";
    const surfaces = [
      surface("charlie", "grid", 0),
      surface("alpha", "grid", 0),
      surface("bravo", "grid", 0),
      surface(composed, "grid", 0),
      surface(decomposed, "grid", 0),
    ];
    const forward = rankDashboard(surfaces, { now: now() });
    const shuffled = rankDashboard(
      [surfaces[3], surfaces[2], surfaces[4], surfaces[0], surfaces[1]],
      { now: now() }
    );
    expect(forward).toEqual(shuffled);
    expect(forward.map((placement) => placement.placementId)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      decomposed,
      composed,
    ]);
  });

  it("rejects duplicate placement identities rather than rendering twice", () => {
    const duplicate = surface("same", "grid", 0);
    expect(() =>
      rankDashboard([duplicate, { ...duplicate }], { now: now() })
    ).toThrow("Duplicate dashboard placementId: same");
  });

  it("declares every supported zone and timing shape without reading a clock", () => {
    expect(DASHBOARD_ZONES).toEqual(["priority", "now", "pre-grid", "grid"]);
    const timings: DashboardTiming[] = [
      { kind: "always" },
      {
        kind: "local-time",
        opensAt: MIN(23),
        closesAt: MIN(1),
        wrapsMidnight: true,
      },
      {
        kind: "local-time-windows",
        windows: [
          {
            opensAt: MIN(12),
            closesAt: MIN(14),
            wrapsMidnight: false,
          },
        ],
      },
      { kind: "since-event", ageMinutes: 5, maxMinutes: 60 },
      { kind: "local-days", ageDays: 2, maxDays: 7 },
      { kind: "until-signal", active: true },
    ];
    expect(timings.map((timing) => timing.kind)).toEqual([
      "always",
      "local-time",
      "local-time-windows",
      "since-event",
      "local-days",
      "until-signal",
    ]);
    expect(dashboardTimingActive(timings[1], MIN(0))).toBe(true);
    expect(dashboardTimingActive(timings[2], MIN(13))).toBe(true);
    expect(dashboardTimingActive(timings[3], MIN(13))).toBe(true);
    expect(NOW_CARD_IDS).toHaveLength(5);
  });
});

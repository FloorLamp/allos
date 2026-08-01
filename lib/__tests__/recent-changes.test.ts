import { describe, it, expect } from "vitest";
import {
  applyRecentChangeDemotion,
  arrivalKind,
  arrivalKindsPhrase,
  MAX_ARRIVAL_KINDS,
  inRecentChangeWindow,
  rankRecentChanges,
  recentChangeWindowStart,
  renderRecentChanges,
  RECENT_CHANGES_MAX_LINES,
  type RecentChange,
  type RecentChangeCategory,
} from "@/lib/recent-changes";

// The recent-changes collector's PURE half (#1463 §2b / #1713). No DB, no clock.

const CTX = {
  lifeStage: "adult" as const,
  openEpisode: false,
  adherenceRegression: false,
};

function change(
  id: string,
  category: RecentChangeCategory,
  extra: Partial<RecentChange> = {}
): RecentChange {
  return { id, category, text: id, date: "2026-07-30", ...extra };
}

describe("recentChangeWindowStart — the window boundary", () => {
  it("a 24h digest window opens the day before today", () => {
    expect(recentChangeWindowStart("2026-07-31", 1)).toBe("2026-07-30");
  });

  it("the household card's 7-day window opens a week back", () => {
    expect(recentChangeWindowStart("2026-07-31", 7)).toBe("2026-07-24");
  });

  it("crosses a month boundary correctly", () => {
    expect(recentChangeWindowStart("2026-08-01", 1)).toBe("2026-07-31");
  });

  it("never produces a zero-or-negative window", () => {
    expect(recentChangeWindowStart("2026-07-31", 0)).toBe("2026-07-30");
    expect(recentChangeWindowStart("2026-07-31", -4)).toBe("2026-07-30");
  });

  it("includes both edges and excludes outside days", () => {
    const start = recentChangeWindowStart("2026-07-31", 1);
    expect(
      inRecentChangeWindow({ date: "2026-07-30" }, start, "2026-07-31")
    ).toBe(true);
    expect(
      inRecentChangeWindow({ date: "2026-07-31" }, start, "2026-07-31")
    ).toBe(true);
    expect(
      inRecentChangeWindow({ date: "2026-07-29" }, start, "2026-07-31")
    ).toBe(false);
    expect(
      inRecentChangeWindow({ date: "2026-08-01" }, start, "2026-07-31")
    ).toBe(false);
  });

  it("a dateless change (a structural signal) is always in-window", () => {
    expect(
      inRecentChangeWindow({ date: null }, "2026-07-30", "2026-07-31")
    ).toBe(true);
  });
});

describe("rankRecentChanges — base order, signals and floors", () => {
  it("with no signal firing the output is the #1463 table order exactly", () => {
    const ranked = rankRecentChanges(
      [
        change("data:oura", "data", { date: null }),
        change("mood:1", "mood"),
        change("vitals:1", "vitals"),
        change("intake:1", "intake"),
        change("visits:1", "visits"),
        change("labs:1", "labs", { flagged: false }),
      ],
      CTX
    );
    expect(ranked.map((c) => c.category)).toEqual([
      "labs",
      "visits",
      "intake",
      "vitals",
      "mood",
      "data",
    ]);
  });

  it("an out-of-range VITAL can never rank below an unflagged line (the widened floor)", () => {
    const ranked = rankRecentChanges(
      [
        change("labs:1", "labs"),
        change("visits:1", "visits"),
        change("vitals:bp", "vitals", { flagged: true }),
      ],
      CTX
    );
    expect(ranked[0].id).toBe("vitals:bp");
  });

  it("a flagged lab and an out-of-range vital both hold the floor, above everything else", () => {
    const ranked = rankRecentChanges(
      [
        change("mood:1", "mood"),
        change("vitals:spo2", "vitals", { flagged: true }),
        change("visits:1", "visits"),
        change("labs:a1c", "labs", { flagged: true }),
      ],
      CTX
    );
    expect(
      ranked
        .slice(0, 2)
        .map((c) => c.id)
        .sort()
    ).toEqual(["labs:a1c", "vitals:spo2"]);
    // The floor is a class guarantee, so the two flagged lines order by base weight.
    expect(ranked[0].id).toBe("labs:a1c");
  });

  it("no combination of boosts defeats the floor", () => {
    const ranked = rankRecentChanges(
      [
        // Every signal that can fire, on one growth line.
        change("growth:1", "growth"),
        change("vitals:bp", "vitals", { flagged: true }),
      ],
      {
        lifeStage: "child",
        openEpisode: false,
        adherenceRegression: false,
        growthBandCrossingIds: new Set(["growth:1"]),
        goalTrackedIds: new Set(["growth:1"]),
        loopClosureIds: new Set(["growth:1"]),
      }
    );
    expect(ranked[0].id).toBe("vitals:bp");
  });

  it("an open episode lifts vitals and visits above routine lines", () => {
    const ranked = rankRecentChanges(
      [
        change("labs:1", "labs"),
        change("intake:1", "intake"),
        change("vitals:1", "vitals"),
      ],
      { ...CTX, openEpisode: true }
    );
    expect(ranked[0].id).toBe("vitals:1");
  });

  it("a minor's growth point outranks routine lines; an adult's does not", () => {
    const items = [change("visits:1", "visits"), change("growth:1", "growth")];
    expect(rankRecentChanges(items, { ...CTX, lifeStage: "child" })[0].id).toBe(
      "growth:1"
    );
    expect(rankRecentChanges(items, { ...CTX, lifeStage: "adult" })[0].id).toBe(
      "visits:1"
    );
  });

  it("a percentile-band crossing outranks a routine growth point", () => {
    const ranked = rankRecentChanges(
      [
        change("growth:routine", "growth", { date: "2026-07-31" }),
        change("growth:crossing", "growth", { date: "2026-07-29" }),
      ],
      {
        ...CTX,
        lifeStage: "child",
        growthBandCrossingIds: new Set(["growth:crossing"]),
      }
    );
    expect(ranked[0].id).toBe("growth:crossing");
  });

  it("loop closure (a recheck arriving) outranks a routine lab", () => {
    const ranked = rankRecentChanges(
      [
        change("labs:routine", "labs", { date: "2026-07-31" }),
        change("labs:recheck", "labs", { date: "2026-07-30" }),
      ],
      { ...CTX, loopClosureIds: new Set(["labs:recheck"]) }
    );
    expect(ranked[0].id).toBe("labs:recheck");
  });

  it("adherence regression lifts the intake line above routine change lines", () => {
    const ranked = rankRecentChanges(
      [change("visits:1", "visits"), change("intake:1", "intake")],
      { ...CTX, adherenceRegression: true }
    );
    expect(ranked[0].id).toBe("intake:1");
  });

  it("within a category, newer dates lead (the stable tiebreak)", () => {
    const ranked = rankRecentChanges(
      [
        change("symptoms:a", "symptoms", { date: "2026-07-29" }),
        change("symptoms:b", "symptoms", { date: "2026-07-31" }),
      ],
      CTX
    );
    expect(ranked.map((c) => c.id)).toEqual(["symptoms:b", "symptoms:a"]);
  });

  it("is deterministic — the same input yields the same order every time", () => {
    const items = [
      change("labs:1", "labs"),
      change("mood:1", "mood"),
      change("vitals:1", "vitals", { flagged: true }),
    ];
    const a = rankRecentChanges(items, CTX).map((c) => c.id);
    const b = rankRecentChanges(items, CTX).map((c) => c.id);
    expect(a).toEqual(b);
  });

  it("an empty collection ranks to nothing", () => {
    expect(rankRecentChanges([], CTX)).toEqual([]);
  });
});

describe("renderRecentChanges — the cap and the quiet window", () => {
  it("a quiet window produces NO lines at all (no manufactured news)", () => {
    expect(renderRecentChanges([])).toEqual({ lines: [], overflow: 0 });
  });

  it("everything below the cap renders in order with no overflow line", () => {
    const out = renderRecentChanges([
      change("a", "labs", { text: "A" }),
      change("b", "visits", { text: "B" }),
    ]);
    expect(out.lines).toEqual(["A", "B"]);
    expect(out.overflow).toBe(0);
  });

  it("overflow says +N more and never spills", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      change(`x${i}`, "labs", { text: `L${i}` })
    );
    const out = renderRecentChanges(many, { overflowLabel: "since yesterday" });
    expect(out.lines).toHaveLength(RECENT_CHANGES_MAX_LINES + 1);
    expect(out.overflow).toBe(9 - RECENT_CHANGES_MAX_LINES);
    expect(out.lines.at(-1)).toBe("+5 more since yesterday");
  });

  it("the overflow line carries a link when the surface can render one", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      change(`x${i}`, "labs", { text: `L${i}` })
    );
    const out = renderRecentChanges(many, {
      max: 2,
      overflowLabel: "this week",
      overflowHref: "/timeline",
    });
    expect(out.lines.at(-1)).toBe("+4 more this week /timeline");
  });
});

describe("applyRecentChangeDemotion (#1714)", () => {
  it("no demotion leaves the set untouched", () => {
    const items = [change("a", "mood"), change("b", "labs")];
    expect(applyRecentChangeDemotion(items, new Set())).toEqual(items);
  });

  it("a demoted category surfaces only its NOTABLE entries", () => {
    const kept = applyRecentChangeDemotion(
      [
        change("mood:routine", "mood"),
        change("mood:shift", "mood", { notable: true }),
        change("labs:1", "labs"),
      ],
      new Set<RecentChangeCategory>(["mood"])
    );
    expect(kept.map((c) => c.id)).toEqual(["mood:shift", "labs:1"]);
  });

  it("a flagged line survives demotion — demotion is a preference, not a mute", () => {
    const kept = applyRecentChangeDemotion(
      [change("vitals:bp", "vitals", { flagged: true })],
      new Set<RecentChangeCategory>(["vitals"])
    );
    expect(kept.map((c) => c.id)).toEqual(["vitals:bp"]);
  });
});

// ---- Data arrival: KINDS, not counts (#1819 item 2) -----------------------

describe("arrivalKind", () => {
  it("names the record kind a provenance row stands for", () => {
    expect(arrivalKind("activities", null)).toBe("workouts");
    expect(arrivalKind("body_metrics", null)).toBe("body measurements");
    expect(arrivalKind("medical_records", null)).toBe("lab results");
    expect(arrivalKind("practice_logs", null)).toBe("wellness sessions");
  });

  it("names a daily metric by its own vocabulary, not its storage key", () => {
    expect(arrivalKind("metric_samples", "sleep_min")).toBe("sleep");
    expect(arrivalKind("metric_samples", "steps")).toBe("steps");
    expect(arrivalKind("metric_samples", "resting_hr")).toBe(
      "resting heart rate"
    );
  });

  it("reads sensibly for a metric that has no entry yet", () => {
    expect(arrivalKind("metric_samples", "skin_temp_delta")).toBe(
      "skin temp delta"
    );
    expect(arrivalKind("metric_samples", "")).toBe("daily metrics");
  });
});

describe("arrivalKindsPhrase", () => {
  it("joins the distinct kinds in the order given", () => {
    expect(arrivalKindsPhrase(["sleep", "heart rate", "steps"])).toBe(
      "sleep, heart rate, steps"
    );
  });

  it("dedupes, because two written rows of one kind are still one kind", () => {
    expect(arrivalKindsPhrase(["steps", "steps", "sleep"])).toBe(
      "steps, sleep"
    );
  });

  it("caps the list — and the tail counts KINDS, never records", () => {
    const many = Array.from(
      { length: MAX_ARRIVAL_KINDS + 2 },
      (_, i) => `kind${i}`
    );
    expect(arrivalKindsPhrase(many)).toBe("kind0, kind1, kind2, kind3, +2 more");
  });

  it("says NOTHING when nothing nameable arrived — no count stands in for news", () => {
    expect(arrivalKindsPhrase([])).toBeNull();
    expect(arrivalKindsPhrase(["", "  "])).toBeNull();
  });
});

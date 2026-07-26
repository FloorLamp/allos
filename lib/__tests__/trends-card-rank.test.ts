import { describe, it, expect } from "vitest";
import {
  BODY_CARD_LAYOUT,
  BOOST_CONDITION,
  BOOST_GOAL,
  BOOST_LIFE_STAGE_LEAD,
  BOOST_LIFE_STAGE_MEMBER,
  BOOST_PRESENCE_RICH,
  EMPTY_TRENDS_CONTEXT,
  RICH_MIN_POINTS,
  applyCardOrder,
  bodyCardId,
  bodyCardOrder,
  conditionMonitorTags,
  growthCardLeads,
  presenceLevel,
  rankBodyCards,
  TRENDS_CARD_TABLE,
  type BodyCardId,
  type TrendsSubjectContext,
} from "@/lib/trends-card-rank";
import { RANK_SIGNAL_BUDGET } from "@/lib/rank-core";
import { BODY_METRIC_SLUGS } from "@/lib/trends-body-metrics";

const TODAY = "2026-07-26";

// A context in which no signal fires: an adult, no goals, no monitored condition,
// and uniform presence (everything "sparse" — the neutral bucket). This is the
// baseline the identity property is stated against.
const NEUTRAL: TrendsSubjectContext = EMPTY_TRENDS_CONTEXT;

function ctx(over: Partial<TrendsSubjectContext>): TrendsSubjectContext {
  return { ...NEUTRAL, ...over };
}

// Position of a card in an order, for readable assertions.
const at = (order: readonly BodyCardId[], id: BodyCardId) => order.indexOf(id);

describe("BODY_CARD_LAYOUT", () => {
  it("covers every registered body-metric slug exactly once", () => {
    const seen = new Set(BODY_CARD_LAYOUT);
    expect(seen.size).toBe(BODY_CARD_LAYOUT.length);
    for (const slug of BODY_METRIC_SLUGS) {
      expect(BODY_CARD_LAYOUT).toContain(slug);
    }
  });

  it("also names the three non-metric cards", () => {
    expect(BODY_CARD_LAYOUT).toContain("growth");
    expect(BODY_CARD_LAYOUT).toContain("sleep");
    expect(BODY_CARD_LAYOUT).toContain("hr-day");
  });
});

describe("the signal table", () => {
  it("stays inside the shared signal budget", () => {
    expect(TRENDS_CARD_TABLE.signals.length).toBeLessThanOrEqual(
      RANK_SIGNAL_BUDGET
    );
  });

  it("orders signal strengths so a stronger one can never be out-summed", () => {
    // life stage > condition > goal > presence, each strictly above the sum of the
    // weaker ones plus the whole base spread. This is what makes "peds leads with
    // growth" true even for a goal-carrying, condition-carrying, richly-tracked
    // profile.
    const baseSpread = BODY_CARD_LAYOUT.length;
    expect(BOOST_CONDITION).toBeGreaterThan(
      BOOST_GOAL + BOOST_PRESENCE_RICH + baseSpread
    );
    expect(BOOST_LIFE_STAGE_MEMBER).toBeGreaterThan(
      BOOST_CONDITION + BOOST_GOAL + BOOST_PRESENCE_RICH + baseSpread
    );
    expect(BOOST_LIFE_STAGE_LEAD).toBeGreaterThan(
      BOOST_LIFE_STAGE_MEMBER +
        BOOST_CONDITION +
        BOOST_GOAL +
        BOOST_PRESENCE_RICH +
        baseSpread
    );
  });
});

describe("presenceLevel", () => {
  it("calls an empty series none", () => {
    expect(presenceLevel(0, null, TODAY)).toBe("none");
    expect(presenceLevel(5, null, TODAY)).toBe("none");
  });

  it("calls a thin series sparse", () => {
    expect(presenceLevel(RICH_MIN_POINTS - 1, "2026-07-25", TODAY)).toBe(
      "sparse"
    );
  });

  it("calls a stale series sparse however many points it has", () => {
    expect(presenceLevel(500, "2026-01-01", TODAY)).toBe("sparse");
  });

  it("calls a well-populated recent series rich", () => {
    expect(presenceLevel(RICH_MIN_POINTS, "2026-07-20", TODAY)).toBe("rich");
  });

  it("buckets, so a fresher series does not overtake an equally-rich one", () => {
    // The retired orderBodyCharts sorted on raw latest-date, which resequenced the
    // page on every sync. Two recent series land in the SAME bucket now.
    expect(presenceLevel(30, "2026-07-26", TODAY)).toBe(
      presenceLevel(30, "2026-07-10", TODAY)
    );
  });
});

describe("conditionMonitorTags", () => {
  it("maps hypertension to the blood-pressure watch by code and by name", () => {
    expect(
      conditionMonitorTags([{ name: "Essential hypertension", code: "I10" }])
    ).toEqual(["blood-pressure"]);
    expect(
      conditionMonitorTags([{ name: "High blood pressure", code: null }])
    ).toEqual(["blood-pressure"]);
  });

  it("maps the arrhythmia / respiratory / weight families", () => {
    expect(
      conditionMonitorTags([{ name: "Atrial fibrillation", code: "I48.0" }])
    ).toEqual(["heart-rate"]);
    expect(conditionMonitorTags([{ name: "Asthma", code: "J45" }])).toEqual([
      "respiratory",
    ]);
    expect(conditionMonitorTags([{ name: "Obesity", code: "E66.9" }])).toEqual([
      "weight",
    ]);
  });

  it("stays silent for a condition this tab does not monitor (the exclusion discipline)", () => {
    // Diabetes is monitored by A1c/glucose — biomarkers, not Body-tab series. Over-
    // collapsing it into "boost weight" would invent a relevance nobody asked for.
    expect(
      conditionMonitorTags([
        { name: "Type 2 diabetes mellitus", code: "E11.9" },
      ])
    ).toEqual([]);
    expect(
      conditionMonitorTags([{ name: "Seasonal allergies", code: null }])
    ).toEqual([]);
  });

  it("de-duplicates two conditions that watch the same series", () => {
    expect(
      conditionMonitorTags([
        { name: "Essential hypertension", code: "I10" },
        { name: "Hypertensive heart disease", code: "I11.9" },
      ])
    ).toEqual(["blood-pressure"]);
  });
});

describe("rankBodyCards", () => {
  it("returns TODAY'S LAYOUT EXACTLY when no signal fires (the identity case)", () => {
    expect(rankBodyCards(NEUTRAL)).toEqual([...BODY_CARD_LAYOUT]);
  });

  it("leads with growth for a pediatric profile", () => {
    const order = rankBodyCards(ctx({ growthTracked: true }));
    expect(order[0]).toBe("growth");
    expect(at(order, "height")).toBeLessThan(at(order, "weight"));
    expect(at(order, "head-circ")).toBeLessThan(at(order, "weight"));
  });

  it("still leads with growth when a goal and a condition also fire", () => {
    const order = rankBodyCards(
      ctx({
        growthTracked: true,
        goalMetrics: ["weight"],
        monitors: ["blood-pressure"],
        presence: { systolic: "rich", weight: "rich" },
      })
    );
    expect(order[0]).toBe("growth");
  });

  it("leads with weight for an adult carrying a live weight goal", () => {
    const order = rankBodyCards(ctx({ goalMetrics: ["weight"] }));
    expect(order[0]).toBe("weight");
    // The goal metric also outranks every vital it used to sit behind.
    expect(at(order, "weight")).toBeLessThan(at(order, "systolic"));
  });

  it("leads with blood pressure for a monitored hypertensive profile", () => {
    const order = rankBodyCards(ctx({ monitors: ["blood-pressure"] }));
    expect(order.slice(0, 2)).toEqual(["systolic", "diastolic"]);
  });

  it("beats a goal with a monitored condition when both fire on different cards", () => {
    const order = rankBodyCards(
      ctx({ monitors: ["blood-pressure"], goalMetrics: ["weight"] })
    );
    expect(at(order, "systolic")).toBeLessThan(at(order, "weight"));
    // …and the goal card still outranks everything neutral.
    expect(at(order, "weight")).toBeLessThan(at(order, "spo2"));
  });

  it("sinks a card with no data below every card that has some (no-HRV-data)", () => {
    const order = rankBodyCards(
      ctx({ presence: { hrv: "none", steps: "rich", calories: "rich" } })
    );
    expect(at(order, "hrv")).toBeGreaterThan(at(order, "steps"));
    expect(at(order, "hrv")).toBeGreaterThan(at(order, "calories"));
    expect(order[order.length - 1]).toBe("hrv");
  });

  it("cannot promote an empty card even when every signal fires on it", () => {
    const order = rankBodyCards(
      ctx({
        growthTracked: true,
        goalMetrics: ["weight"],
        monitors: ["weight"],
        presence: { weight: "none", steps: "rich" },
      })
    );
    expect(at(order, "weight")).toBeGreaterThan(at(order, "steps"));
  });

  it("floats a richly-tracked series above a neutral one that sits higher in the layout", () => {
    // Nobody classified this profile as an athlete — its HRV simply has data.
    const order = rankBodyCards(ctx({ presence: { hrv: "rich" } }));
    expect(at(order, "hrv")).toBeLessThan(at(order, "systolic"));
  });

  it("is stable: the same context always yields the same order", () => {
    const c = ctx({ growthTracked: true, presence: { steps: "rich" } });
    expect(rankBodyCards(c)).toEqual(rankBodyCards(c));
  });
});

describe("bodyCardOrder (the stored-arrangement override)", () => {
  it("uses the ranked default for a never-arranged profile", () => {
    expect(bodyCardOrder(ctx({ goalMetrics: ["weight"] }), null)[0]).toBe(
      "weight"
    );
  });

  it("lets a stored arrangement win over every signal, forever", () => {
    const stored = ["mood", "steps", "weight"];
    const order = bodyCardOrder(
      ctx({
        growthTracked: true,
        goalMetrics: ["weight"],
        monitors: ["blood-pressure"],
      }),
      stored
    );
    expect(order.slice(0, 3)).toEqual(["mood", "steps", "weight"]);
  });

  it("appends a card the arrangement has never seen without reshuffling it", () => {
    const order = bodyCardOrder(ctx({ growthTracked: true }), [
      "mood",
      "steps",
    ]);
    expect(order.slice(0, 2)).toEqual(["mood", "steps"]);
    // growth is boosted to the top of what REMAINS, never above the arrangement.
    expect(order[2]).toBe("growth");
  });
});

describe("applyCardOrder", () => {
  it("sequences a renderer's list by the card order", () => {
    const charts = [{ key: "weight" }, { key: "systolic" }, { key: "hrv" }];
    expect(
      applyCardOrder(charts, ["hrv", "weight", "systolic"], (c) => c.key).map(
        (c) => c.key
      )
    ).toEqual(["hrv", "weight", "systolic"]);
  });

  it("normalizes the section's legacy chart keys onto card ids", () => {
    expect(bodyCardId("resting_hr")).toBe("resting-hr");
    expect(bodyCardId("skin_temp")).toBe("skin-temp");
    expect(bodyCardId("bodyfat")).toBe("body-fat");
    expect(bodyCardId("head_circumference")).toBe("head-circ");
    const charts = [{ key: "bodyfat" }, { key: "weight" }];
    expect(
      applyCardOrder(charts, ["body-fat", "weight"], (c) => c.key).map(
        (c) => c.key
      )
    ).toEqual(["bodyfat", "weight"]);
  });

  it("keeps an unranked item at the end instead of dropping it", () => {
    const charts = [{ key: "mystery" }, { key: "weight" }];
    expect(
      applyCardOrder(charts, ["weight"], (c) => c.key).map((c) => c.key)
    ).toEqual(["weight", "mystery"]);
  });
});

describe("growthCardLeads", () => {
  it("is true when growth outranks every card in the chart block", () => {
    const order = rankBodyCards(ctx({ growthTracked: true }));
    expect(growthCardLeads(order, ["systolic", "weight", "height"])).toBe(true);
  });

  it("is false for an adult, whose growth card trails the chart block", () => {
    const order = rankBodyCards(NEUTRAL);
    expect(growthCardLeads(order, ["systolic", "weight"])).toBe(false);
  });

  it("is false once a user's arrangement puts a chart above growth", () => {
    const order = bodyCardOrder(ctx({ growthTracked: true }), [
      "weight",
      "growth",
    ]);
    expect(growthCardLeads(order, ["weight"])).toBe(false);
  });
});

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

describe("the everyday-first tie-break (#1659)", () => {
  // Both-rich is the NORMAL state for a wearable profile: an Oura ring or a watch
  // reports SpO₂ nightly, so SpO₂ is "rich" the moment steps is and the presence
  // signal fires equally for both. The static layout is then the whole decision.
  const WEARABLE = ctx({
    presence: {
      steps: "rich",
      spo2: "rich",
      "resting-hr": "rich",
      hrv: "rich",
      sleep: "rich",
      systolic: "rich",
      weight: "rich",
    },
  });

  it("leads a both-rich wearable profile with the everyday block, not clinical vitals", () => {
    const order = rankBodyCards(WEARABLE);
    expect(at(order, "steps")).toBeLessThan(at(order, "spo2"));
    expect(at(order, "sleep")).toBeLessThan(at(order, "spo2"));
    expect(at(order, "resting-hr")).toBeLessThan(at(order, "systolic"));
    expect(at(order, "hrv")).toBeLessThan(at(order, "spo2"));
    expect(at(order, "weight")).toBeLessThan(at(order, "systolic"));
  });

  it("still lifts SpO₂ for a profile whose condition actually watches it", () => {
    // Clinical-when-relevant is the SIGNAL's job, not the base order's — which is
    // the whole reason the base could be re-sequenced without losing anything.
    const order = rankBodyCards({ ...WEARABLE, monitors: ["respiratory"] });
    expect(at(order, "spo2")).toBeLessThan(at(order, "steps"));
    expect(at(order, "respiratory-rate")).toBeLessThan(at(order, "steps"));
  });

  it("keeps the layout's own judgment calls: sun is everyday, hrv is a HR-family card", () => {
    expect(at(BODY_CARD_LAYOUT, "sun")).toBeLessThan(
      at(BODY_CARD_LAYOUT, "systolic")
    );
    expect(at(BODY_CARD_LAYOUT, "hrv")).toBeLessThan(
      at(BODY_CARD_LAYOUT, "mood")
    );
    expect(at(BODY_CARD_LAYOUT, "resting-hr")).toBeLessThan(
      at(BODY_CARD_LAYOUT, "systolic")
    );
    // The synced composition tail stays behind the clinical run.
    expect(at(BODY_CARD_LAYOUT, "temperature")).toBeLessThan(
      at(BODY_CARD_LAYOUT, "bmi")
    );
  });
});

describe("bodyCardOrder (★-pinned first, ranked remainder — #1643)", () => {
  it("uses the ranked default for a profile that has pinned nothing", () => {
    expect(bodyCardOrder(NEUTRAL, null)).toEqual([...BODY_CARD_LAYOUT]);
    expect(bodyCardOrder(NEUTRAL, [])).toEqual([...BODY_CARD_LAYOUT]);
    expect(bodyCardOrder(ctx({ goalMetrics: ["weight"] }), null)[0]).toBe(
      "weight"
    );
  });

  it("leads with the pinned cards, in the SAVED order, over every ordinary signal", () => {
    const order = bodyCardOrder(
      ctx({
        goalMetrics: ["weight"],
        monitors: ["blood-pressure"],
        presence: { steps: "rich", systolic: "rich", weight: "rich" },
      }),
      ["mood", "steps", "weight"]
    );
    expect(order.slice(0, 3)).toEqual(["mood", "steps", "weight"]);
  });

  it("ranks everything unpinned behind the pinned run, undisturbed", () => {
    const order = bodyCardOrder(ctx({ monitors: ["blood-pressure"] }), [
      "mood",
    ]);
    expect(order[0]).toBe("mood");
    // The remainder is exactly the ranked default with the pin removed.
    expect(order.slice(1)).toEqual(
      rankBodyCards(ctx({ monitors: ["blood-pressure"] })).filter(
        (id) => id !== "mood"
      )
    );
  });

  it("lets an explicit ★ beat the no-data floor", () => {
    // The floor sinks an empty card below every card with data — a neutral signal.
    // A pin is not neutral: the user said this card matters, so it renders in the
    // pinned run rather than at the bottom of the tab.
    const c = ctx({ presence: { hrv: "none", steps: "rich" } });
    expect(rankBodyCards(c).at(-1)).toBe("hrv");
    expect(bodyCardOrder(c, ["hrv"])[0]).toBe("hrv");
  });

  it("drops a pin that names no card, rather than leaving a hole", () => {
    const order = bodyCardOrder(NEUTRAL, ["retired-card", "mood"]);
    expect(order[0]).toBe("mood");
    expect(order).toHaveLength(BODY_CARD_LAYOUT.length);
    expect(new Set(order).size).toBe(BODY_CARD_LAYOUT.length);
  });

  it("keeps LIFE STAGE above the pins — membership is not a preference", () => {
    // planBodyCharts' `growthCardFirst` was a MEMBERSHIP-tier fork before #1490
    // moved it into the signal table, and #1643's precedence rule says membership
    // wins over ★. So a growth-tracked profile still leads with its percentile card
    // and its growth-charted measures, whatever it has starred.
    const order = bodyCardOrder(ctx({ growthTracked: true }), [
      "mood",
      "steps",
      "weight",
    ]);
    expect(order.slice(0, 3)).toEqual(["growth", "height", "head-circ"]);
    expect(order.slice(3, 6)).toEqual(["mood", "steps", "weight"]);
  });

  it("leaves an adult's pins untouched by the structural rule", () => {
    // Nothing is structural for an adult, so the pinned run really is the front.
    const order = bodyCardOrder(ctx({ goalMetrics: ["weight"] }), ["sun"]);
    expect(order[0]).toBe("sun");
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

// `growthCardLeads` and `orderCardSections` were tested here until #1674 retired
// their subjects with the census's titled boxes. What replaced both is the flat
// stack's single ordering pass, so the properties they approximated are now
// assertions about the ORDER itself:
//
//   • "the growth card leads" is `bodyCardOrder(...)[0] === "growth"` for a
//     growth-tracked profile — no predicate needed, and a ★ still cannot displace it;
//   • "a promotion is visible" is the promoted card's own index, with no run to lift.
describe("the flat stack replaces run-level ordering (#1674)", () => {
  it("leads with the growth card for a growth-tracked profile, ★ or not", () => {
    expect(rankBodyCards(ctx({ growthTracked: true }))[0]).toBe("growth");
    // #1643's precedence: an explicit ★ beats the presence floor but not the
    // life-stage tier, so the percentile card still heads a child's stack.
    expect(bodyCardOrder(ctx({ growthTracked: true }), ["weight"])[0]).toBe(
      "growth"
    );
  });

  it("does not lead with it for an adult", () => {
    expect(rankBodyCards(NEUTRAL)[0]).not.toBe("growth");
  });

  it("makes a promotion visible without lifting a box around it", () => {
    // A monitored condition promotes `systolic` ITSELF above the everyday cards it
    // used to ride behind — the #1674 bug class, stated as the property that fixes
    // it: the clinical card moves, its old box-mates do not come along.
    const monitored = rankBodyCards(ctx({ monitors: ["blood-pressure"] }));
    const neutral = rankBodyCards(NEUTRAL);
    expect(monitored.indexOf("systolic")).toBeLessThan(
      neutral.indexOf("systolic")
    );
    // …and a card that shared the retired "Vitals" box with it is NOT dragged up
    // with it (respiratory rate is not what the monitor watches).
    expect(monitored.indexOf("systolic")).toBeLessThan(
      monitored.indexOf("respiratory-rate")
    );
  });

  it("ranks the synced-daily cards against the clinical ones, not below them", () => {
    // The reported case (#1674): under the everyday-first base, steps outrank SpO₂
    // — impossible while the synced block sat outside the ordering entirely.
    const order = rankBodyCards(NEUTRAL);
    expect(order.indexOf("steps")).toBeLessThan(order.indexOf("spo2"));
  });
});

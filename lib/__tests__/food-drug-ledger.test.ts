import { describe, it, expect } from "vitest";
import {
  detectFoodDrugEvents,
  detectFoodDrugVariance,
  foodDrugEventDetail,
  foodDrugEventEvidence,
  foodDrugEventKey,
  foodDrugEventTitle,
  foodDrugVarianceEvidence,
  foodDrugVarianceTitle,
  isSwing,
  ruleWindow,
  withinRuleWindow,
  FOOD_DRUG_VARIANCE_MIN_PRIOR_DAYS,
  type LedgerItem,
  type LedgerServing,
} from "@/lib/food-drug-ledger";
import { matchFoodInteractions } from "@/lib/food-drug-interactions";
import { summarizeBand } from "@/lib/notifications/upcoming-digest";
import type { BandGroup, UpcomingItem } from "@/lib/upcoming";

// The pure food-log × food–drug join (issue #2021). The behaviour under test is mostly
// about REFUSING: firing only on entries whose committed mapping says the day-granular
// log can speak to them, only inside the item's own course window plus the entry's own
// stated tail, and only on a swing big enough that it is a change rather than a weekend.

const ADULT = 40;

function hitsFor(name: string) {
  return matchFoodInteractions({ name, rxcui: null }, ADULT);
}

function item(over: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id: 1,
    name: "Flagyl",
    active: true,
    courseStart: "2026-08-01",
    courseEnd: "2026-08-07",
    hits: hitsFor("metronidazole"),
    ...over,
  };
}

function servings(rows: [string, string, number][]): LedgerServing[] {
  return rows.map(([group, date, n]) => ({ group, date, servings: n }));
}

describe("ruleWindow (#2021)", () => {
  it("extends the END by the entry's own tail, never the start", () => {
    expect(ruleWindow(item(), 3)).toEqual({
      start: "2026-08-01",
      end: "2026-08-10",
    });
    expect(ruleWindow(item())).toEqual({
      start: "2026-08-01",
      end: "2026-08-07",
    });
  });

  it("an ACTIVE item with no declared end is open at the end", () => {
    expect(ruleWindow(item({ courseEnd: null }), 3)).toEqual({
      start: "2026-08-01",
      end: null,
    });
  });

  it("an INACTIVE item with no declared end has NO window (silence over a guess)", () => {
    // We cannot date "when treatment stopped", so the tail is uncomputable and nothing
    // may fire — the alternative is inventing an end date on a safety line.
    expect(ruleWindow(item({ active: false, courseEnd: null }), 3)).toBeNull();
  });

  it("is inclusive at both ends, and open where a bound is null", () => {
    const w = { start: "2026-08-01", end: "2026-08-10" };
    expect(withinRuleWindow(w, "2026-08-01")).toBe(true);
    expect(withinRuleWindow(w, "2026-08-10")).toBe(true);
    expect(withinRuleWindow(w, "2026-07-31")).toBe(false);
    expect(withinRuleWindow(w, "2026-08-11")).toBe(false);
    expect(withinRuleWindow({ start: null, end: null }, "1999-01-01")).toBe(
      true
    );
  });
});

describe("detectFoodDrugEvents (#2021)", () => {
  const alcohol = (date: string, n = 1): LedgerServing[] =>
    servings([["alcohol", date, n]]);

  it("fires on a serving logged DURING the course", () => {
    const found = detectFoodDrugEvents(
      [item()],
      alcohol("2026-08-03", 2),
      "2026-08-03"
    );
    expect(found).toHaveLength(1);
    expect(found[0].dedupeKey).toBe(
      foodDrugEventKey(1, "alcohol-metronidazole", "2026-08-03")
    );
    expect(found[0].servings).toBe(2);
    expect(found[0].daysAfterCourse).toBe(0);
  });

  it("still fires inside the label's stated 3-day tail, and stops after it", () => {
    const inTail = detectFoodDrugEvents(
      [item()],
      alcohol("2026-08-10"),
      "2026-08-10"
    );
    expect(inTail).toHaveLength(1);
    expect(inTail[0].daysAfterCourse).toBe(3);
    expect(
      detectFoodDrugEvents([item()], alcohol("2026-08-11"), "2026-08-11")
    ).toEqual([]);
  });

  it("stays silent before the course starts", () => {
    expect(
      detectFoodDrugEvents([item()], alcohol("2026-07-30"), "2026-07-30")
    ).toEqual([]);
  });

  it("stays silent when nothing from the mapped group was logged", () => {
    expect(
      detectFoodDrugEvents(
        [item()],
        servings([["leafy_greens", "2026-08-03", 4]]),
        "2026-08-03"
      )
    ).toEqual([]);
    expect(detectFoodDrugEvents([item()], [], "2026-08-03")).toEqual([]);
  });

  it("stays silent when no item with an alcohol rule is in window", () => {
    // Same serving, an item whose only rule is EXCLUDED from the ledger (grapefruit ×
    // statin): the mapping physically cannot fire.
    const statin = item({ id: 7, name: "Zocor", hits: hitsFor("simvastatin") });
    expect(
      detectFoodDrugEvents([statin], alcohol("2026-08-03"), "2026-08-03")
    ).toEqual([]);
    // …and a dairy rule, which IS mapped to a group but declares rule "none" because it
    // is a separation window.
    const cipro = item({
      id: 8,
      name: "Cipro",
      hits: hitsFor("ciprofloxacin"),
    });
    expect(
      detectFoodDrugEvents(
        [cipro],
        servings([["dairy", "2026-08-03", 2]]),
        "2026-08-03"
      )
    ).toEqual([]);
  });

  it("one serving can raise a finding per matching item, each keyed to its own item", () => {
    const warfarin = item({
      id: 2,
      name: "Coumadin",
      courseEnd: null,
      hits: hitsFor("warfarin"),
    });
    const found = detectFoodDrugEvents(
      [item(), warfarin],
      alcohol("2026-08-03"),
      "2026-08-03"
    );
    expect(found.map((f) => f.dedupeKey)).toEqual([
      foodDrugEventKey(1, "alcohol-metronidazole", "2026-08-03"),
      foodDrugEventKey(2, "alcohol-warfarin", "2026-08-03"),
    ]);
  });

  it("states the fact and the label's own line, and judges nothing", () => {
    const [f] = detectFoodDrugEvents(
      [item()],
      alcohol("2026-08-03", 2),
      "2026-08-03"
    );
    expect(foodDrugEventTitle(f)).toBe(
      "Alcohol logged today while taking Flagyl"
    );
    expect(foodDrugEventEvidence(f)).toBe(
      "2 servings of alcohol in today's food log."
    );
    const detail = foodDrugEventDetail(f);
    // The entry's OWN advice sentence, verbatim, plus citation and the mandatory tail.
    expect(detail).toContain(
      "Avoid all alcohol during treatment and for 3 days after"
    );
    expect(detail).toContain(
      "Source: FDA metronidazole prescribing information"
    );
    expect(detail).toContain("Informational, not medical advice.");
    // No verdict about the person.
    expect(detail).not.toMatch(/you should|shouldn't|must not|stop taking/i);
    expect(foodDrugEventTitle(f)).not.toMatch(/you should|avoid|warning/i);
  });

  it("names the tail honestly once the course is over", () => {
    const [f] = detectFoodDrugEvents(
      [item()],
      alcohol("2026-08-09"),
      "2026-08-09"
    );
    expect(foodDrugEventTitle(f)).toBe(
      "Alcohol logged today, 2 days after finishing Flagyl"
    );
  });
});

describe("detectFoodDrugVariance (#2021)", () => {
  const warfarin = item({
    id: 3,
    name: "Coumadin",
    courseStart: null,
    courseEnd: null,
    hits: hitsFor("warfarin"),
  });
  const TODAY = "2026-08-14";
  // Two full weeks of greens: the prior week light, this week heavy.
  const greens = (perDay: number, from: string): LedgerServing[] =>
    Array.from({ length: 7 }, (_, i) => ({
      group: "leafy_greens",
      date: shift(from, i),
      servings: perDay,
    }));

  it("fires on a week-over-week swing, quoting the steadiness advice", () => {
    const rows = [...greens(0.5, "2026-08-01"), ...greens(2, "2026-08-08")];
    const [f] = detectFoodDrugVariance([warfarin], rows, TODAY, 7);
    expect(f.dedupeKey).toBe("food-drug-variance:3:vitamin-k-warfarin");
    expect(f.direction).toBe("up");
    expect(foodDrugVarianceTitle(f)).toBe(
      "Leafy greens up this week — Coumadin"
    );
    expect(foodDrugVarianceEvidence(f)).toBe(
      "14 servings in the last 7 days vs 3.5 servings in the 7 before."
    );
  });

  it("is silent on a steady week", () => {
    const rows = [...greens(2, "2026-08-01"), ...greens(2, "2026-08-08")];
    expect(detectFoodDrugVariance([warfarin], rows, TODAY, 7)).toEqual([]);
  });

  it("is silent when the prior window has too little logging to compare against", () => {
    // The adoption guard: a profile that started logging this week has not changed its
    // diet, it has changed its habits with the app.
    const rows = greens(2, "2026-08-08");
    expect(
      detectFoodDrugVariance(
        [warfarin],
        rows,
        TODAY,
        FOOD_DRUG_VARIANCE_MIN_PRIOR_DAYS - 1
      )
    ).toEqual([]);
  });

  it("needs BOTH gates — an absolute floor and a doubling", () => {
    expect(isSwing(9, 2)).toBe(true);
    expect(isSwing(2, 9)).toBe(true);
    // Clears the floor, but not a doubling.
    expect(isSwing(10, 7)).toBe(false);
    // Doubles, but only by two servings.
    expect(isSwing(4, 2)).toBe(false);
    expect(isSwing(5, 5)).toBe(false);
    expect(isSwing(0, 0)).toBe(false);
  });

  it("does not fire the variance rule on an event-mapped entry, or vice versa", () => {
    const rows = [
      ...greens(0.5, "2026-08-01"),
      ...greens(2, "2026-08-08"),
      { group: "alcohol", date: TODAY, servings: 1 },
    ];
    // The alcohol rules are `event`: they never produce a variance finding…
    const variance = detectFoodDrugVariance([warfarin], rows, TODAY, 7);
    expect(variance.map((f) => f.ruleId)).toEqual(["vitamin-k-warfarin"]);
    // …and the vitamin-K rule is `variance`: it never produces an event finding.
    const events = detectFoodDrugEvents([warfarin], rows, TODAY);
    expect(events.map((f) => f.ruleId)).toEqual(["alcohol-warfarin"]);
  });
});

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("reach: care tier, no push channel (#2021)", () => {
  it("the digest cannot count a food–drug event, because it is not in its sequence", () => {
    // The tier is a CEILING, not a floor (#1433). The event finding reaches Upcoming and
    // the hero because it belongs to the med-safety family, and reaches no send at all
    // because nobody declared "tell me when I drink" — the contact-consent rule. The
    // digest's domain sequence is where that is enforced, and `summarizeBand` drops any
    // domain missing from it, so an event item in a band summarizes to nothing.
    const item: UpcomingItem = {
      key: "food-drug-event:1:alcohol-metronidazole:2026-08-03",
      domain: "food-drug-event",
      title: "Alcohol logged today while taking Flagyl",
      detail: null,
      href: "/medications",
      dueDate: null,
      band: "today",
    };
    const group: BandGroup = { band: "today", label: "Today", items: [item] };
    expect(summarizeBand(group)).toBe("");
  });
});

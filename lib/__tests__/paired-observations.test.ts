// PURE TIER — the paired-observations registry (#2177): its completeness guard, the
// measure, every gate boundary (n−1 silent / n speaks), and the copy contract.
//
// The registry is DATA and the enforcement is this reflection test — the house pattern
// (METRIC_KNOWLEDGE, SEND_MARKER_REGISTRY, DISMISSAL_KEY_REGISTRY, CADENCE_SCOPES).
// A pair without its ARGUMENT, without a gate, or with a duplicate id fails here.

import { describe, it, expect } from "vitest";
import {
  armsAreSpread,
  copyIsObservational,
  decidePairedObservation,
  pairedDays,
  pairedObservationDetail,
  pairedObservationEvidence,
  pairedObservationKey,
  pairedWindowStart,
  PAIRED_OBS_PREFIX,
  PAIRED_OBSERVATION_IDS,
  PAIRED_OBSERVATION_LIST,
  PAIRED_OBSERVATION_NON_MEMBERS,
  PAIRED_OBSERVATIONS,
  type PairedDay,
  type PairedObservationSpec,
} from "@/lib/paired-observations";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { DISMISSAL_KEY_REGISTRY } from "@/lib/dismissal-classes";
import { shiftDateStr } from "@/lib/date";

const TODAY = "2026-08-09";

const ALCOHOL_HRV = PAIRED_OBSERVATIONS["alcohol-hrv"];

// A spec-shaped fixture with tiny gates, so the measure's own boundaries are tested
// without depending on any shipped pair's constants.
const FIXTURE: PairedObservationSpec = {
  ...ALCOHOL_HRV,
  id: "alcohol-hrv",
  windowDays: 20,
  minPairedDaysPerArm: 3,
  effectFloor: 5,
  outcomeCurrentDays: 7,
};

// Build alternating factor/outcome days ending at `today`: `n` days, factor true on
// every other one, present-arm values `presentValue`, absent-arm `absentValue`.
function alternating(
  n: number,
  presentValue: number,
  absentValue: number,
  today = TODAY
): { factorDays: Set<string>; outcome: { date: string; value: number }[] } {
  const factorDays = new Set<string>();
  const outcome: { date: string; value: number }[] = [];
  for (let back = n - 1; back >= 0; back--) {
    const day = shiftDateStr(today, -back);
    const present = back % 2 === 0;
    if (present) factorDays.add(day);
    // Lag 1: the outcome lands on the day AFTER the factor day.
    outcome.push({
      date: shiftDateStr(day, 1),
      value: present ? presentValue : absentValue,
    });
  }
  return { factorDays, outcome };
}

describe("PAIRED_OBSERVATIONS — the registry's completeness guard", () => {
  it("is small, and every declared id has exactly one entry", () => {
    expect(PAIRED_OBSERVATION_IDS.length).toBeGreaterThan(0);
    // #2177: "start ≤6 pairs". The registry IS the multiplicity control; growing it
    // past a reviewable set needs a decision, not a merge.
    expect(PAIRED_OBSERVATION_IDS.length).toBeLessThanOrEqual(6);
    expect(new Set(PAIRED_OBSERVATION_IDS).size).toBe(
      PAIRED_OBSERVATION_IDS.length
    );
    for (const id of PAIRED_OBSERVATION_IDS) {
      expect(PAIRED_OBSERVATIONS[id]?.id).toBe(id);
    }
    expect(PAIRED_OBSERVATION_LIST).toHaveLength(PAIRED_OBSERVATION_IDS.length);
  });

  it("every pair carries a real ARGUMENT for why it is worth surfacing", () => {
    for (const spec of PAIRED_OBSERVATION_LIST) {
      // A pair that is merely computable is not a pair that belongs; the argument is
      // where that judgement is recorded. A one-word placeholder fails.
      expect(spec.argument.trim().length, spec.id).toBeGreaterThan(80);
      expect(spec.gateArgument.trim().length, spec.id).toBeGreaterThan(60);
    }
  });

  it("every pair declares positive gates, a floor, a window and a lag", () => {
    for (const spec of PAIRED_OBSERVATION_LIST) {
      expect(spec.minPairedDaysPerArm, spec.id).toBeGreaterThan(0);
      expect(spec.effectFloor, spec.id).toBeGreaterThan(0);
      expect(spec.outcomeCurrentDays, spec.id).toBeGreaterThan(0);
      expect(spec.lagDays, spec.id).toBe(1);
      // Both arms must be able to exist inside the window at all.
      expect(spec.windowDays, spec.id).toBeGreaterThanOrEqual(
        spec.minPairedDaysPerArm * 2
      );
      expect(spec.title.trim(), spec.id).not.toBe("");
      expect(spec.presentLabel, spec.id).toMatch(/logged/);
      expect(spec.absentLabel, spec.id).toMatch(/logged/);
    }
  });

  it("the argued NON-members are recorded with their reasons", () => {
    expect(PAIRED_OBSERVATION_NON_MEMBERS.length).toBeGreaterThan(0);
    for (const x of PAIRED_OBSERVATION_NON_MEMBERS) {
      expect(x.subject.trim()).not.toBe("");
      expect(x.reason.trim().length).toBeGreaterThan(80);
    }
    // The #992 bridge's exclusion is the one a reviewer will look for first.
    expect(
      PAIRED_OBSERVATION_NON_MEMBERS.some((x) => /sleep↔mood/.test(x.subject))
    ).toBe(true);
  });

  it("keys ride the registered coaching namespace", () => {
    for (const spec of PAIRED_OBSERVATION_LIST) {
      const key = pairedObservationKey(spec.id, "2026-08");
      expect(key.startsWith(PAIRED_OBS_PREFIX)).toBe(true);
      expect(dedupeKeyHasKnownPrefix(key)).toBe(true);
      // A correlation-shaped observation is COACHING, never care.
      expect(tierForDedupeKey(key)).toBe("coaching");
    }
    // The month anchor is the episode anchor (#436): a new month is a new key.
    expect(pairedObservationKey("alcohol-hrv", "2026-08")).not.toBe(
      pairedObservationKey("alcohol-hrv", "2026-09")
    );
    // Registered in the dismissal-key registry as `anchored`.
    const entry = DISMISSAL_KEY_REGISTRY.find(
      (e) => e.prefix === PAIRED_OBS_PREFIX
    );
    expect(entry?.keyClass).toBe("anchored");
  });
});

describe("pairedDays — the pairing", () => {
  it("pairs a factor day with the outcome measured `lagDays` later", () => {
    const { factorDays, outcome } = alternating(6, 40, 50);
    const days = pairedDays(FIXTURE, factorDays, outcome, TODAY);
    // The newest factor day is today; its outcome lands tomorrow, which does not
    // exist yet — so `alternating` supplied it and it pairs. Ordering is oldest→newest.
    expect(days.map((d) => d.date)).toEqual(
      [5, 4, 3, 2, 1, 0].map((b) => shiftDateStr(TODAY, -b))
    );
    expect(days.filter((d) => d.present)).toHaveLength(3);
  });

  it("drops days with no measured outcome, and days outside the window", () => {
    const { factorDays } = alternating(6, 40, 50);
    const days = pairedDays(
      FIXTURE,
      factorDays,
      [
        // Well before the 20-day window.
        { date: shiftDateStr(TODAY, -80), value: 42 },
        { date: shiftDateStr(TODAY, -2), value: 42 },
      ],
      TODAY
    );
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe(shiftDateStr(TODAY, -3));
  });
});

describe("armsAreSpread — the interleaving gate", () => {
  const day = (i: number, present: boolean): PairedDay => ({
    date: shiftDateStr(TODAY, -(20 - i)),
    present,
    value: 1,
  });

  it("accepts arms that alternate through the window", () => {
    expect(
      armsAreSpread([0, 1, 2, 3, 4, 5].map((i) => day(i, i % 2 === 0)))
    ).toBe(true);
  });

  it("rejects two PHASES — all-present early, all-absent late", () => {
    // The "I logged my drinking for three weeks and then stopped" shape: the arms are
    // two stretches of a life, and the difference between them is everything else.
    expect(
      armsAreSpread([0, 1, 2, 3, 4, 5].map((i) => day(i, i < 3)))
    ).toBe(false);
  });
});

describe("decidePairedObservation — the gates", () => {
  function decide(
    n: number,
    presentValue: number,
    absentValue: number,
    today = TODAY,
    spec: PairedObservationSpec = FIXTURE
  ) {
    const { factorDays, outcome } = alternating(
      n,
      presentValue,
      absentValue,
      today
    );
    return decidePairedObservation(
      spec,
      pairedDays(spec, factorDays, outcome, today),
      today
    );
  }

  it("speaks at the per-arm minimum and is silent one datapoint below it", () => {
    // 6 alternating days → 3 per arm (the fixture's minimum) → speaks.
    const at = decide(6, 40, 52);
    expect(at).not.toBeNull();
    expect(at!.present.days).toBe(3);
    expect(at!.absent.days).toBe(3);
    // 5 alternating days → 3 present / 2 absent → the ABSENT arm is one short → silent.
    expect(decide(5, 40, 52)).toBeNull();
  });

  it("is silent below the effect floor and speaks at it", () => {
    // |40 − 44| = 4 < 5 → nothing. Not a hedged finding: nothing at all.
    expect(decide(8, 40, 44)).toBeNull();
    // Exactly the floor renders (the floor is a minimum, not a strict threshold).
    expect(decide(8, 40, 45)).not.toBeNull();
  });

  it("reports both arms' means and n, and the signed delta", () => {
    const cmp = decide(8, 40, 52)!;
    expect(cmp.present.mean).toBe(40);
    expect(cmp.absent.mean).toBe(52);
    expect(cmp.delta).toBe(-12);
    expect(cmp.pairedDays).toBe(8);
  });

  it("is silent when the outcome stream has gone quiet", () => {
    // The same data, but the newest reading is older than the declared currency
    // window: a dead stream cannot produce a present-tense observation (#2097/#2146).
    const anchor = shiftDateStr(TODAY, -30);
    const { factorDays, outcome } = alternating(8, 40, 52, anchor);
    const days = pairedDays(FIXTURE, factorDays, outcome, TODAY);
    expect(decidePairedObservation(FIXTURE, days, TODAY)).toBeNull();
    // …and the same rows, read on the day they ended, do speak.
    expect(
      decidePairedObservation(
        FIXTURE,
        pairedDays(FIXTURE, factorDays, outcome, anchor),
        anchor
      )
    ).not.toBeNull();
  });

  it("is silent when the two arms are two phases rather than two conditions", () => {
    const factorDays = new Set<string>();
    const outcome: { date: string; value: number }[] = [];
    for (let back = 11; back >= 0; back--) {
      const d = shiftDateStr(TODAY, -back);
      const present = back >= 6; // all the early days, none of the late ones
      if (present) factorDays.add(d);
      outcome.push({
        date: shiftDateStr(d, 1),
        value: present ? 40 : 52,
      });
    }
    const days = pairedDays(FIXTURE, factorDays, outcome, TODAY);
    expect(days.filter((d) => d.present)).toHaveLength(6);
    expect(days.filter((d) => !d.present)).toHaveLength(6);
    expect(decidePairedObservation(FIXTURE, days, TODAY)).toBeNull();
  });

  it("holds every SHIPPED pair to its own declared gates", () => {
    for (const spec of PAIRED_OBSERVATION_LIST) {
      const n = spec.minPairedDaysPerArm * 2;
      const over = spec.effectFloor * 2;
      // One datapoint short in one arm → silence, at the pair's OWN minimum.
      expect(decide(n - 1, 100, 100 + over, TODAY, spec), spec.id).toBeNull();
      expect(decide(n, 100, 100 + over, TODAY, spec), spec.id).not.toBeNull();
      // Just under the pair's OWN floor → silence.
      expect(
        decide(n, 100, 100 + spec.effectFloor - 0.01, TODAY, spec),
        spec.id
      ).toBeNull();
    }
  });

  it("pairedWindowStart spans exactly windowDays inclusive", () => {
    expect(pairedWindowStart(FIXTURE, TODAY)).toBe(shiftDateStr(TODAY, -19));
  });
});

describe("the copy contract", () => {
  it("states both arms' n and both means, and never a causal or advice verb", () => {
    for (const spec of PAIRED_OBSERVATION_LIST) {
      const cmp = {
        id: spec.id,
        present: { days: 21, mean: 42.4 },
        absent: { days: 9, mean: 54.4 },
        delta: -12,
        latestOutcomeDay: TODAY,
        pairedDays: 30,
      };
      const detail = pairedObservationDetail(spec, cmp);
      const evidence = pairedObservationEvidence(spec, cmp);
      // Constraint 3: an observation that hides its sample size is how trust erodes.
      expect(detail, spec.id).toContain("21");
      expect(detail, spec.id).toContain("9");
      expect(detail, spec.id).toContain(spec.presentLabel);
      expect(detail, spec.id).toContain(spec.absentLabel);
      // Absence is absence of a LOG, and the evidence line says so.
      expect(evidence, spec.id).toContain("none logged");
      for (const text of [spec.title, detail, evidence]) {
        expect(copyIsObservational(text), `${spec.id}: ${text}`).toBe(true);
      }
    }
  });

  it("copyIsObservational rejects the sentences the arithmetic cannot support", () => {
    expect(
      copyIsObservational("Your mood is worse when you sleep under 6h.")
    ).toBe(false);
    expect(copyIsObservational("Consider cutting back on evening drinks.")).toBe(
      false
    );
    expect(copyIsObservational("Drinking causes lower overnight HRV.")).toBe(
      false
    );
    expect(
      copyIsObservational(
        "On the 21 nights after an evening with a drink logged, overnight HRV averaged 42 ms."
      )
    ).toBe(true);
  });

  it("renders the alcohol↔HRV note exactly as reviewed", () => {
    const detail = pairedObservationDetail(PAIRED_OBSERVATIONS["alcohol-hrv"], {
      id: "alcohol-hrv",
      present: { days: 21, mean: 42.4 },
      absent: { days: 9, mean: 54.4 },
      delta: -12,
      latestOutcomeDay: TODAY,
      pairedDays: 30,
    });
    expect(detail).toBe(
      "Over the last 3 months, on the 21 nights after an evening with a drink " +
        "logged, overnight HRV averaged 42 ms. On the 9 nights after an evening " +
        "with none logged, it averaged 54 ms. Both figures are averages of your " +
        "own readings — the two often move together, which is not the same as one " +
        "moving the other."
    );
  });

  it("renders a duration outcome on a clock, not in raw minutes", () => {
    const detail = pairedObservationDetail(
      PAIRED_OBSERVATIONS["training-sleep"],
      {
        id: "training-sleep",
        present: { days: 22, mean: 445 },
        absent: { days: 14, mean: 402 },
        delta: 43,
        latestOutcomeDay: TODAY,
        pairedDays: 36,
      }
    );
    expect(detail).toContain("7h 25m");
    expect(detail).toContain("6h 42m");
  });
});

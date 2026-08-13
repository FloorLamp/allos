// PURE TIER — the paired-observations registry (#2177) and its engine.
//
// Two jobs. First the GATE MATRIX per pair: below the per-arm night minimum → nothing;
// above the minimum but below the effect floor → nothing; both crossed → a finding
// carrying BOTH arms' n. Then the REGISTRY's structural invariants — the argued-entry
// discipline is what keeps this feature from producing plausible nonsense at scale, so
// it is enforced rather than trusted (a rationale per entry, a registered prefix, keys
// that are month-anchored and declare their own stem).
//
// All fixture numbers are invented. They take the SHAPE of the issue's motivating table
// (a larger with-arm, a smaller without-arm, a gap in the tens of ms) and none of its
// values.

import { describe, expect, it } from "vitest";
import {
  decidePairedObservation,
  pairedObservationEntry,
  pairedObservationFamily,
  pairedObservationSignalKey,
  pairedObservationsFor,
  PAIRED_MIN_NIGHTS_PER_ARM,
  PAIRED_OBS_PREFIX,
  PAIRED_OBSERVATIONS,
  PAIRED_OUTCOME_RECENCY_DAYS,
  PAIRED_WINDOW_DAYS,
  type PairedNight,
  type PairedObservationEntry,
} from "@/lib/paired-observations";
import { RULE_FINDING_REGISTRY } from "@/lib/rule-finding-prefixes";
import { findingEpisodeFamily } from "@/lib/dismissal-fatigue";
import { shiftDateStr } from "@/lib/date";

const TODAY = "2026-05-20";
const MONTH = "2026-05";

function entryFor(key: string): PairedObservationEntry {
  const entry = pairedObservationEntry(key);
  if (!entry) throw new Error(`no such pair: ${key}`);
  return entry;
}

// `withN` nights carrying the factor at `withValue`, then `withoutN` without it at
// `withoutValue` — all inside the window and ending today, so only the gate under test
// can be the reason a case stays silent.
function nights(spec: {
  withN: number;
  withValue: number;
  withoutN: number;
  withoutValue: number;
  endingOn?: string;
}): PairedNight[] {
  const end = spec.endingOn ?? TODAY;
  const total = spec.withN + spec.withoutN;
  const out: PairedNight[] = [];
  for (let i = 0; i < total; i++) {
    const factor = i < spec.withN;
    out.push({
      date: shiftDateStr(end, -(total - 1 - i)),
      factor,
      value: factor ? spec.withValue : spec.withoutValue,
    });
  }
  return out;
}

describe("decidePairedObservation — the gate matrix", () => {
  const hrv = entryFor("alcohol-hrv");

  it("fires when both arms clear the minimum and the means clear the floor", () => {
    const verdict = decidePairedObservation(
      hrv,
      nights({ withN: 19, withValue: 40, withoutN: 11, withoutValue: 55 }),
      TODAY,
      MONTH
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.withArm).toEqual({ nights: 19, mean: 40 });
    expect(verdict!.withoutArm).toEqual({ nights: 11, mean: 55 });
    // BOTH arms' n is in the sentence (#2177 constraint 3) alongside both means.
    expect(verdict!.detail).toContain("19 nights");
    expect(verdict!.detail).toContain("11 nights");
    expect(verdict!.detail).toContain("40 ms");
    expect(verdict!.detail).toContain("55 ms");
  });

  it("stays silent when the smaller arm is one night below the minimum", () => {
    const short = PAIRED_MIN_NIGHTS_PER_ARM - 1;
    expect(
      decidePairedObservation(
        hrv,
        nights({ withN: 25, withValue: 40, withoutN: short, withoutValue: 55 }),
        TODAY,
        MONTH
      )
    ).toBeNull();
    // …and the mirror case: the FACTOR arm short.
    expect(
      decidePairedObservation(
        hrv,
        nights({ withN: short, withValue: 40, withoutN: 25, withoutValue: 55 }),
        TODAY,
        MONTH
      )
    ).toBeNull();
  });

  it("stays silent above the minimum but below the effect floor", () => {
    const justUnder = hrv.outcome.floor - 1;
    expect(
      decidePairedObservation(
        hrv,
        nights({
          withN: 20,
          withValue: 50,
          withoutN: 12,
          withoutValue: 50 + justUnder,
        }),
        TODAY,
        MONTH
      )
    ).toBeNull();
    // Exactly AT the floor fires — the floor is a minimum, not an exclusive bound.
    expect(
      decidePairedObservation(
        hrv,
        nights({
          withN: 20,
          withValue: 50,
          withoutN: 12,
          withoutValue: 50 + hrv.outcome.floor,
        }),
        TODAY,
        MONTH
      )
    ).not.toBeNull();
  });

  it("fires on a gap in either direction (no direction word, just the two means)", () => {
    const inverted = decidePairedObservation(
      hrv,
      nights({ withN: 20, withValue: 60, withoutN: 12, withoutValue: 45 }),
      TODAY,
      MONTH
    );
    expect(inverted).not.toBeNull();
    expect(inverted!.detail).not.toMatch(/lower|higher|worse|better|improv/i);
  });

  it("stays silent when the outcome series went quiet (#2177 constraint 6)", () => {
    const stale = shiftDateStr(TODAY, -(PAIRED_OUTCOME_RECENCY_DAYS + 1));
    expect(
      decidePairedObservation(
        hrv,
        nights({
          withN: 19,
          withValue: 40,
          withoutN: 11,
          withoutValue: 55,
          endingOn: stale,
        }),
        TODAY,
        MONTH
      )
    ).toBeNull();
  });

  it("counts a date ONCE however many rows reach it", () => {
    const base = nights({
      withN: 19,
      withValue: 40,
      withoutN: 11,
      withoutValue: 55,
    });
    // The same wake-day arriving twice (two sources, a nap folded in) must not buy a
    // second night in either arm — an arm count is a count of nights.
    const doubled = base.flatMap((n) => [n, { ...n, value: n.value + 20 }]);
    const verdict = decidePairedObservation(hrv, doubled, TODAY, MONTH);
    expect(verdict).not.toBeNull();
    expect(verdict!.withArm.nights).toBe(19);
    expect(verdict!.withoutArm.nights).toBe(11);
    expect(verdict!.withArm.mean).toBe(40);
  });

  it("says nothing at all with no nights", () => {
    expect(decidePairedObservation(hrv, [], TODAY, MONTH)).toBeNull();
  });

  it("renders a duration outcome as a duration", () => {
    const sleep = entryFor("training-sleep");
    const verdict = decidePairedObservation(
      sleep,
      nights({ withN: 30, withValue: 400, withoutN: 10, withoutValue: 445 }),
      TODAY,
      MONTH
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.detail).toContain("6h 40m");
    expect(verdict!.detail).toContain("7h 25m");
  });

  it("keeps the copy contract: co-occurrence, no cause, no advice", () => {
    for (const entry of PAIRED_OBSERVATIONS) {
      const verdict = decidePairedObservation(
        entry,
        nights({
          withN: 20,
          withValue: 100,
          withoutN: 12,
          withoutValue: 100 + entry.outcome.floor * 3,
        }),
        TODAY,
        MONTH
      );
      expect(verdict, entry.key).not.toBeNull();
      const text = `${verdict!.title} ${verdict!.detail}`;
      // The disclaimer is part of the contract, not decoration.
      expect(text, entry.key).toMatch(/not a cause, and not a diagnosis/i);
      // No causal verb, no advice verb, no clinical framing, no statistics language.
      // ("diagnosis" is deliberately absent from this list — the disclaimer above is
      // the one legitimate use of the word.)
      expect(text, entry.key).not.toMatch(
        /caused|because of|leads to|consider |try to|you should|risk of|significan|p-value|confidence interval/i
      );
    }
  });
});

describe("paired observations — episode keys and the adult gate", () => {
  it("keys are month-anchored under the registered prefix", () => {
    const key = pairedObservationSignalKey("alcohol-hrv", MONTH);
    expect(key).toBe(`${PAIRED_OBS_PREFIX}alcohol-hrv:${MONTH}`);
    // A different month is a different raising, so a dismissal does not silence it
    // forever (#436).
    expect(key).not.toBe(pairedObservationSignalKey("alcohol-hrv", "2026-06"));
  });

  it("the declared stem is a real family for dismissal fatigue (#2543)", () => {
    const verdict = decidePairedObservation(
      entryFor("alcohol-hrv"),
      nights({ withN: 19, withValue: 40, withoutN: 11, withoutValue: 55 }),
      TODAY,
      MONTH
    )!;
    expect(verdict.episodeFamily).toBe(pairedObservationFamily("alcohol-hrv"));
    expect(
      findingEpisodeFamily({
        dedupeKey: verdict.dedupeKey,
        episodeFamily: verdict.episodeFamily,
      })
    ).toBe(verdict.episodeFamily);
  });

  it("withholds adult-only pairs from a known minor, and only those", () => {
    const adult = pairedObservationsFor({ isKnownMinor: false });
    const minor = pairedObservationsFor({ isKnownMinor: true });
    expect(adult).toEqual(PAIRED_OBSERVATIONS);
    expect(minor.every((e) => !e.factor.adultOnly)).toBe(true);
    expect(minor.length).toBeLessThan(adult.length);
    // Unknown age is not a minor (#494 positive-match-only), which the caller
    // expresses by passing false — the substance surfaces' own answer.
    expect(minor.map((e) => e.key)).not.toContain("alcohol-hrv");
  });
});

describe("PAIRED_OBSERVATIONS — the registry is the multiplicity control", () => {
  it("stays SHORT — the count is a cost, not a score (#2385 deceptive success)", () => {
    // #2177: "start ≤6 pairs". Adding a seventh is a product decision that has to
    // come here and be argued, not a line slipped into a list.
    expect(PAIRED_OBSERVATIONS.length).toBeGreaterThan(0);
    expect(PAIRED_OBSERVATIONS.length).toBeLessThanOrEqual(6);
  });

  it("every entry is fully declared and argued", () => {
    for (const e of PAIRED_OBSERVATIONS) {
      expect(e.key, "key").toMatch(/^[a-z0-9-]+$/);
      expect(e.title.length, `${e.key}: title`).toBeGreaterThan(0);
      // The rationale is the whole point of the registry: a human has to be able to
      // read WHY this comparison earns a slot.
      expect(e.rationale.length, `${e.key}: rationale`).toBeGreaterThan(60);
      expect(
        e.factor.withPhrase.length,
        `${e.key}: withPhrase`
      ).toBeGreaterThan(0);
      expect(
        e.factor.withoutPhrase.length,
        `${e.key}: withoutPhrase`
      ).toBeGreaterThan(0);
      // A floor in the outcome's own unit, and a real unit to state it in.
      expect(e.outcome.floor, `${e.key}: floor`).toBeGreaterThan(0);
      expect(e.outcome.unit.length, `${e.key}: unit`).toBeGreaterThan(0);
      expect(
        e.outcome.offsetDays,
        `${e.key}: offsetDays`
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("keys are unique", () => {
    const keys = PAIRED_OBSERVATIONS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the prefix is registered as COACHING tier (#449 reach policy)", () => {
    const entry = RULE_FINDING_REGISTRY.find(
      (e) => e.prefix === PAIRED_OBS_PREFIX
    );
    expect(entry).toBeDefined();
    expect(entry!.tier).toBe("coaching");
    expect(entry!.builder).toBe("buildPairedObservationFindings");
  });

  it("the shared gates are legible constants, not statistics", () => {
    expect(PAIRED_MIN_NIGHTS_PER_ARM).toBeGreaterThanOrEqual(8);
    expect(PAIRED_WINDOW_DAYS).toBe(90);
    expect(PAIRED_OUTCOME_RECENCY_DAYS).toBeGreaterThan(0);
  });
});

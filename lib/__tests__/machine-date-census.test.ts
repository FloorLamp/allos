import { describe, expect, it } from "vitest";
import {
  CENSUS_EXEMPT_SUBTREES,
  CENSUS_KNOWN_OFFENDERS,
  knownMachineDateOffender,
  machineDateHits,
  MACHINE_DATE_RE,
} from "@/lib/machine-date-census";
import {
  DEFAULT_FORMAT_PREFS,
  formatDateWithYear,
  formatLongDate,
  formatMonthDay,
  formatTimestamp,
  formatWeekdayDate,
} from "@/lib/format-date";

// The census rule's own proof (#3492). A green sweep over a COMPLYING tree says
// nothing about what the sweep can SEE, so the matcher is run here over strings
// authored to break it — and, just as importantly, over the benign neighbours it
// must stay quiet on. A guard that fires on shipped correct copy gets deleted, and
// takes the real guard with it.

describe("the machine-date matcher can SEE every shape a storage date reaches copy in", () => {
  it("catches the bare ISO day, wherever it sits in a sentence", () => {
    const caught = [
      "2026-05-24",
      "Document date 2026-05-24",
      "from 2026-05-24 to 2026-08-21", // two hits in one sentence
      "112/72 mmHg 2026-07-22",
      "as of 2026-07-29",
      "Deleted 2026-08-16",
      "(2026-05-24)",
      "2026-05-24 · 2mo",
      "…ending 2026-05-24.",
      "1999-12-31", // a 19xx year is still a machine date
    ];
    for (const text of caught) {
      expect(
        machineDateHits(text).length,
        `the census must SEE ${JSON.stringify(text)} — a guard blind to the ` +
          `spelling everyone reaches for turns "nobody has done this" into ` +
          `"nobody can do this", and only the first is true`
      ).toBeGreaterThan(0);
    }
    expect(machineDateHits("from 2026-05-24 to 2026-08-21")).toEqual([
      "2026-05-24",
      "2026-08-21",
    ]);
  });

  it("catches the DATE HALF of a raw instant, which the obvious pattern cannot", () => {
    // `\b\d{4}-\d{2}-\d{2}\b` — the shape the issue names, and the shape anybody
    // would reach for — cannot match this at all: there is no word boundary between
    // `4` and `T`, because both are word characters. A raw ISO instant printed into
    // copy is the same defect with a longer suffix, so the matcher's right edge
    // rejects only a CONTINUING digit/dash run rather than demanding a boundary.
    const obvious = /\b\d{4}-\d{2}-\d{2}\b/;
    expect(obvious.test("Recorded 2026-05-24T09:00:00Z")).toBe(false);
    expect(machineDateHits("Recorded 2026-05-24T09:00:00Z")).toEqual([
      "2026-05-24",
    ]);
    expect(machineDateHits("Saved 2026-05-24 09:00:00")).toEqual([
      "2026-05-24",
    ]);
  });

  it("stays QUIET on the display vocabulary — every formatter the app renders through", () => {
    // The other half, and the half that decides whether this guard survives: these
    // are what the correct surfaces actually emit under the default prefs.
    const day = "2026-05-24";
    const quiet = [
      formatLongDate(day, DEFAULT_FORMAT_PREFS),
      formatLongDate(day, DEFAULT_FORMAT_PREFS, { year: "always" }),
      formatMonthDay(day, DEFAULT_FORMAT_PREFS),
      formatDateWithYear(day, DEFAULT_FORMAT_PREFS),
      formatWeekdayDate(day, DEFAULT_FORMAT_PREFS),
      formatTimestamp(`${day}T09:14:00Z`, DEFAULT_FORMAT_PREFS),
    ];
    for (const text of quiet) {
      expect(
        machineDateHits(text),
        `the census must stay QUIET on ${JSON.stringify(text)} — it is the ` +
          `display vocabulary doing its job`
      ).toEqual([]);
    }
    // …and the sample is a real one: nothing above silently rendered as ISO.
    expect(quiet).toContain("Sunday, May 24");
    expect(quiet).toContain("May 24, 2026");
  });

  it("stays QUIET on the digit runs that are not dates", () => {
    const quiet = [
      "Lot 1234-56-78", // a 4-2-2 run with no plausible month
      "Reference 2024-2026", // a year RANGE
      "LOINC 2093-3",
      "ICD-10 E11-9",
      "2026-13-01", // month 13
      "2026-00-11", // month 00
      "2026-05-32", // day 32
      "2026-05-00", // day 00
      "1826-05-24", // not a 19xx/20xx year
      "12026-05-24", // a longer digit run to the left
      "2026-05-243", // …and to the right
      "Set 3 · 12-05 reps",
    ];
    for (const text of quiet) {
      expect(
        machineDateHits(text),
        `the census must stay QUIET on ${JSON.stringify(text)} — a guard that ` +
          `cries wolf on it will be deleted`
      ).toEqual([]);
    }
  });

  it("is stateless across calls, so a hit never depends on what was scanned before", () => {
    // MACHINE_DATE_RE carries /g, and a /g regex keeps `lastIndex` between `.test()`
    // calls. `machineDateHits` goes through `matchAll`, which is unaffected — but a
    // future caller reaching for `MACHINE_DATE_RE.test()` directly would get
    // alternating answers on identical input, and an ABSENCE assertion that
    // alternates fails toward green. Pin the behaviour callers can rely on.
    const text = "Document date 2026-05-24";
    expect(machineDateHits(text)).toEqual(["2026-05-24"]);
    expect(machineDateHits(text)).toEqual(["2026-05-24"]);
    expect(MACHINE_DATE_RE.lastIndex).toBe(0);
  });
});

describe("the exemption registry", () => {
  it("every exemption names both a reason and the premise that licenses it", () => {
    expect(CENSUS_EXEMPT_SUBTREES.length).toBeGreaterThan(0);
    for (const e of CENSUS_EXEMPT_SUBTREES) {
      expect(e.selector.trim().length).toBeGreaterThan(0);
      // An exemption recorded without a reason is an exemption ASSUMED, which is
      // what #3492 item 3 forbids.
      expect(
        e.why.trim().length,
        `${e.selector} has no reason`
      ).toBeGreaterThan(40);
      expect(
        e.premise.trim().length,
        `${e.selector} has no premise — the probe has nothing to assert alongside it`
      ).toBeGreaterThan(40);
    }
  });
});

describe("the known-offender ledger", () => {
  it("is not an exemption list — every entry names a source module and a reason", () => {
    // The distinction is the whole point: an EXEMPTION says a machine date is
    // correct here; a LEDGER entry says it is wrong and is not being fixed by this
    // change. Conflating the two is how a defect becomes a convention.
    const exemptSelectors = new Set(
      CENSUS_EXEMPT_SUBTREES.map((e) => e.selector)
    );
    for (const k of CENSUS_KNOWN_OFFENDERS) {
      expect(
        exemptSelectors.has(`[data-testid="${k.testId}"]`),
        `${k.testId} is BOTH exempt and a known offender — pick one`
      ).toBe(false);
      expect(k.route.startsWith("/")).toBe(true);
      expect(k.testId.trim().length).toBeGreaterThan(0);
      expect(
        k.source.trim().length,
        `${k.testId} does not name the module that builds the sentence`
      ).toBeGreaterThan(10);
      expect(
        k.why.trim().length,
        `${k.testId} does not say why it is not fixed here`
      ).toBeGreaterThan(60);
    }
  });

  it("licenses a registered date hit but never a lab-unit hit, and nothing at all while empty", () => {
    for (const known of CENSUS_KNOWN_OFFENDERS) {
      expect(
        knownMachineDateOffender(known.route, {
          kind: "date",
          testId: known.testId,
        })
      ).toBe(known);
      expect(
        knownMachineDateOffender(known.route, {
          kind: "lab-unit",
          testId: known.testId,
        })
      ).toBeUndefined();
    }
    // #3526 deleted the last entry when it fixed the surface, so the loop above is
    // vacuous today and this is the assertion that carries the file: an EMPTY ledger
    // licenses nothing — the retired route/testid included. Without it the ledger
    // could refill by accident and no test here would notice.
    expect(
      knownMachineDateOffender("/", {
        kind: "date",
        testId: "attention-item-detail",
      })
    ).toBeUndefined();
  });
});

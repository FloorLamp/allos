import { describe, it, expect } from "vitest";
import {
  censusDoseAmounts,
  classifyDoseAmount,
  preFixDoseReading,
  recoverableCandidates,
} from "../dose-amount-census";
import { readDoseQuantity } from "../dri";

// The #3320 census, pure tier. The census exists to MEASURE a population nobody can
// enumerate by argument, so what these tests pin is that it can SEE each bucket —
// a partition run over a complying corpus proves nothing about what it can find.
// Every case below is an amount authored to land in exactly one bucket.

describe("preFixDoseReading — what a row read as BEFORE the write-path fix", () => {
  // The three rows the issue tabulates. This function is the artifact being measured;
  // if it stops reproducing these, the census's "was repaired" columns are fiction.
  it('read "1,000 mg" as a confident ZERO', () => {
    expect(preFixDoseReading("1,000 mg")).toEqual({ value: 0, unit: "mg" });
  });
  it('read "2,5 g" as 5 g — ten times the dose meant', () => {
    expect(preFixDoseReading("2,5 g")).toEqual({ value: 5, unit: "g" });
  });
  it('read "10.000 IU" as 10 IU — a thousandfold low', () => {
    expect(preFixDoseReading("10.000 IU")).toEqual({ value: 10, unit: "iu" });
  });
  it("read an ordinary amount exactly as the shipped rule does", () => {
    expect(preFixDoseReading("400 mcg")).toEqual({ value: 400, unit: "mcg" });
    expect(readDoseQuantity("400 mcg")).toEqual({
      kind: "quantity",
      value: 400,
      unit: "mcg",
    });
  });
});

describe("classifyDoseAmount — one bucket each", () => {
  it("no number+unit at all is never affected", () => {
    expect(classifyDoseAmount("1 capsule")).toBe("no-quantity");
    expect(classifyDoseAmount("1 scoop")).toBe("no-quantity");
    expect(classifyDoseAmount(null)).toBe("no-quantity");
    expect(classifyDoseAmount("")).toBe("no-quantity");
  });

  it("an amount that always read correctly is untouched", () => {
    expect(classifyDoseAmount("400 mg")).toBe("always-correct");
    expect(classifyDoseAmount("2.5 mg")).toBe("always-correct");
    expect(classifyDoseAmount("2000 IU / 100 mcg")).toBe("always-correct");
  });

  it("withholds the certificate when both readers agree on a fragment", () => {
    expect(readDoseQuantity("400 mg", { structuralSoundness: true })).toEqual({
      kind: "quantity",
      value: 400,
      unit: "mg",
      structurallySound: true,
    });
    expect(readDoseQuantity("1-000 mg", { structuralSoundness: true })).toEqual(
      {
        kind: "quantity",
        value: 0,
        unit: "mg",
        structurallySound: false,
      }
    );
    expect(classifyDoseAmount("1-000 mg")).toBe(
      "agreement-without-certificate"
    );
    expect(classifyDoseAmount("100-200 mg")).toBe(
      "agreement-without-certificate"
    );
  });

  it("the ZERO case is recoverable and the fix already recovered it", () => {
    expect(classifyDoseAmount("1,000 mg")).toBe("recovered-from-zero");
    expect(classifyDoseAmount("5,000 IU")).toBe("recovered-from-zero");
    // The correct value was always in the string; the fix reads it now.
    expect(readDoseQuantity("1,000 mg")).toEqual({
      kind: "quantity",
      value: 1000,
      unit: "mg",
    });
  });

  it("a non-zero misreading is its own bucket", () => {
    // The old scan stopped at "500" of "1,500"; the new one takes the number whole.
    expect(classifyDoseAmount("1,500 mg")).toBe("recovered-from-wrong");
    expect(classifyDoseAmount("1,234.5 mg")).toBe("recovered-from-wrong");
  });

  it("an unreadable amount that restates itself carries a candidate", () => {
    expect(classifyDoseAmount("2,5 g (2500 mg)")).toBe(
      "unreadable-recoverable"
    );
    expect(recoverableCandidates("2,5 g (2500 mg)")).toEqual(["2500 mg"]);
  });

  it("an unreadable amount with nothing to recover is THE bucket", () => {
    // 2.5 g or 25 g; ten or ten thousand IU; 2.5 or 2500 mg. Nothing in the row
    // says which, and nothing here guesses.
    expect(classifyDoseAmount("2,5 g")).toBe("unreadable-unrecoverable");
    expect(classifyDoseAmount("10.000 IU")).toBe("unreadable-unrecoverable");
    expect(classifyDoseAmount("2.500 mg")).toBe("unreadable-unrecoverable");
    expect(recoverableCandidates("2,5 g")).toEqual([]);
  });

  it("never guesses a locale — an ambiguous string yields no number anywhere", () => {
    for (const amount of ["2,5 g", "10.000 IU", "2.500 mg", "1,00 mg"]) {
      expect(readDoseQuantity(amount).kind).toBe("unreadable");
      expect(recoverableCandidates(amount)).toEqual([]);
    }
  });
});

describe("censusDoseAmounts — the partition", () => {
  it("splits live from retired and counts every row exactly once", () => {
    const census = censusDoseAmounts([
      { amount: "400 mg", retired: false },
      { amount: "1-000 mg", retired: false },
      { amount: "1 capsule", retired: false },
      { amount: "1,000 mg", retired: false },
      { amount: "1,000 mg", retired: true },
      { amount: "1,500 mg", retired: false },
      { amount: "2,5 g (2500 mg)", retired: false },
      { amount: "2,5 g", retired: false },
      { amount: "2,5 g", retired: false },
      { amount: "10.000 IU", retired: true },
    ]);
    expect(census.rows).toBe(10);
    expect(census.buckets).toEqual({
      "always-correct": { live: 1, retired: 0 },
      "agreement-without-certificate": { live: 1, retired: 0 },
      "no-quantity": { live: 1, retired: 0 },
      "recovered-from-zero": { live: 1, retired: 1 },
      "recovered-from-wrong": { live: 1, retired: 0 },
      "unreadable-recoverable": { live: 1, retired: 0 },
      "unreadable-unrecoverable": { live: 2, retired: 1 },
    });
    const total = Object.values(census.buckets).reduce(
      (n, b) => n + b.live + b.retired,
      0
    );
    expect(total).toBe(census.rows);
  });

  it("samples amount STRINGS and counts, commonest first — and nothing else", () => {
    const census = censusDoseAmounts([
      { amount: "2,5 g", retired: false },
      { amount: "2,5 g", retired: false },
      { amount: "10.000 IU", retired: false },
    ]);
    expect(census.samples["unreadable-unrecoverable"]).toEqual([
      { amount: "2,5 g", rows: 2 },
      { amount: "10.000 IU", rows: 1 },
    ]);
  });

  it("an empty database is an empty census, not an error", () => {
    const census = censusDoseAmounts([]);
    expect(census.rows).toBe(0);
    expect(census.buckets["unreadable-unrecoverable"]).toEqual({
      live: 0,
      retired: 0,
    });
    expect(census.samples["unreadable-unrecoverable"]).toEqual([]);
  });
});

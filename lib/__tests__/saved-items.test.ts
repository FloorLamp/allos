import { describe, it, expect } from "vitest";
import {
  savedRefFromSeriesKey,
  seriesKeyOfSavedRef,
  isSeriesKeySaved,
  orderSavedRefs,
  moveInOrder,
  type SavedRef,
} from "../saved-items";

// PURE TIER for the unified save store (issue #1456): the kind/key vocabulary that
// maps a Trends series key onto a `saved_items` row, and the ordering math the Trends
// Overview renders the saved row with. No DB — the store's SQL is covered by
// lib/__db_tests__/saved-items*.test.ts.

const ref = (kind: SavedRef["kind"], key: string): SavedRef => ({ kind, key });

describe("savedRefFromSeriesKey", () => {
  it("maps each namespace to its kind, stripping the prefix", () => {
    expect(savedRefFromSeriesKey("result:LDL Cholesterol")).toEqual(
      ref("clinical-result", "LDL Cholesterol")
    );
    expect(savedRefFromSeriesKey("metric:weight")).toEqual(
      ref("trend-metric", "weight")
    );
  });

  it("keeps a clinical result from colliding with a metric tile", () => {
    // The whole reason the prefixes exist: an analyte literally named "weight".
    expect(savedRefFromSeriesKey("result:weight")).toEqual(
      ref("clinical-result", "weight")
    );
    expect(savedRefFromSeriesKey("metric:weight")).toEqual(
      ref("trend-metric", "weight")
    );
  });

  it("rejects an unknown namespace or an empty key rather than writing junk", () => {
    expect(savedRefFromSeriesKey("provider:12")).toBeNull();
    expect(savedRefFromSeriesKey("LDL Cholesterol")).toBeNull();
    expect(savedRefFromSeriesKey("result:")).toBeNull();
    expect(savedRefFromSeriesKey("result:   ")).toBeNull();
    expect(savedRefFromSeriesKey("")).toBeNull();
  });

  it("trims the submitted key (a form value carries whitespace)", () => {
    expect(savedRefFromSeriesKey("  result: ApoB  ")).toEqual(
      ref("clinical-result", "ApoB")
    );
  });

  it("round-trips through seriesKeyOfSavedRef", () => {
    for (const key of [
      "result:ApoB",
      "metric:bodyfat",
      "result:Vitamin D, Total",
    ]) {
      expect(seriesKeyOfSavedRef(savedRefFromSeriesKey(key)!)).toBe(key);
    }
  });
});

describe("isSeriesKeySaved", () => {
  const saved = [
    ref("clinical-result", "LDL Cholesterol"),
    ref("trend-metric", "weight"),
  ];

  it("matches within a kind and not across kinds", () => {
    expect(isSeriesKeySaved(saved, "result:LDL Cholesterol")).toBe(true);
    expect(isSeriesKeySaved(saved, "metric:weight")).toBe(true);
    // Same spelling, other namespace — a different item entirely.
    expect(isSeriesKeySaved(saved, "result:weight")).toBe(false);
    expect(isSeriesKeySaved(saved, "metric:LDL Cholesterol")).toBe(false);
  });

  it("is case-insensitive, matching the store's NOCASE key column", () => {
    expect(isSeriesKeySaved(saved, "result:ldl cholesterol")).toBe(true);
    expect(
      isSeriesKeySaved([ref("clinical-result", "apob")], "result:ApoB")
    ).toBe(true);
  });

  it("is false for an unparseable key", () => {
    expect(isSeriesKeySaved(saved, "weight")).toBe(false);
  });
});

describe("orderSavedRefs", () => {
  const row = (
    key: string,
    position: number | null,
    created_at: string
  ): SavedRef & { position: number | null; created_at: string } => ({
    kind: "clinical-result",
    key,
    position,
    created_at,
  });

  it("puts explicitly positioned rows first, in position order", () => {
    const out = orderSavedRefs([
      row("c", 2, "2026-01-01"),
      row("a", 0, "2026-01-01"),
      row("b", 1, "2026-01-01"),
    ]);
    expect(out.map((r) => r.key)).toEqual(["a", "b", "c"]);
  });

  it("orders unpositioned rows newest-first (the old star store's ordering)", () => {
    const out = orderSavedRefs([
      row("older", null, "2026-01-01"),
      row("newest", null, "2026-03-01"),
      row("middle", null, "2026-02-01"),
    ]);
    expect(out.map((r) => r.key)).toEqual(["newest", "middle", "older"]);
  });

  it("mixes the two groups: positioned rows precede every unpositioned one", () => {
    // The half-migrated shape: a folded pin carries a position, a later plain star
    // does not. The starred-but-unordered item must not jump the user's ordering.
    const out = orderSavedRefs([
      row("fresh-star", null, "2026-06-01"),
      row("pinned-second", 1, "2026-01-01"),
      row("pinned-first", 0, "2026-01-01"),
    ]);
    expect(out.map((r) => r.key)).toEqual([
      "pinned-first",
      "pinned-second",
      "fresh-star",
    ]);
  });

  it("is stable for ties and does not mutate its input", () => {
    const input = [row("x", 0, "2026-01-01"), row("y", 0, "2026-01-01")];
    const snapshot = [...input];
    expect(orderSavedRefs(input).map((r) => r.key)).toEqual(["x", "y"]);
    expect(input).toEqual(snapshot);
  });
});

describe("moveInOrder", () => {
  const list = ["a", "b", "c"];

  it("swaps with the neighbour in the requested direction", () => {
    expect(moveInOrder(list, 1, "up")).toEqual(["b", "a", "c"]);
    expect(moveInOrder(list, 1, "down")).toEqual(["a", "c", "b"]);
  });

  it("no-ops at the ends instead of wrapping around", () => {
    expect(moveInOrder(list, 0, "up")).toEqual(list);
    expect(moveInOrder(list, 2, "down")).toEqual(list);
  });

  it("no-ops for an out-of-range or non-integer index (a forged POST)", () => {
    expect(moveInOrder(list, -1, "up")).toEqual(list);
    expect(moveInOrder(list, 9, "down")).toEqual(list);
    expect(moveInOrder(list, 1.5, "up")).toEqual(list);
  });

  it("returns a new array, leaving the input untouched", () => {
    const input = ["a", "b"];
    expect(moveInOrder(input, 0, "down")).toEqual(["b", "a"]);
    expect(input).toEqual(["a", "b"]);
  });
});

import { describe, it, expect } from "vitest";
import {
  SAVED_KINDS,
  isSavedKind,
  savedRefFromSeriesKey,
  seriesKeyOfSavedRef,
  isSeriesKeySaved,
  orderSavedRefs,
  moveInOrder,
  partitionSaved,
  type SavedRef,
} from "../saved-items";

// PURE TIER for the unified save store (issue #1456): the kind/key vocabulary that
// maps a Trends series key onto a `saved_items` row, and the ordering math the Trends
// Overview renders the saved row with. No DB — the store's SQL is covered by
// lib/__db_tests__/saved-items*.test.ts.

const ref = (kind: SavedRef["kind"], key: string): SavedRef => ({ kind, key });

describe("kinds", () => {
  it("knows exactly the two launch kinds", () => {
    expect([...SAVED_KINDS]).toEqual(["biomarker", "trend-metric"]);
    expect(isSavedKind("biomarker")).toBe(true);
    expect(isSavedKind("trend-metric")).toBe(true);
    // A future kind is a migration (the CHECK constraint), not a free-text write.
    expect(isSavedKind("provider")).toBe(false);
    expect(isSavedKind("")).toBe(false);
  });
});

describe("savedRefFromSeriesKey", () => {
  it("maps each namespace to its kind, stripping the prefix", () => {
    expect(savedRefFromSeriesKey("bio:LDL Cholesterol")).toEqual(
      ref("biomarker", "LDL Cholesterol")
    );
    expect(savedRefFromSeriesKey("metric:weight")).toEqual(
      ref("trend-metric", "weight")
    );
  });

  it("keeps the two namespaces apart so a biomarker can't collide with a metric tile", () => {
    // The whole reason the prefixes exist: an analyte literally named "weight".
    expect(savedRefFromSeriesKey("bio:weight")).toEqual(
      ref("biomarker", "weight")
    );
    expect(savedRefFromSeriesKey("metric:weight")).toEqual(
      ref("trend-metric", "weight")
    );
  });

  it("rejects an unknown namespace or an empty key rather than writing junk", () => {
    expect(savedRefFromSeriesKey("provider:12")).toBeNull();
    expect(savedRefFromSeriesKey("LDL Cholesterol")).toBeNull();
    expect(savedRefFromSeriesKey("bio:")).toBeNull();
    expect(savedRefFromSeriesKey("bio:   ")).toBeNull();
    expect(savedRefFromSeriesKey("")).toBeNull();
  });

  it("trims the submitted key (a form value carries whitespace)", () => {
    expect(savedRefFromSeriesKey("  bio: ApoB  ")).toEqual(
      ref("biomarker", "ApoB")
    );
  });

  it("round-trips through seriesKeyOfSavedRef", () => {
    for (const key of ["bio:ApoB", "metric:bodyfat", "bio:Vitamin D, Total"]) {
      expect(seriesKeyOfSavedRef(savedRefFromSeriesKey(key)!)).toBe(key);
    }
  });
});

describe("isSeriesKeySaved", () => {
  const saved = [
    ref("biomarker", "LDL Cholesterol"),
    ref("trend-metric", "weight"),
  ];

  it("matches within a kind and not across kinds", () => {
    expect(isSeriesKeySaved(saved, "bio:LDL Cholesterol")).toBe(true);
    expect(isSeriesKeySaved(saved, "metric:weight")).toBe(true);
    // Same spelling, other namespace — a different item entirely.
    expect(isSeriesKeySaved(saved, "bio:weight")).toBe(false);
    expect(isSeriesKeySaved(saved, "metric:LDL Cholesterol")).toBe(false);
  });

  it("is case-insensitive, matching the store's NOCASE key column", () => {
    expect(isSeriesKeySaved(saved, "bio:ldl cholesterol")).toBe(true);
    expect(isSeriesKeySaved([ref("biomarker", "apob")], "bio:ApoB")).toBe(true);
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
    kind: "biomarker",
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

describe("partitionSaved", () => {
  const tile = (key: string) => ({ key });
  const tiles = [
    tile("metric:weight"),
    tile("metric:bodyfat"),
    tile("bio:ApoB"),
  ];

  it("renders saved tiles in SAVED order and leaves the rest in place", () => {
    const { saved, unsaved } = partitionSaved(tiles, (t) => t.key, [
      ref("biomarker", "ApoB"),
      ref("trend-metric", "weight"),
    ]);
    expect(saved.map((t) => t.key)).toEqual(["bio:ApoB", "metric:weight"]);
    expect(unsaved.map((t) => t.key)).toEqual(["metric:bodyfat"]);
  });

  it("skips a saved ref with no matching tile", () => {
    // A saved metric the age gate removed from the grid: no tile, no crash, and it
    // must not shift the ordering of the tiles that do render.
    const { saved, unsaved } = partitionSaved(tiles, (t) => t.key, [
      ref("trend-metric", "training-volume"),
      ref("trend-metric", "bodyfat"),
    ]);
    expect(saved.map((t) => t.key)).toEqual(["metric:bodyfat"]);
    expect(unsaved.map((t) => t.key)).toEqual(["metric:weight", "bio:ApoB"]);
  });

  it("matches case-insensitively (a save on 'apob' claims the 'bio:ApoB' tile)", () => {
    const { saved } = partitionSaved(tiles, (t) => t.key, [
      ref("biomarker", "apob"),
    ]);
    expect(saved.map((t) => t.key)).toEqual(["bio:ApoB"]);
  });

  it("with nothing saved, everything stays unsaved in its original order", () => {
    const { saved, unsaved } = partitionSaved(tiles, (t) => t.key, []);
    expect(saved).toEqual([]);
    expect(unsaved.map((t) => t.key)).toEqual(tiles.map((t) => t.key));
  });
});

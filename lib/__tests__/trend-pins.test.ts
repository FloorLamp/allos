import { describe, it, expect } from "vitest";
import {
  metricPinKey,
  bioPinKey,
  bioPinName,
  normalizePins,
  parsePins,
  serializePins,
  isPinned,
  togglePin,
  partitionPinned,
} from "../trend-pins";

describe("pin key helpers", () => {
  it("builds and reads metric/biomarker keys", () => {
    expect(metricPinKey("weight")).toBe("metric:weight");
    expect(bioPinKey("LDL Cholesterol")).toBe("bio:LDL Cholesterol");
    expect(bioPinName("bio:LDL Cholesterol")).toBe("LDL Cholesterol");
    expect(bioPinName("metric:weight")).toBeNull();
    expect(bioPinName("bio:")).toBe("");
  });
});

describe("normalizePins", () => {
  it("trims, drops empties, and preserves first-seen order", () => {
    expect(normalizePins([" metric:weight ", "", "bio:LDL", "   "])).toEqual([
      "metric:weight",
      "bio:LDL",
    ]);
  });

  it("de-dupes exact keys keeping the first", () => {
    expect(normalizePins(["metric:weight", "metric:weight"])).toEqual([
      "metric:weight",
    ]);
  });

  it("de-dupes biomarker names case-insensitively, keeping first spelling", () => {
    expect(normalizePins(["bio:LDL", "bio:ldl", "bio:Ldl"])).toEqual([
      "bio:LDL",
    ]);
  });
});

describe("parsePins / serializePins", () => {
  it("parses a valid JSON array", () => {
    expect(parsePins('["metric:weight","bio:LDL"]')).toEqual([
      "metric:weight",
      "bio:LDL",
    ]);
  });

  it("returns [] for null, empty, non-array, or malformed JSON", () => {
    expect(parsePins(null)).toEqual([]);
    expect(parsePins(undefined)).toEqual([]);
    expect(parsePins("")).toEqual([]);
    expect(parsePins("{}")).toEqual([]);
    expect(parsePins("not json")).toEqual([]);
    expect(parsePins("[1,2,3]")).toEqual([]); // non-strings filtered out
  });

  it("round-trips through serialize (normalized)", () => {
    const raw = [" metric:weight ", "bio:LDL", "bio:ldl"];
    expect(parsePins(serializePins(raw))).toEqual(["metric:weight", "bio:LDL"]);
  });
});

describe("isPinned", () => {
  const pins = ["metric:weight", "bio:LDL Cholesterol"];
  it("matches metric keys exactly", () => {
    expect(isPinned(pins, "metric:weight")).toBe(true);
    expect(isPinned(pins, "metric:bodyfat")).toBe(false);
  });
  it("matches biomarker names case-insensitively", () => {
    expect(isPinned(pins, "bio:ldl cholesterol")).toBe(true);
    expect(isPinned(pins, "bio:HDL")).toBe(false);
  });
});

describe("togglePin", () => {
  it("appends a new pin to the end", () => {
    expect(togglePin(["metric:weight"], "bio:LDL")).toEqual([
      "metric:weight",
      "bio:LDL",
    ]);
  });

  it("removes an already-pinned key", () => {
    expect(togglePin(["metric:weight", "bio:LDL"], "metric:weight")).toEqual([
      "bio:LDL",
    ]);
  });

  it("removes a biomarker case-insensitively", () => {
    expect(togglePin(["bio:LDL"], "bio:ldl")).toEqual([]);
  });

  it("does not mutate the input and ignores blank keys", () => {
    const input = ["metric:weight"];
    const out = togglePin(input, "  ");
    expect(out).toEqual(["metric:weight"]);
    expect(input).toEqual(["metric:weight"]);
  });
});

describe("partitionPinned", () => {
  type Tile = { key: string };
  const tiles: Tile[] = [
    { key: "metric:weight" },
    { key: "metric:bodyfat" },
    { key: "metric:resting_hr" },
    { key: "bio:LDL" },
  ];
  const keyOf = (t: Tile) => t.key;

  it("returns pinned in pin order and unpinned in original order", () => {
    const { pinned, unpinned } = partitionPinned(tiles, keyOf, [
      "metric:resting_hr",
      "metric:weight",
    ]);
    expect(pinned.map(keyOf)).toEqual(["metric:resting_hr", "metric:weight"]);
    expect(unpinned.map(keyOf)).toEqual(["metric:bodyfat", "bio:LDL"]);
  });

  it("skips a pin with no matching tile", () => {
    const { pinned } = partitionPinned(tiles, keyOf, [
      "bio:Missing",
      "metric:weight",
    ]);
    expect(pinned.map(keyOf)).toEqual(["metric:weight"]);
  });

  it("matches biomarker tiles case-insensitively", () => {
    const { pinned, unpinned } = partitionPinned(tiles, keyOf, ["bio:ldl"]);
    expect(pinned.map(keyOf)).toEqual(["bio:LDL"]);
    expect(unpinned).toHaveLength(3);
  });

  it("with no pins, everything is unpinned in order", () => {
    const { pinned, unpinned } = partitionPinned(tiles, keyOf, []);
    expect(pinned).toEqual([]);
    expect(unpinned).toEqual(tiles);
  });
});

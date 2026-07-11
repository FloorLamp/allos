// PURE tier — the shared parseComponents helper (issue #334) that centralizes the
// try/catch + array-guard formerly open-coded at every activity `components` read
// site (journal feed, editor seed, validator, icon resolver, goal/effort queries).

import { describe, it, expect } from "vitest";
import { parseComponents } from "@/lib/types";

describe("parseComponents", () => {
  it("returns [] for absent input (null / undefined / empty string)", () => {
    expect(parseComponents(null)).toEqual([]);
    expect(parseComponents(undefined)).toEqual([]);
    expect(parseComponents("")).toEqual([]);
  });

  it("parses a valid components array verbatim", () => {
    const comps = [
      {
        name: "Squat",
        type: "strength",
        distance_km: null,
        duration_min: null,
      },
      { name: "Run", type: "cardio", distance_km: 5, duration_min: 30 },
    ];
    expect(parseComponents(JSON.stringify(comps))).toEqual(comps);
  });

  it("parses a valid empty array to []", () => {
    expect(parseComponents("[]")).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseComponents("{not json")).toEqual([]);
    expect(parseComponents("undefined")).toEqual([]);
  });

  it("returns [] when the JSON parses to a non-array (object, number, null)", () => {
    expect(parseComponents('{"type":"strength"}')).toEqual([]);
    expect(parseComponents("42")).toEqual([]);
    expect(parseComponents("null")).toEqual([]);
  });
});

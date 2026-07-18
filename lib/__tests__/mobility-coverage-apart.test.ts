import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mobilityRegionDays,
  mobilityCoverageStrip,
  regionsForMove,
  type MobilitySessionInput,
} from "@/lib/mobility-coverage";

// Mobility coverage is DELIBERATELY APART from strength trained-coverage (#482: trained ≠
// mobilized). This test pins BOTH the separation (a source-scan reflection guard that the
// module never reads strength sets nor imports the strength coverage engine) AND the pure
// rollup behavior over mobility move slugs.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RAW = fs.readFileSync(
  path.join(REPO, "lib/mobility-coverage.ts"),
  "utf8"
);
// Strip comments so the scan checks actual CODE, not the header prose that explains the
// separation (which necessarily names the very tokens we forbid in code).
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("mobility coverage stays apart from strength coverage (#482)", () => {
  it("never reads strength sets or imports the strength coverage engine", () => {
    // The whole point: mobility coverage must NOT be sourced from strength set rows or the
    // lift-catalog coverage engine, or it would answer "trained?" instead of "mobilized?".
    expect(CODE).not.toMatch(/exercise_sets/);
    expect(CODE).not.toMatch(/muscle-coverage/);
    expect(CODE).not.toMatch(/coverageFromSets/);
    expect(CODE).not.toMatch(/liftInfo/);
  });
});

describe("mobility coverage rollup", () => {
  const today = "2026-07-18";
  // pigeon_pose → glutes/hip-abductors (Glutes); hamstring_stretch → hamstrings (Legs);
  // shoulder_cars → delts (Shoulders).
  const sessions: MobilitySessionInput[] = [
    { date: "2026-07-18", moves: ["pigeon_pose", "hamstring_stretch"] },
    { date: "2026-07-16", moves: ["shoulder_cars"] },
    { date: "2026-07-14", moves: ["pigeon_pose"] },
    { date: "2026-06-01", moves: ["hamstring_stretch"] }, // outside the 7-day window
  ];

  it("resolves a move's regions through the MuscleId tags", () => {
    expect(regionsForMove("hamstring_stretch")).toEqual(["Legs"]);
    expect(new Set(regionsForMove("pigeon_pose"))).toEqual(new Set(["Glutes"]));
    expect(regionsForMove("__unknown__")).toEqual([]);
  });

  it("counts distinct mobilized days per region within the window (once per day, #223)", () => {
    const days = mobilityRegionDays(sessions, today, 7);
    // Glutes: 07-18 and 07-14 → 2 distinct days (06-01 excluded by window).
    expect(days.get("Glutes")?.size).toBe(2);
    // Legs (hamstrings): only 07-18 in window.
    expect(days.get("Legs")?.size).toBe(1);
    expect(days.get("Shoulders")?.size).toBe(1);
    expect(days.get("Chest")).toBeUndefined();
  });

  it("builds a full 7-region strip with zero-coverage regions surfaced", () => {
    const strip = mobilityCoverageStrip(sessions, today, 7);
    expect(strip.length).toBe(7); // every region present, even 0-coverage ones
    const glutes = strip.find((r) => r.region === "Glutes");
    expect(glutes?.days).toBe(2);
    expect(glutes?.lastMobilized).toBe("2026-07-18");
    const chest = strip.find((r) => r.region === "Chest");
    expect(chest?.days).toBe(0);
    expect(chest?.lastMobilized).toBeNull();
    // Sorted most-mobilized first.
    expect(strip[0].region).toBe("Glutes");
  });
});

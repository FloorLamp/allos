import { describe, it, expect } from "vitest";
import type { Finding } from "../findings";
import { biomarkerFlagDismissalKey } from "../dismissal-keys";
import {
  rollupTrajectoryFindings,
  TRAJECTORY_ROLLUP_CAP,
} from "../trajectory-rollup";
import { parseTrajectoryKey } from "../biomarker-trajectory";

// The Results-hub trajectory rollup (#1499 section B). The promise under test is
// #1496's: the FOLD changes rendering only — every dedupeKey, every `supersedes`
// acknowledgment and every Finding object survives it untouched.

type Rule = "approaching" | "persistent" | "velocity";

function finding(analyte: string, rule: Rule): Finding {
  return {
    domain: "trajectory",
    dedupeKey: `trajectory:${analyte}:${rule}`,
    supersedes: biomarkerFlagDismissalKey(analyte),
    title: `${analyte} ${rule}`,
    tone: "caution",
  };
}

describe("parseTrajectoryKey", () => {
  it("recovers the analyte and rule from a trajectory dedupeKey", () => {
    expect(parseTrajectoryKey("trajectory:eGFR:velocity")).toEqual({
      analyte: "eGFR",
      rule: "velocity",
    });
  });

  it("reads the rule off the LAST segment, so a colon in the name survives", () => {
    expect(
      parseTrajectoryKey("trajectory:Vitamin D, 25-OH:persistent")
    ).toEqual({ analyte: "Vitamin D, 25-OH", rule: "persistent" });
  });

  it("returns null for a foreign or malformed key", () => {
    expect(parseTrajectoryKey("muscle-volume:below:calves:2026-07")).toBeNull();
    expect(parseTrajectoryKey("trajectory:eGFR:not-a-rule")).toBeNull();
    expect(parseTrajectoryKey("trajectory:eGFR")).toBeNull();
    expect(parseTrajectoryKey("trajectory::velocity")).toBeNull();
  });
});

describe("rollupTrajectoryFindings", () => {
  it("folds an analyte's rules into ONE group, keyed on its acknowledgment key", () => {
    const items = [
      finding("eGFR", "approaching"),
      finding("eGFR", "velocity"),
      finding("eGFR", "persistent"),
    ];
    const rollup = rollupTrajectoryFindings(items);
    expect(rollup.groups).toHaveLength(1);
    expect(rollup.analyteCount).toBe(1);
    expect(rollup.total).toBe(3);
    // The group's key IS the key its members already carry — not a new namespace.
    expect(rollup.groups[0].key).toBe(biomarkerFlagDismissalKey("eGFR"));
    expect(rollup.groups[0].label).toBe("eGFR");
  });

  it("carries every Finding through untouched — same objects, same dedupeKeys", () => {
    const items = [
      finding("eGFR", "velocity"),
      finding("hs-CRP", "persistent"),
    ];
    const rollup = rollupTrajectoryFindings(items);
    const folded = rollup.groups.flatMap((g) => g.items);
    expect(folded).toHaveLength(2);
    // Identity, not a copy: a dismiss form built from a folded item posts exactly
    // what the flat card posted.
    expect(folded).toEqual(expect.arrayContaining(items));
    expect(folded.map((f) => f.dedupeKey).sort()).toEqual(
      items.map((f) => f.dedupeKey).sort()
    );
  });

  it("keeps the engine's analyte order", () => {
    const rollup = rollupTrajectoryFindings([
      finding("eGFR", "velocity"),
      finding("ALT", "persistent"),
      finding("eGFR", "approaching"),
    ]);
    expect(rollup.groups.map((g) => g.label)).toEqual(["eGFR", "ALT"]);
  });

  it("groups two spellings of ONE #482 family together and names both", () => {
    // Total / 25-OH vitamin D collapse onto one family, so they share the
    // acknowledgment key — one dismiss covers them, so they are one row.
    const items = [
      finding("Vitamin D, 25-Hydroxy", "persistent"),
      finding("25-OH Vitamin D", "approaching"),
    ];
    expect(items[0].supersedes).toBe(items[1].supersedes);
    const rollup = rollupTrajectoryFindings(items);
    expect(rollup.groups).toHaveLength(1);
    expect(rollup.groups[0].label).toBe(
      "Vitamin D, 25-Hydroxy / 25-OH Vitamin D"
    );
  });

  it("caps the rows and puts the rest in overflow", () => {
    const analytes = ["eGFR", "ALT", "hs-CRP", "Ferritin", "TSH"];
    const rollup = rollupTrajectoryFindings(
      analytes.map((a) => finding(a, "velocity"))
    );
    expect(rollup.shown).toHaveLength(TRAJECTORY_ROLLUP_CAP);
    expect(rollup.overflow).toHaveLength(
      analytes.length - TRAJECTORY_ROLLUP_CAP
    );
    // Nothing is lost to the cap — shown + overflow is the whole list.
    expect([...rollup.shown, ...rollup.overflow]).toEqual(rollup.groups);
  });

  it("summarizes the roster for the card subtitle", () => {
    const rollup = rollupTrajectoryFindings(
      ["eGFR", "ALT", "hs-CRP", "Ferritin", "TSH"].map((a) =>
        finding(a, "velocity")
      )
    );
    expect(rollup.names).toBe("eGFR, ALT, hs-CRP and 2 more");
  });

  it("gives a finding with no acknowledgment key its own group", () => {
    const orphan: Finding = {
      domain: "trajectory",
      dedupeKey: "trajectory:Odd Analyte:velocity",
      title: "odd",
    };
    const rollup = rollupTrajectoryFindings([
      orphan,
      finding("eGFR", "velocity"),
    ]);
    expect(rollup.groups).toHaveLength(2);
    expect(rollup.groups[0].key).toBe("trajectory:Odd Analyte:velocity");
  });

  it("is empty for no findings, so the card renders nothing", () => {
    const rollup = rollupTrajectoryFindings([]);
    expect(rollup.groups).toEqual([]);
    expect(rollup.analyteCount).toBe(0);
    expect(rollup.total).toBe(0);
    expect(rollup.names).toBe("");
  });
});

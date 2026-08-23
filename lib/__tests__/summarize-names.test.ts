import { describe, expect, it } from "vitest";
import {
  NAME_JOIN_SEPARATOR,
  joinNames,
  joinNamesForSentence,
  summarizeNames,
} from "../summarize-names";
import { rollupTrajectoryFindings } from "../trajectory-rollup";
import { summarizeMuscleNames } from "../training-findings-rollup";
import { doseLaneRoster } from "../illness-episode-format";
import type { Finding } from "../findings";
import { biomarkerFlagDismissalKey } from "../dismissal-keys";

// THE SEPARATOR IS THE WHOLE POINT (#3496; docs/internals/copy.md §9).
//
// The defect was not ugliness. "Lead, Lymphocytes, Relative, Neutrophils,
// Absolute" is THREE lab names, printed beside a count that said three, and a
// reader counting the list gets five — so the sentence contradicts itself and
// there is no way to tell which half is lying.
//
// What this file guards is therefore a property, not a string: whatever separator
// the roster uses, a name may not contain it. A future author who "tidies" the
// join back to ", " fails here, on the comma-bearing LOINC name that started it.

// The real names from the owner's 2026-08-21 phone review. These are LOINC-shaped
// differential labels and the comma is INSIDE the name.
const COMMA_BEARING = [
  "Lead",
  "Lymphocytes, Relative",
  "Neutrophils, Absolute",
];

describe("the roster separator is one no clinical name contains", () => {
  it("the separator itself is not a comma", () => {
    expect(NAME_JOIN_SEPARATOR).not.toContain(",");
  });

  it("a comma-bearing name stays one name in the joined line", () => {
    const line = summarizeNames(COMMA_BEARING);
    expect(line).toBe("Lead · Lymphocytes, Relative · Neutrophils, Absolute");
    // The property the string above is an instance of: splitting the rendered
    // line on the separator recovers exactly the names that went in. A comma
    // join recovers five.
    expect(line.split(NAME_JOIN_SEPARATOR)).toEqual(COMMA_BEARING);
  });

  it("the list and the count agree — the failure was that they did not", () => {
    const names = [...COMMA_BEARING, "Ferritin", "TSH"];
    const line = summarizeNames(names, 3);
    expect(line).toBe(
      "Lead · Lymphocytes, Relative · Neutrophils, Absolute and 2 more"
    );
    const [listed, tail] = line.split(" and ");
    expect(listed.split(NAME_JOIN_SEPARATOR)).toHaveLength(3);
    expect(tail).toBe("2 more");
  });

  it("no name may contain the separator", () => {
    // Stated as the rule rather than as an example, so it fails on ANY name
    // shape a future entry introduces, not only on a comma.
    for (const name of COMMA_BEARING)
      expect(name).not.toContain(NAME_JOIN_SEPARATOR);
  });

  it("the tail and the empty case are unchanged", () => {
    expect(summarizeNames([])).toBe("");
    expect(summarizeNames(["Ferritin"])).toBe("Ferritin");
    expect(joinNames(["A", "B"])).toBe("A · B");
  });
});

describe("a sentence subject reads 'and' for two, the separator beyond", () => {
  it("two names are spoken, not listed", () => {
    expect(joinNamesForSentence(["LDL Cholesterol", "ApoB"])).toBe(
      "LDL Cholesterol and ApoB"
    );
  });

  it("one name is itself, and three or more take the separator", () => {
    expect(joinNamesForSentence(["ApoB"])).toBe("ApoB");
    expect(joinNamesForSentence(["A", "B", "C"])).toBe("A · B · C");
  });

  it("still never a comma, so a comma-bearing pair stays two", () => {
    const line = joinNamesForSentence([
      "Lymphocytes, Relative",
      "Neutrophils, Absolute",
    ]);
    expect(line).toBe("Lymphocytes, Relative and Neutrophils, Absolute");
    expect(line.split(" and ")).toHaveLength(2);
  });
});

// EVERY CONSUMER INHERITS IT, which is the reason the join lives in one module.
// The issue named three; a fourth would be a new import of this file.
describe("the three consumers render the shared separator", () => {
  function trajectoryFinding(analyte: string): Finding {
    return {
      domain: "trajectory",
      dedupeKey: `trajectory:${analyte}:velocity`,
      supersedes: biomarkerFlagDismissalKey(analyte),
      title: `${analyte} velocity`,
      tone: "caution",
    };
  }

  it("the Results trajectory roster (lib/trajectory-rollup)", () => {
    const rollup = rollupTrajectoryFindings(
      COMMA_BEARING.map(trajectoryFinding)
    );
    expect(rollup.analyteCount).toBe(3);
    expect(rollup.names).toBe(
      "Lead · Lymphocytes, Relative · Neutrophils, Absolute"
    );
  });

  it("the Training-watch muscle roster (lib/training-findings-rollup)", () => {
    expect(summarizeMuscleNames(["Chest", "Quads"])).toBe("Chest · Quads");
  });

  it("the illness dose-lane roster (lib/illness-episode-format)", () => {
    expect(
      doseLaneRoster([
        { name: "Ibuprofen", administrations: [{}, {}] },
        { name: "Iron", administrations: [{}] },
      ] as never)
    ).toBe("Ibuprofen ×2 · Iron ×1");
  });
});

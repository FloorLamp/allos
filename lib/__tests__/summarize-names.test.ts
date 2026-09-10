import { describe, expect, it } from "vitest";
import {
  NAME_JOIN_SEPARATOR,
  joinNames,
  joinNamesForSentence,
  summarizeNames,
  summarizeNamesForSentence,
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

describe("summarizeNamesForSentence", () => {
  // The sentence form the held-offer line uses (#5321, PM ruling 2026-09-09 23:15
  // UTC): a subject the line then makes ONE claim about, so two names read "and".
  it("reads two names aloud and keeps the roster separator past them", () => {
    expect(summarizeNamesForSentence([])).toBe("");
    expect(summarizeNamesForSentence(["Ibuprofen"])).toBe("Ibuprofen");
    expect(summarizeNamesForSentence(["Ibuprofen", "Magnesium"])).toBe(
      "Ibuprofen and Magnesium"
    );
    expect(summarizeNamesForSentence(["A", "B", "C"])).toBe("A · B · C");
    expect(summarizeNamesForSentence(["A", "B", "C", "D"])).toBe(
      "A · B · C and 1 more"
    );
  });

  // THE COLLISION, PROVED RATHER THAN ARGUED FROM THE DEFAULT LIMIT. "A and B and 2
  // more" is the line a reader cannot parse — is B a name, or the start of the count?
  // It is unreachable because the sentence join runs only while the WHOLE list is
  // shown, not because the limit happens to be three: at a limit of two, four names
  // still take the roster separator. So whenever anything is counted, this function IS
  // `summarizeNames` — one implementation of the counted form, and no conjunction in it.
  it("never puts the conjunction next to the count, at any limit", () => {
    expect(summarizeNamesForSentence(["A", "B"], 2)).toBe("A and B");
    expect(summarizeNamesForSentence(["A", "B", "C", "D"], 2)).toBe(
      "A · B and 2 more"
    );
    for (let n = 0; n <= 8; n++) {
      const names = Array.from({ length: n }, (_, i) => `N${i}`);
      for (const limit of [0, 1, 2, 3, 4]) {
        const line = summarizeNamesForSentence(names, limit);
        if (line.endsWith(" more"))
          expect(line).toBe(summarizeNames(names, limit));
      }
    }
  });
});

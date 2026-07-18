import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConditionTrainingConsiderationsDataset } from "@/scripts/gen-condition-training-considerations";
import {
  conditionTrainingConsiderationsDataset,
  conditionConsiderationKeyStrategy,
} from "@/lib/datasets/condition-training-considerations";
import {
  citationPresent,
  identityResolves,
  noKeyCollisions,
  runHarness,
} from "@/lib/datasets";
import {
  matchConditionConsiderations,
  conditionConsiderationSignalKey,
} from "@/lib/condition-training-considerations";

// Anti-drift + framework-contract pins for the baked condition→training-consideration
// dataset (issue #666). The committed lib/datasets/data JSON must be a FIXED POINT of the
// generator, pass the framework harness (citation / identity / refusal / no-collisions),
// and the domain matcher must stay behavior-consistent (the consideration NOTE the
// next-workout card + Telegram nudge rely on). Pure — reads the generator + the committed
// JSON, no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(
  REPO,
  "lib/datasets/data/condition-training-considerations.json"
);

describe("condition-training-considerations.json dataset", () => {
  it("is a fixed point of buildConditionTrainingConsiderationsDataset() (regenerate with `npm run gen:condition-training-considerations`)", () => {
    const generated =
      JSON.stringify(buildConditionTrainingConsiderationsDataset(), null, 2) +
      "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / identity slug / refusal / no collisions)", () => {
    const r = runHarness(
      conditionTrainingConsiderationsDataset,
      conditionConsiderationKeyStrategy
    );
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries a citation with a public source", () => {
    const r = citationPresent(conditionTrainingConsiderationsDataset);
    expect(r.problems).toEqual([]);
    expect(conditionTrainingConsiderationsDataset.citation[0].source).toMatch(
      /ACOG|NIH|NHLBI|CDC|HHS/i
    );
  });

  it("resolves every entry by its own slug identity, with no collisions", () => {
    expect(
      identityResolves(
        conditionTrainingConsiderationsDataset,
        conditionConsiderationKeyStrategy
      ).problems
    ).toEqual([]);
    expect(
      noKeyCollisions(
        conditionTrainingConsiderationsDataset,
        conditionConsiderationKeyStrategy
      ).problems
    ).toEqual([]);
  });
});

describe("matchConditionConsiderations (#666 domain matcher)", () => {
  it("maps an active osteoporosis condition to its consideration note", () => {
    const hits = matchConditionConsiderations([{ name: "Osteoporosis" }]);
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe("osteoporosis");
    expect(hits[0].note).toMatch(/progressive loading/i);
  });

  it("matches by ICD-10 code prefix when the name doesn't", () => {
    const hits = matchConditionConsiderations([
      { name: "Age-related bone loss", code: "M80.08XA" },
    ]);
    expect(hits.map((h) => h.key)).toEqual(["osteoporosis"]);
  });

  it("word-boundary matches hypertension synonyms without partial-word hits", () => {
    expect(
      matchConditionConsiderations([{ name: "Uncontrolled hypertension" }]).map(
        (h) => h.key
      )
    ).toEqual(["uncontrolled-hypertension"]);
    // Controlled essential hypertension is NOT the uncontrolled entry — no synonym match.
    expect(
      matchConditionConsiderations([{ name: "Essential hypertension" }])
    ).toEqual([]);
  });

  it("returns NOTHING for an unmapped condition (never a guess)", () => {
    expect(
      matchConditionConsiderations([{ name: "Seasonal allergies" }])
    ).toEqual([]);
  });

  it("de-duplicates by entry key when two conditions map to the same note", () => {
    const hits = matchConditionConsiderations([
      { name: "Osteoporosis" },
      { name: "Osteopenia" },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe("osteoporosis");
  });

  it("keys the dismissal on the entry key, not the raw condition name (#482)", () => {
    expect(conditionConsiderationSignalKey("osteoporosis")).toBe(
      "condition-consideration:osteoporosis"
    );
  });
});

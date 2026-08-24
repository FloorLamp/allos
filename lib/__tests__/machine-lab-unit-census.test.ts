import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MACHINE_LAB_UNIT_RE,
  machineLabUnitHits,
} from "@/lib/machine-lab-unit-census";
import { rawRenderedUnitExits } from "@/lib/lab-unit-display-census";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [full]
      : [];
  });
}

describe("the machine-spelled lab-unit matcher (#3545)", () => {
  it("sees every supported ASCII micro token in rendered lab copy", () => {
    expect(machineLabUnitHits("Coenzyme Q10 1.20 ug/mL")).toEqual(["ug"]);
    expect(machineLabUnitHits("Lead 2 ug/dL · Selenium 45 ug/L")).toEqual([
      "ug",
      "ug",
    ]);
    expect(
      machineLabUnitHits(
        "WBC 5.8 10^3/uL · insulin 6 uIU/mL · TSH 2 uU/mL · 9 umol/L"
      )
    ).toEqual(["uL", "uIU", "uU", "umol"]);
    expect(
      machineLabUnitHits(
        "Selenium 45 ug / L · insulin 6 uIU / mL · TSH 2 uU / mL · 9 umol / L"
      )
    ).toEqual(["ug", "uIU", "uU", "umol"]);
  });

  it("stays quiet on display spelling, dose vocabulary, and ordinary words", () => {
    for (const text of [
      "Coenzyme Q10 1.20 µg/mL",
      "TSH 2 µU/mL",
      "Lead 2 mcg/dL",
      "Vitamin B12 500 mcg",
      "drug/mL",
      "drug / mL",
      "shrug/off",
      "shrug / off",
    ]) {
      expect(machineLabUnitHits(text)).toEqual([]);
    }
  });

  it("is stateless across calls", () => {
    const text = "Selenium 45 ug/L";
    expect(machineLabUnitHits(text)).toEqual(["ug"]);
    expect(machineLabUnitHits(text)).toEqual(["ug"]);
    expect(MACHINE_LAB_UNIT_RE.lastIndex).toBe(0);
  });

  // Coverage instruments every lib source while this intentionally scans the
  // repository; exact CI measured 27.168s before the source prefilter. Keep the
  // test bounded, but above that known honest runtime (#3669 timeout precedent).
  it("discovers every raw unit property at a lab-copy boundary", () => {
    const offenders = ["app", "components", "lib"].flatMap((root) =>
      sourceFiles(path.join(REPO, root)).flatMap((file) =>
        rawRenderedUnitExits(readFileSync(file, "utf8"), file).map(
          (hit) => `${path.relative(REPO, file)}:${hit.line} ${hit.text}`
        )
      )
    );
    expect(
      offenders,
      "Raw unit properties reached lab copy; wrap the exact exit in displayUnit"
    ).toEqual([]);
  }, 45_000);

  it("cannot be licensed by comments or an unrelated formatter call", () => {
    const source = `
      import { displayUnit } from "@/lib/display-unit";
      export function MedicalValueHostile({ row, other, unit }) {
        return <p>
          {/* displayUnit(row.unit) */}
          {displayUnit(other.unit)}
          {row.unit}
          {unit}
          {row["unit"]}
        </p>;
      }
    `;
    expect(rawRenderedUnitExits(source).map((hit) => hit.text)).toEqual([
      "row.unit",
      "unit",
      'row["unit"]',
    ]);
  });

  it("treats only the exact formatter-wrapped rendered read as clean", () => {
    expect(
      rawRenderedUnitExits(`
        import { displayUnit } from "@/lib/display-unit";
        export function Safe({ row }) {
          return <span title={displayUnit(row.unit) ?? ""}>{displayUnit(row.unit)}</span>;
        }
      `)
    ).toEqual([]);
  });

  it("does not trust a same-named local formatter in a lab component", () => {
    const source = `
      import { displayUnit as realDisplayUnit } from "@/lib/display-unit";
      function displayUnit(unit) { return unit; }
      export function MedicalValueHostile({ row }) {
        return <span>{displayUnit(row.unit)}</span>;
      }
    `;
    expect(rawRenderedUnitExits(source).map((hit) => hit.text)).toEqual([
      "row.unit",
    ]);
  });

  it("does not trust a formatter import that a lab component shadows", () => {
    const source = `
      import { displayUnit } from "@/lib/display-unit";
      export function MedicalValueHostile({ row }) {
        const displayUnit = (unit) => unit;
        return <span>{displayUnit(row.unit)}</span>;
      }
    `;
    expect(rawRenderedUnitExits(source).map((hit) => hit.text)).toEqual([
      "row.unit",
    ]);
  });

  it("authenticates an aliased formatter import", () => {
    const source = `
      import { displayUnit as realDisplayUnit } from "@/lib/display-unit";
      export function MedicalValueSafe({ row }) {
        return <span>{realDisplayUnit(row.unit)}</span>;
      }
    `;
    expect(rawRenderedUnitExits(source)).toEqual([]);
  });

  it("does not trust named function or class expressions that shadow the import", () => {
    for (const local of [
      "const fake = function displayUnit(arg) { return <span>{displayUnit(arg.row.unit)}</span>; };",
      "const fake = class displayUnit { render(arg) { return <span>{displayUnit(arg.row.unit)}</span>; } };",
    ]) {
      const source = `
        import { displayUnit } from "@/lib/display-unit";
        export function MedicalValueHostile() {
          ${local}
          return null;
        }
      `;
      expect(rawRenderedUnitExits(source).map((hit) => hit.text)).toEqual([
        "arg.row.unit",
      ]);
    }
  });

  it("catches raw units in precomposed lab subtitles and helper text", () => {
    const search = `
      export function clinicalResultHits(rows) {
        return rows.map((r) => ({ subtitle: [r.value, r.unit].join(" ") }));
      }
    `;
    expect(
      rawRenderedUnitExits(search, "/repo/lib/queries/search.ts").map(
        (hit) => hit.text
      )
    ).toEqual(["r.unit"]);

    const helper = `
      export function biomarkerGoalTargetText(goal) {
        const unit = goal.unit;
        return String(goal.value) + (unit ? " " + unit : "");
      }
    `;
    expect(
      rawRenderedUnitExits(helper, "/repo/lib/biomarker-goal.ts").map(
        (hit) => hit.text
      )
    ).toEqual(["goal.unit", "unit"]);
  });

  it("accepts the real relative import in precomposed lab copy", () => {
    const source = `
      import { displayUnit as shown } from "../display-unit";
      export function clinicalResultHits(rows) {
        return rows.map((r) => ({ subtitle: shown(r.unit) }));
      }
    `;
    expect(rawRenderedUnitExits(source, "/repo/lib/queries/search.ts")).toEqual(
      []
    );
  });

  it("catches raw units in goal facts, revisions, findings, and longevity copy", () => {
    const cases = [
      {
        file: "/repo/lib/goal-facts.ts",
        source: `
          export function targetFactLabel(t) {
            if (t.kind === "biomarker") {
              const shownUnit = t.unit;
              return shownUnit;
            }
            return t.unit;
          }
          export function goalStartingFrom(i) {
            if (i.kind === "biomarker") {
              return startingFromFactLabel({ unit: i.biomarkerUnit });
            }
            return startingFromFactLabel({ unit: i.freeformUnit });
          }
        `,
        exits: ["t.unit", "i.biomarkerUnit"],
      },
      {
        file: "/repo/lib/lab-result-lifecycle.ts",
        source: `export function revisionSummary(rev) { return "was " + rev.unit; }`,
        exits: ["rev.unit"],
      },
      {
        file: "/repo/lib/biomarker-trajectory.ts",
        source: `export function unitSuffix(unit) { return unit ? " " + unit : ""; }`,
        exits: ["unit"],
      },
      {
        file: "/repo/lib/bio-age.ts",
        source: `export function bioAgeEffectPhrase(e) { const at = e.unit; return at; }`,
        exits: ["e.unit"],
      },
    ];
    for (const candidate of cases) {
      expect(
        rawRenderedUnitExits(candidate.source, candidate.file).map(
          (hit) => hit.text
        ),
        candidate.file
      ).toEqual(candidate.exits);
    }
  });

  it("catches raw units in import diffs, lab follow-ups, and reference cells", () => {
    const cases = [
      {
        file: "/repo/lib/import-diff.ts",
        source: `
          export function recordRow(f) {
            const shownUnit = f.unit;
            return {
              label: f.name + " — " + f.value + " " + shownUnit,
              fields: { unit: f.unit },
            };
          }
        `,
        exits: ["f.unit"],
      },
      {
        file: "/repo/lib/followup-labs.ts",
        source: `
          export function labValueLabel(record) {
            const u = record.unit?.trim();
            return record.value + " " + u;
          }
        `,
        exits: ["record.unit"],
      },
      {
        file: "/repo/lib/reading-reference-cell.ts",
        source: `
          export function referenceCell(input) {
            const suffix = input.judgment.unit ? " " + input.judgment.unit : "";
            return { text: "ref " + input.low + suffix };
          }
        `,
        exits: ["input.judgment.unit"],
      },
    ];
    for (const candidate of cases) {
      expect(
        rawRenderedUnitExits(candidate.source, candidate.file).map(
          (hit) => hit.text
        ),
        candidate.file
      ).toEqual(candidate.exits);
    }
  });

  it("catches raw units in clinical Trends series and sparse fallbacks", () => {
    const source = `
      export function buildBiomarkerSeries(plot) {
        const shownUnit = plot.unit;
        return { unit: shownUnit ? " " + shownUnit : "" };
      }
      function outOfWindowText(point, row, unit) {
        if (point) {
          const shownUnit = unit;
          return { text: point.value + " " + shownUnit };
        }
        const shownUnit = row.unit;
        return { text: row.value + " " + shownUnit };
      }
      export function buildSavedClinicalResultTile(plot) {
        return { unit: plot.unit };
      }
    `;
    expect(
      rawRenderedUnitExits(source, "/repo/lib/trends-series.ts").map(
        (hit) => hit.text
      )
    ).toEqual(["plot.unit", "unit", "row.unit", "plot.unit"]);
  });

  it("catches raw units in sun-exposure copy and unit-mislabel UI", () => {
    const sunExposure = `
      export function decideSunExposure(input) {
        const shownVitaminDUnit = input.vitaminDUnit;
        const valueText = input.value + " " + shownVitaminDUnit;
        return { detail: valueText };
      }
    `;
    expect(
      rawRenderedUnitExits(sunExposure, "/repo/lib/sun-exposure.ts").map(
        (hit) => hit.text
      )
    ).toEqual(["input.vitaminDUnit"]);
    expect(
      rawRenderedUnitExits(
        `export function decideSunExposure(input) { return { detail: input.vitaminDUnit }; }`,
        "/repo/lib/sun-exposure.ts"
      ).map((hit) => hit.text)
    ).toEqual(["input.vitaminDUnit"]);

    const review = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ item, toast }) {
        const statedUnit = item.statedUnit;
        const correctedUnit = item.correctedUnit;
        toast("Unit corrected to " + item.correctedUnit);
        return <p>{item.value} {statedUnit} → {correctedUnit}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(
        review,
        "/repo/components/UnitMislabelReview.tsx"
      ).map((hit) => hit.text)
    ).toEqual(["item.statedUnit", "item.correctedUnit", "item.correctedUnit"]);
  });

  it("follows name-independent aliases and destructuring to rendered lab copy", () => {
    const cases = [
      {
        source: `
          export function LabResultCard({ row }) {
            const u = row.unit;
            return <span>{row.value} {u}</span>;
          }
        `,
        file: "/repo/components/LabResultCard.tsx",
        exits: ["u"],
      },
      {
        source: `
          export function ClinicalResultCard({ row }) {
            const { unit: u } = row;
            return <span>{row.value} {u}</span>;
          }
        `,
        file: "/repo/components/ClinicalResultCard.tsx",
        exits: ["u"],
      },
      {
        source: `
          export function ClinicalResultCard({ unit: u, value }) {
            return <span>{value} {u}</span>;
          }
        `,
        file: "/repo/components/ClinicalResultCard.tsx",
        exits: ["u"],
      },
      {
        source: `
          export function UnitMislabelReview({ item, toast }) {
            const stated = item.statedUnit;
            const corrected = item.correctedUnit;
            toast("Unit corrected to " + corrected);
            return <p>{item.value} {stated} → {corrected}</p>;
          }
        `,
        file: "/repo/components/UnitMislabelReview.tsx",
        exits: ["corrected", "stated", "corrected"],
      },
      {
        source: `
          export function LabResultCard({ row }) {
            const first = row.unit;
            const second = first;
            return <span>{second}</span>;
          }
        `,
        file: "/repo/components/LabResultCard.tsx",
        exits: ["second"],
      },
    ];
    for (const candidate of cases) {
      expect(
        rawRenderedUnitExits(candidate.source, candidate.file).map(
          (hit) => hit.text
        ),
        candidate.file
      ).toEqual(candidate.exits);
    }
  });

  it("does not taint aliases whose raw source crossed the formatter boundary", () => {
    const source = `
      import { displayUnit } from "@/lib/display-unit";
      export function LabResultCard({ row }) {
        const u = displayUnit(row.unit);
        const alias = u;
        return <span>{alias}</span>;
      }
    `;
    expect(
      rawRenderedUnitExits(source, "/repo/components/LabResultCard.tsx")
    ).toEqual([]);
  });

  it("follows assignment patterns, loop bindings, and captured writes", () => {
    const cases = [
      `
        export function UnitMislabelReview({ item, toast }) {
          let spelling = "";
          ({ statedUnit: spelling } = item);
          toast("Stored as " + spelling);
          return <p>{spelling}</p>;
        }
      `,
      `
        export function UnitMislabelReview({ items, toast }) {
          for (const { statedUnit: spelling } of items) {
            toast("Stored as " + spelling);
            return <p>{spelling}</p>;
          }
          return null;
        }
      `,
      `
        export function UnitMislabelReview({ item, toast }) {
          const { "statedUnit": spelling } = item;
          toast("Stored as " + spelling);
          return <p>{spelling}</p>;
        }
      `,
      `
        export function UnitMislabelReview({ items, toast }) {
          let spelling = "";
          items.forEach((item) => { spelling = item.statedUnit; });
          toast("Stored as " + spelling);
          return <p>{spelling}</p>;
        }
      `,
    ];
    for (const source of cases) {
      expect(
        rawRenderedUnitExits(
          source,
          "/repo/components/UnitMislabelReview.tsx"
        ).map((hit) => hit.text)
      ).toEqual(["spelling", "spelling"]);
    }
  });

  it("follows RHS values through array patterns, iterables, and copy joins", () => {
    const cases = [
      {
        source: `
          export function UnitMislabelReview({ item, toast }) {
            const [spelling] = [item.statedUnit];
            toast("Stored as " + spelling);
            return <p>{spelling}</p>;
          }
        `,
        exits: ["spelling", "spelling"],
      },
      {
        source: `
          export function UnitMislabelReview({ item, toast }) {
            let spelling = "";
            [spelling] = [item.statedUnit];
            toast("Stored as " + spelling);
            return <p>{spelling}</p>;
          }
        `,
        exits: ["spelling", "spelling"],
      },
      {
        source: `
          export function UnitMislabelReview({ items, toast }) {
            let spelling = "";
            for ({ statedUnit: spelling } of items) {
              toast("Stored as " + spelling);
              return <p>{spelling}</p>;
            }
            return null;
          }
        `,
        exits: ["spelling", "spelling"],
      },
      {
        source: `
          export function UnitMislabelReview({ items, toast }) {
            for (const spelling of items.map((item) => item.statedUnit)) {
              toast("Stored as " + spelling);
              return <p>{spelling}</p>;
            }
            return null;
          }
        `,
        exits: ["spelling", "spelling"],
      },
      {
        source: `
          export function UnitMislabelReview({ item, toast }) {
            const parts = [item.value, item.confirmed ? item.statedUnit : ""];
            const copy = parts.filter(Boolean).join(" ");
            toast(copy);
            return <p>{copy}</p>;
          }
        `,
        exits: ["copy", "copy"],
      },
    ];
    for (const candidate of cases) {
      expect(
        rawRenderedUnitExits(
          candidate.source,
          "/repo/components/UnitMislabelReview.tsx"
        ).map((hit) => hit.text)
      ).toEqual(candidate.exits);
    }
  });

  it("lets container flow cross the authentic formatter boundary", () => {
    const source = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ items, item, toast }) {
        const [spelling] = [displayUnit(item.statedUnit)];
        const copy = items
          .map((row) => displayUnit(row.statedUnit))
          .filter(Boolean)
          .join(" · ");
        toast(copy);
        return <p>{spelling} {copy}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(source, "/repo/components/UnitMislabelReview.tsx")
    ).toEqual([]);
  });

  it("analyzes named map and flatMap callback bodies", () => {
    const rawCallbacks = [
      `
        export function UnitMislabelReview({ items, toast }) {
          const pick = (item) => item.statedUnit;
          const copy = items.map(pick).join(" · ");
          toast(copy);
          return <p>{copy}</p>;
        }
      `,
      `
        export function UnitMislabelReview({ items, toast }) {
          const copy = items.flatMap(pick).join(" · ");
          toast(copy);
          return <p>{copy}</p>;
          function pick(item) { return [item.statedUnit]; }
        }
      `,
    ];
    for (const source of rawCallbacks) {
      expect(
        rawRenderedUnitExits(
          source,
          "/repo/components/UnitMislabelReview.tsx"
        ).map((hit) => hit.text)
      ).toEqual(["copy", "copy"]);
    }

    const safeCallbacks = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ items, toast }) {
        const pick = (item) => displayUnit(item.statedUnit);
        const pickMany = function (item) { return [displayUnit(item.statedUnit)]; };
        const copy = items.map(pick).concat(items.flatMap(pickMany)).join(" · ");
        toast(copy);
        return <p>{copy}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(
        safeCallbacks,
        "/repo/components/UnitMislabelReview.tsx"
      )
    ).toEqual([]);
  });

  it("evaluates call arguments and captured aliases at invocation", () => {
    const rawCalls = [
      `
        export function UnitMislabelReview({ item }) {
          let spelling = "";
          populate(item.statedUnit);
          return <p>{spelling}</p>;
          function populate(value) { spelling = value; }
        }
      `,
      `
        export function UnitMislabelReview({ item }) {
          let spelling = "";
          let source = "";
          source = item.statedUnit;
          populate();
          return <p>{spelling}</p>;
          function populate() { spelling = source; }
        }
      `,
      `
        export function UnitMislabelReview({ item }) {
          let spelling = "";
          const populate = (value) => { spelling = value; };
          const run = populate.bind(null, item.statedUnit);
          run();
          return <p>{spelling}</p>;
        }
      `,
      `
        export function UnitMislabelReview({ item }) {
          let spelling = "";
          const helper = {
            populate(value) { spelling = value; },
          };
          helper.populate(item.statedUnit);
          return <p>{spelling}</p>;
        }
      `,
    ];
    for (const source of rawCalls) {
      expect(
        rawRenderedUnitExits(
          source,
          "/repo/components/UnitMislabelReview.tsx"
        ).map((hit) => hit.text)
      ).toEqual(["spelling"]);
    }

    const safeCalls = [
      `
        import { displayUnit } from "@/lib/display-unit";
        export function UnitMislabelReview({ item }) {
          let spelling = "";
          populate(displayUnit(item.statedUnit));
          return <p>{spelling}</p>;
          function populate(value) { spelling = value; }
        }
      `,
      `
        import { displayUnit } from "@/lib/display-unit";
        export function UnitMislabelReview({ item }) {
          let spelling = "";
          const source = displayUnit(item.statedUnit);
          populate();
          return <p>{spelling}</p>;
          function populate() { spelling = source; }
        }
      `,
      `
        import { displayUnit } from "@/lib/display-unit";
        export function UnitMislabelReview({ item }) {
          let spelling = "";
          const populate = (value) => { spelling = value; };
          const run = populate.bind(null, displayUnit(item.statedUnit));
          run();
          return <p>{spelling}</p>;
        }
      `,
      `
        import { displayUnit } from "@/lib/display-unit";
        export function UnitMislabelReview({ item }) {
          let spelling = "";
          const helper = {
            populate(value) { spelling = value; },
          };
          helper.populate(displayUnit(item.statedUnit));
          return <p>{spelling}</p>;
        }
      `,
    ];
    for (const source of safeCalls) {
      expect(
        rawRenderedUnitExits(source, "/repo/components/UnitMislabelReview.tsx")
      ).toEqual([]);
    }

    const writeAfterCall = `
      export function UnitMislabelReview({ item }) {
        let spelling = "safe";
        let source = "safe";
        populate();
        source = item.statedUnit;
        return <p>{spelling}</p>;
        function populate() { spelling = source; }
      }
    `;
    expect(
      rawRenderedUnitExits(
        writeAfterCall,
        "/repo/components/UnitMislabelReview.tsx"
      )
    ).toEqual([]);
  });

  it("propagates invocation values through nested callable chains", () => {
    const pairs = [
      [
        `
          export function UnitMislabelReview({ item }) {
            let spelling = "";
            outer(item.statedUnit);
            return <p>{spelling}</p>;
            function outer(value) { inner(value); }
            function inner(value) { spelling = value; }
          }
        `,
        `
          import { displayUnit } from "@/lib/display-unit";
          export function UnitMislabelReview({ item }) {
            let spelling = "";
            outer(displayUnit(item.statedUnit));
            return <p>{spelling}</p>;
            function outer(value) { inner(value); }
            function inner(value) { spelling = value; }
          }
        `,
      ],
      [
        `
          export function UnitMislabelReview({ item }) {
            let spelling = "";
            let source = item.statedUnit;
            outer();
            return <p>{spelling}</p>;
            function outer() { inner(); }
            function inner() { spelling = source; }
          }
        `,
        `
          import { displayUnit } from "@/lib/display-unit";
          export function UnitMislabelReview({ item }) {
            let spelling = "";
            let source = displayUnit(item.statedUnit) ?? "";
            outer();
            return <p>{spelling}</p>;
            function outer() { inner(); }
            function inner() { spelling = source; }
          }
        `,
      ],
    ];
    for (const [raw, safe] of pairs) {
      expect(
        rawRenderedUnitExits(
          raw,
          "/repo/components/UnitMislabelReview.tsx"
        ).map((hit) => hit.text)
      ).toEqual(["spelling"]);
      expect(
        rawRenderedUnitExits(safe, "/repo/components/UnitMislabelReview.tsx")
      ).toEqual([]);
    }

    const rawReturnChain = `
      export function UnitMislabelReview({ items }) {
        const copy = items.map(outer).join(" ");
        return <p>{copy}</p>;
        function outer(value) { return inner(value); }
        function inner(value) { return value.statedUnit; }
      }
    `;
    expect(
      rawRenderedUnitExits(
        rawReturnChain,
        "/repo/components/UnitMislabelReview.tsx"
      ).map((hit) => hit.text)
    ).toEqual(["copy"]);

    const safeReturnChain = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ items }) {
        const copy = items.map(outer).join(" ");
        return <p>{copy}</p>;
        function outer(value) { return inner(value); }
        function inner(value) { return displayUnit(value.statedUnit); }
      }
    `;
    expect(
      rawRenderedUnitExits(
        safeReturnChain,
        "/repo/components/UnitMislabelReview.tsx"
      )
    ).toEqual([]);
  });

  it("substitutes destructured and rest parameters at invocation", () => {
    const pairs = [
      [
        "populate([item.statedUnit]);",
        "populate([displayUnit(item.statedUnit)]);",
        "function populate([value]) { spelling = value; }",
      ],
      [
        "populate({ statedUnit: item.statedUnit });",
        "populate({ statedUnit: displayUnit(item.statedUnit) });",
        "function populate({ statedUnit: value }) { spelling = value; }",
      ],
      [
        "populate(item.value, item.statedUnit);",
        "populate(item.value, displayUnit(item.statedUnit));",
        'function populate(...values) { spelling = values.join(" "); }',
      ],
      [
        "populate([item.value, item.statedUnit]);",
        "populate([item.value, displayUnit(item.statedUnit)]);",
        'function populate([first, ...values]) { spelling = values.join(" "); }',
      ],
      [
        "populate({ meta: { statedUnit: item.statedUnit } });",
        "populate({ meta: { statedUnit: displayUnit(item.statedUnit) } });",
        "function populate({ meta: { statedUnit: value } }) { spelling = value; }",
      ],
    ];
    for (const [rawCall, safeCall, populate] of pairs) {
      const host = (call: string, importLine = "") => `
        ${importLine}
        export function UnitMislabelReview({ item }) {
          let spelling = "";
          ${call}
          return <p>{spelling}</p>;
          ${populate}
        }
      `;
      expect(
        rawRenderedUnitExits(
          host(rawCall),
          "/repo/components/UnitMislabelReview.tsx"
        ).map((hit) => hit.text)
      ).toEqual(["spelling"]);
      expect(
        rawRenderedUnitExits(
          host(safeCall, 'import { displayUnit } from "@/lib/display-unit";'),
          "/repo/components/UnitMislabelReview.tsx"
        )
      ).toEqual([]);
    }
  });

  it("resolves string-keyed callable methods", () => {
    const raw = `
      export function UnitMislabelReview({ item, items }) {
        let spelling = "";
        const helper = {
          pick(value) { return value.statedUnit; },
          populate(value) { spelling = value; },
        };
        const copy = items.map(helper["pick"]).join(" ");
        helper["populate"](item.statedUnit);
        return <p title={copy}>{copy} {spelling}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(raw, "/repo/components/UnitMislabelReview.tsx").map(
        (hit) => hit.text
      )
    ).toEqual(["copy", "copy", "spelling"]);

    const safe = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ item, items }) {
        let spelling = "";
        const helper = {
          pick(value) { return displayUnit(value.statedUnit); },
          populate(value) { spelling = value; },
        };
        const copy = items.map(helper["pick"]).join(" ");
        helper["populate"](displayUnit(item.statedUnit));
        return <p title={copy}>{copy} {spelling}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(safe, "/repo/components/UnitMislabelReview.tsx")
    ).toEqual([]);

    const callback = `
      export function UnitMislabelReview({ item }) {
        let spelling = "";
        const helper = { populate(value) { spelling = value; } };
        [item.statedUnit].forEach(helper["populate"]);
        return <p>{spelling}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(
        callback,
        "/repo/components/UnitMislabelReview.tsx"
      ).map((hit) => hit.text)
    ).toEqual(["spelling"]);
  });

  it("resolves callable assignments at their program point", () => {
    const raw = `
      export function UnitMislabelReview({ item, items }) {
        let spelling = "";
        let pick;
        let populate;
        pick = (value) => value.statedUnit;
        populate = (value) => { spelling = value; };
        const copy = items.map(pick).join(" ");
        populate(item.statedUnit);
        return <p title={copy}>{copy} {spelling}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(raw, "/repo/components/UnitMislabelReview.tsx").map(
        (hit) => hit.text
      )
    ).toEqual(["copy", "copy", "spelling"]);

    const safe = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ item }) {
        let spelling = "";
        let populate = () => {};
        populate(item.statedUnit);
        populate = (value) => { spelling = value; };
        populate(displayUnit(item.statedUnit));
        return <p>{spelling}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(safe, "/repo/components/UnitMislabelReview.tsx")
    ).toEqual([]);

    const killedAssignment = `
      export function UnitMislabelReview({ items }) {
        let pick = (value) => value.statedUnit;
        pick = Math.abs;
        const copy = items.map(pick).join(" ");
        return <p>{copy}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(
        killedAssignment,
        "/repo/components/UnitMislabelReview.tsx"
      )
    ).toEqual([]);
  });

  it("orders captured writes at their runtime invocation, not source location", () => {
    const rawBeforeRender = `
      export function UnitMislabelReview({ item }) {
        let spelling = "";
        populate();
        return <p>{spelling}</p>;
        function populate() {
          spelling = item.statedUnit;
        }
      }
    `;
    expect(
      rawRenderedUnitExits(
        rawBeforeRender,
        "/repo/components/UnitMislabelReview.tsx"
      ).map((hit) => hit.text)
    ).toEqual(["spelling"]);

    const boundCallback = `
      export function UnitMislabelReview({ item }) {
        let spelling = "";
        const populate = () => { spelling = item.statedUnit; };
        populate();
        return <p>{spelling}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(
        boundCallback,
        "/repo/components/UnitMislabelReview.tsx"
      ).map((hit) => hit.text)
    ).toEqual(["spelling"]);

    const neverCalled = `
      export function UnitMislabelReview({ item }) {
        let spelling = "safe";
        return <p>{spelling}</p>;
        function populate() {
          spelling = item.statedUnit;
        }
      }
    `;
    expect(
      rawRenderedUnitExits(
        neverCalled,
        "/repo/components/UnitMislabelReview.tsx"
      )
    ).toEqual([]);

    const authenticKill = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ item }) {
        let spelling = item.statedUnit;
        normalize();
        return <p>{spelling}</p>;
        function normalize() {
          spelling = displayUnit(spelling) ?? "";
        }
      }
    `;
    expect(
      rawRenderedUnitExits(
        authenticKill,
        "/repo/components/UnitMislabelReview.tsx"
      )
    ).toEqual([]);

    const conditionalKill = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ item }) {
        let spelling = item.statedUnit;
        if (item.confirmed) normalize();
        return <p>{spelling}</p>;
        function normalize() {
          spelling = displayUnit(spelling) ?? "";
        }
      }
    `;
    expect(
      rawRenderedUnitExits(
        conditionalKill,
        "/repo/components/UnitMislabelReview.tsx"
      ).map((hit) => hit.text)
    ).toEqual(["spelling"]);
  });

  it("clears taint only at an authentic formatter write", () => {
    const safe = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ item, toast }) {
        let spelling = item.statedUnit;
        spelling = displayUnit(spelling) ?? "";
        toast("Stored as " + spelling);
        return <p>{spelling}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(safe, "/repo/components/UnitMislabelReview.tsx")
    ).toEqual([]);

    const conditional = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ item, toast }) {
        let spelling = item.statedUnit;
        if (item.confirmed) spelling = displayUnit(spelling) ?? "";
        toast("Stored as " + spelling);
        return <p>{spelling}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(
        conditional,
        "/repo/components/UnitMislabelReview.tsx"
      ).map((hit) => hit.text)
    ).toEqual(["spelling", "spelling"]);

    const capturedThenSafe = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ items, toast }) {
        let spelling = "";
        items.forEach((item) => { spelling = item.statedUnit; });
        spelling = displayUnit(spelling) ?? "";
        toast("Stored as " + spelling);
        return <p>{spelling}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(
        capturedThenSafe,
        "/repo/components/UnitMislabelReview.tsx"
      )
    ).toEqual([]);

    const shadowed = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ item }) {
        function Nested({ displayUnit }) {
          return <p>{displayUnit(item.statedUnit)}</p>;
        }
        return <Nested displayUnit={(value) => value} />;
      }
    `;
    expect(
      rawRenderedUnitExits(
        shadowed,
        "/repo/components/UnitMislabelReview.tsx"
      ).map((hit) => hit.text)
    ).toEqual(["item.statedUnit"]);
  });

  it("resolves block shadows without distrusting an authentic outer formatter", () => {
    const blockShadow = `
      export function UnitMislabelReview({ item, toast }) {
        const spelling = item.statedUnit;
        if (item.dismissed) {
          const spelling = "unknown";
          toast("Stored as " + spelling);
          return <p>{spelling}</p>;
        }
        return null;
      }
    `;
    expect(
      rawRenderedUnitExits(
        blockShadow,
        "/repo/components/UnitMislabelReview.tsx"
      )
    ).toEqual([]);

    const formatterShadow = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ item }) {
        function unrelated(displayUnit) { return displayUnit; }
        return <p>{displayUnit(item.statedUnit)}</p>;
      }
    `;
    expect(
      rawRenderedUnitExits(
        formatterShadow,
        "/repo/components/UnitMislabelReview.tsx"
      )
    ).toEqual([]);
  });

  it("covers the biomarker option's existing latestUnit producer", () => {
    const source = `
      export function GoalForm({ bioOption, kind }) {
        if (kind === "biomarker") return <p>{bioOption.latestUnit}</p>;
        return null;
      }
    `;
    expect(
      rawRenderedUnitExits(source, "/repo/app/(app)/training/GoalForm.tsx").map(
        (hit) => hit.text
      )
    ).toEqual(["bioOption.latestUnit"]);
  });

  it("does not leak a tainted alias through an unrelated nested shadow", () => {
    const source = `
      export function LabResultCard({ row }) {
        const u = row.unit;
        function DoseCopy() {
          const u = "mcg";
          return <span>{u}</span>;
        }
        return <DoseCopy />;
      }
    `;
    expect(
      rawRenderedUnitExits(source, "/repo/components/LabResultCard.tsx")
    ).toEqual([]);
  });

  it("ignores ordinary unit suffixes outside lab contexts", () => {
    expect(
      rawRenderedUnitExits(`
        export function RideSpeed({ row }) {
          return <span>{row.value}{row.unit}</span>;
        }
      `)
    ).toEqual([]);
  });
});

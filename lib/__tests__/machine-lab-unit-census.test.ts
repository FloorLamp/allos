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
const LAB_FILE = "/repo/components/UnitMislabelReview.tsx";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return /^__(?:db_)?tests__$/.test(entry.name) ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !/\.(?:test|spec)\.tsx?$/.test(entry.name)
      ? [full]
      : [];
  });
}

function texts(source: string, file = LAB_FILE): string[] {
  return rawRenderedUnitExits(source, file).map((hit) => hit.text);
}

describe("the machine-spelled lab-unit matcher (#3545)", () => {
  it("sees every supported ASCII micro token, including spaced slashes", () => {
    expect(machineLabUnitHits("CoQ10 1.2 ug/mL · Lead 2 ug / dL")).toEqual([
      "ug",
      "ug",
    ]);
    expect(
      machineLabUnitHits("WBC 5.8 10^3/uL · 6 uIU / mL · 2 uU/mL · 9 umol / L")
    ).toEqual(["uL", "uIU", "uU", "umol"]);
  });

  it("stays quiet on display spelling, dose vocabulary, and ordinary words", () => {
    for (const value of [
      "1.2 µg/mL",
      "2 µU/mL",
      "500 mcg",
      "drug/mL",
      "drug / mL",
      "shrug/off",
      "shrug / off",
    ])
      expect(machineLabUnitHits(value)).toEqual([]);
  });

  it("is stateless across calls", () => {
    expect(machineLabUnitHits("45 ug/L")).toEqual(["ug"]);
    expect(machineLabUnitHits("45 ug/L")).toEqual(["ug"]);
    expect(MACHINE_LAB_UNIT_RE.lastIndex).toBe(0);
  });

  // Test modules are not shipped exits and are excluded before file I/O. Keep
  // this well below the 45 s timeout that originally motivated the prefilter.
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

  it("requires the exact raw read to use the canonical formatter", () => {
    const source = `
      import { displayUnit } from "@/lib/display-unit";
      export function MedicalValueHostile({ row, other, unit }) {
        return <p>{/* displayUnit(row.unit) */}{displayUnit(other.unit)}{row.unit}{unit}{row["unit"]}</p>;
      }
    `;
    expect(texts(source, "/repo/components/MedicalValueHostile.tsx")).toEqual([
      "row.unit",
      "unit",
      'row["unit"]',
    ]);
    expect(
      texts(`
      import { displayUnit } from "@/lib/display-unit";
      export function MedicalValueSafe({ row }) { return <span title={displayUnit(row.unit) ?? ""}>{displayUnit(row.unit)}</span>; }
    `)
    ).toEqual([]);
  });

  it("authenticates imports, aliases, and lexical shadows", () => {
    expect(
      texts(`
      import { displayUnit as shown } from "@/lib/display-unit";
      export function MedicalValueSafe({ row }) { return <span>{shown(row.unit)}</span>; }
    `)
    ).toEqual([]);

    for (const local of [
      `function displayUnit(value) { return value; }`,
      `const displayUnit = (value) => value;`,
      `const fake = function displayUnit(arg) { return displayUnit(arg.row.unit); };`,
      `const fake = class displayUnit { render(arg) { return displayUnit(arg.row.unit); } };`,
    ]) {
      expect(
        texts(
          `
        import { displayUnit as realDisplayUnit } from "@/lib/display-unit";
        export function MedicalValueHostile({ row }) { ${local} return <span>{displayUnit(row.unit)}</span>; }
      `,
          "/repo/components/MedicalValueHostile.tsx"
        )
      ).not.toEqual([]);
    }

    expect(
      texts(
        `
          import { displayUnit } from "@/lib/display-unit";
          export function MedicalValueHostile({ row }) {
            function displayUnit(value) { return value; }
            return <span>{displayUnit(row.unit)}</span>;
          }
        `,
        "/repo/components/MedicalValueHostile.tsx"
      )
    ).toEqual(["row.unit"]);

    expect(
      texts(`
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({ item }) {
        function unrelated(displayUnit) { return displayUnit; }
        return <p>{displayUnit(item.statedUnit)}</p>;
      }
    `)
    ).toEqual([]);
  });

  it("covers raw/precomposed lab-copy exits", () => {
    const cases = [
      [
        "/repo/lib/queries/search.ts",
        `export function clinicalResultHits(rows) { return rows.map(r => ({ subtitle: [r.value, r.unit].join(" ") })); }`,
        "r.unit",
      ],
      [
        "/repo/lib/biomarker-goal.ts",
        `export function biomarkerGoalTargetText(goal) { const unit = goal.unit; return String(goal.value) + " " + unit; }`,
        "goal.unit",
      ],
      [
        "/repo/lib/lab-result-lifecycle.ts",
        `export function revisionSummary(rev) { return "was " + rev.unit; }`,
        "rev.unit",
      ],
      [
        "/repo/lib/biomarker-trajectory.ts",
        `export function unitSuffix(unit) { return unit ? " " + unit : ""; }`,
        "unit",
      ],
      [
        "/repo/lib/bio-age.ts",
        `export function bioAgeEffectPhrase(e) { return e.unit; }`,
        "e.unit",
      ],
      [
        "/repo/lib/followup-labs.ts",
        `export function labValueLabel(record) { return record.value + " " + record.unit?.trim(); }`,
        "record.unit",
      ],
      [
        "/repo/lib/reading-reference-cell.ts",
        `export function referenceCell(input) { return { text: "ref " + input.judgment.unit }; }`,
        "input.judgment.unit",
      ],
      [
        "/repo/lib/sun-exposure.ts",
        `export function decideSunExposure(input) { return { detail: input.vitaminDUnit }; }`,
        "input.vitaminDUnit",
      ],
      [
        "/repo/app/(app)/training/GoalForm.tsx",
        `export function GoalForm({ bioOption }) { return <p>{bioOption.latestUnit}</p>; }`,
        "bioOption.latestUnit",
      ],
    ] as const;
    for (const [file, source, exit] of cases)
      expect(texts(source, file), file).toContain(exit);
  });

  it("rejects aliases, destructuring, arrays, loops, callbacks, and call arguments at the source", () => {
    const cases = [
      `const u = item.statedUnit; toast(u);`,
      `const { statedUnit: u } = item; toast(u);`,
      `let u; ({ statedUnit: u } = item); toast(u);`,
      `const [u] = [item.statedUnit]; toast(u);`,
      `for (const u of items.map(item => item.statedUnit)) toast(u);`,
      `const pick = item => item.statedUnit; toast(items.map(pick).join(" "));`,
      `function populate(value) { copy = value } populate(item.statedUnit); toast(copy);`,
      `const parts = [item.value, item.confirmed ? item.statedUnit : ""]; toast(parts.join(" "));`,
    ];
    for (const body of cases) {
      const source = `export function UnitMislabelReview({ item, items, toast }) { let copy = ""; ${body}; return <p>{copy}</p>; }`;
      expect(texts(source), body).not.toEqual([]);
    }
  });

  it("rejects nested callable chains, destructured/rest arguments, and callable snapshots", () => {
    const cases = [
      `function one(v){two(v)} function two(v){copy=v} one(item.statedUnit);`,
      `function populate({value}){copy=value} populate({value:item.statedUnit});`,
      `function populate(...values){copy=values[0]} populate(item.statedUnit);`,
      `const helper={pick:value=>value.statedUnit}; const {pick}=helper; copy=items.map(pick).join(" ");`,
      `const helper={pick:value=>value.statedUnit}; let pick; ({pick}=helper); copy=items.map(pick).join(" ");`,
      `const helper={pick:value=>value.statedUnit}; const [pick]=[helper.pick]; copy=items.map(pick).join(" ");`,
      `const helper={pick:value=>value.statedUnit}; const alias={...helper}; copy=items.map(alias.pick).join(" ");`,
      `const helper={}; helper["pick"]=value=>value.statedUnit; copy=items.map(helper["pick"]).join(" ");`,
    ];
    for (const body of cases) {
      expect(
        texts(
          `export function UnitMislabelReview({item,items}) { let copy=""; ${body}; return <p>{copy}</p>; }`
        ),
        body
      ).not.toEqual([]);
    }
  });

  it("rejects every latest parameter/property/object mutation", () => {
    const raw = [
      `const payload={value:""}; set(payload,item.statedUnit); function set(target,value){target.value=value} return <p>{payload.value}</p>;`,
      `const helper={}; install(helper); function install(target){target.pick=item=>item.statedUnit} return <p>{items.map(helper.pick)}</p>;`,
      `const payload={nested:{value:""}}; payload.nested.value=item.statedUnit; return <p>{payload.nested.value}</p>;`,
      `const payload={nested:{value:""}}; const alias=payload.nested; alias.value=item.statedUnit; return <p>{payload.nested.value}</p>;`,
      `const payload={value:""}; payload.value ||= item.statedUnit; return <p>{payload.value}</p>;`,
      `const helper={pick:item=>item.statedUnit}; let pick; ({pick}=helper); return <p>{items.map(pick)}</p>;`,
      `const helper={pick:item=>item.statedUnit}; const [pick]=[helper.pick]; return <p>{items.map(pick)}</p>;`,
      `const helper={pick:item=>item.statedUnit}; const alias={...helper}; return <p>{items.map(alias.pick)}</p>;`,
      `let helper={}; const old=helper; helper={pick:item=>item.statedUnit}; old.pick=Math.abs; return <p>{items.map(helper.pick)}</p>;`,
    ];
    for (const body of raw)
      expect(
        texts(`export function UnitMislabelReview({item,items}) { ${body} }`),
        body
      ).toContain("item.statedUnit");
  });

  it("allows syntax-local storage followed by direct authenticated normalization", () => {
    const safe = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({item}) {
        const payload={value:item.statedUnit};
        normalize(payload);
        function normalize(target){target.value=displayUnit(target.value)??""}
        return <p>{payload.value}</p>;
      }
    `;
    expect(texts(safe)).toEqual([]);

    const nested = `
      import { displayUnit } from "@/lib/display-unit";
      export function UnitMislabelReview({item}) {
        const payload={nested:{value:item.statedUnit}};
        payload.nested.value=displayUnit(payload.nested.value)??"";
        return <p>{payload.nested.value}</p>;
      }
    `;
    expect(texts(nested)).toEqual([]);
  });

  it("allows documented raw semantics and rejects post-construction projection writes", () => {
    expect(
      texts(
        `export function ClinicalResultIndex({row, canonical}) { return sameUnit(row.unit, canonical) ? { unit: row.unit } : null; }`,
        "/repo/lib/clinical-result-index.ts"
      )
    ).toEqual([]);
    expect(
      texts(
        `export function UnitMislabelReview({item}) { const payload={value:""}; payload.value=item.statedUnit; return <p>{payload.value}</p>; }`
      )
    ).toEqual(["item.statedUnit"]);
  });

  it("ignores ordinary units outside lab contexts", () => {
    expect(
      texts(
        `export function RideSpeed({row}) { return <span>{row.value}{row.unit}</span>; }`,
        "/repo/components/RideSpeed.tsx"
      )
    ).toEqual([]);
  });
});

// TEMPORARY differential dump (#5175 section 1). Enumerates every name the uncurated
// registry can answer for and every near-miss it must refuse, and writes the answers
// to $UNCURATED_DIFF_OUT. Run on base and on head; the two files must be identical.
import { describe, it } from "vitest";
import fs from "node:fs";
import { normalizeCanonicalKey } from "../canonical-name";
// DIFF_IMPORT
import { uncuratedAnalyte, uncuratedAnalytes } from "../datasets/uncurated-analytes";
import canonicalSeed from "../canonical-result-definitions.json";

// Every region name that appears in ANY of the three DEXA region lists, so the cross
// product below mints declared rows AND undeclared ones (a bone-only site under the
// fat prefix must refuse).
const ALL_REGIONS = [
  "Left Arm", "Right Arm", "Arms", "Left Leg", "Right Leg", "Legs", "Trunk",
  "Head", "Android", "Gynoid", "Subtotal", "Total",
  "Left Ribs", "Right Ribs", "Ribs", "Thoracic Spine", "Lumbar Spine", "Spine",
  "Left Pelvis", "Right Pelvis", "Pelvis",
  "Neck", "Left Hand", "Whole Body",
];
const COMPARTMENTS = ["Fat", "Lean", "Total", "Bone", "Water"];
const ROW_PREFIXES = [
  "Body Fat Percentage",
  "Bone Mineral Density",
  "Bone Mineral Content",
  "Lean Mass Index",
  "Fat Mass Index",
];
const SCAN_LEVEL_PROBES = [
  "Total Mass", "Total Fat Mass", "Total Lean Mass", "Bone Mineral Content, Total",
  "Trunk to Legs Fat Ratio", "Trunk to Limb Fat Mass Ratio", "Android/Gynoid Ratio",
  "Fat Mass Index", "Lean Mass Index", "Appendicular Lean Mass Index",
  "Bone Mineral Density, Total", "Bone Mineral Density Z-Score",
  "Bone Mineral Density T-Score", "Visceral Adipose Tissue",
  "Visceral Adipose Tissue Area", "Visceral Adipose Tissue Volume",
];
const OTHER_PROBES = [
  "eGFR", "eGFR, African American", "eGFR, Non-African-American", "eGFR, Thai",
  "eGFR, Asian", "Estimated Glomerular Filtration Rate (eGFR)",
  "Beta Adrenergic Blocker Screen", "Diuretic Screen, Urine", "Diuretic Screen",
  "Stress Test Resting Blood Pressure Systolic",
  "Stress Test Resting Blood Pressure Diastolic",
  "Stress Test Maximum Blood Pressure Systolic",
  "Stress Test Maximum Blood Pressure Diastolic",
  "Stress Test Maximum Heart Rate", "Stress Test Resting Heart Rate",
  "Blood Pressure Systolic", "Blood Pressure Diastolic", "Heart Rate",
  "Glucose", "E2E Novel Marker", "", "   ", "Body Fat Percentage",
  "Bone Mineral Density", "Total", "Mass", "(g)", "Fat Mass",
];

// The spellings a caller can produce for one declared name: the printed name, case
// folds, whitespace noise, comma→parenthesis, and comma-segment reversal (the word
// order normalizeCanonicalKey folds).
function spellings(name: string): string[] {
  const out = new Set<string>([
    name,
    name.toLowerCase(),
    name.toUpperCase(),
    `  ${name}  `,
    name.replace(/\s+/g, "  "),
    name.replace(/,\s*/g, " "),
    name.replace(/\s*,\s*/g, "-"),
  ]);
  const m = /^(.*?),\s*(.*)$/.exec(name);
  if (m) {
    out.add(`${m[2]} ${m[1]}`);
    out.add(`${m[1]} (${m[2]})`);
    out.add(`${m[2]!.toLowerCase()} ${m[1]!.toLowerCase()}`);
  }
  if (name.endsWith(" Mass")) out.add(`${name} (g)`);
  if (name.endsWith(" Mass (g)")) out.add(name.slice(0, -4).trim());
  return [...out];
}

function probeNames(): string[] {
  const names = new Set<string>();
  for (const [n] of uncuratedAnalytes()) for (const s of spellings(n)) names.add(s);
  for (const p of ROW_PREFIXES)
    for (const r of ALL_REGIONS) for (const s of spellings(`${p}, ${r}`)) names.add(s);
  for (const r of ALL_REGIONS)
    for (const c of COMPARTMENTS)
      for (const s of spellings(`${r} ${c} Mass`)) names.add(s);
  for (const p of [...SCAN_LEVEL_PROBES, ...OTHER_PROBES])
    for (const s of spellings(p)) names.add(s);
  for (const d of (canonicalSeed as { definitions: { name: string }[] }).definitions)
    names.add(d.name);
  return [...names].sort();
}

describe("uncurated registry differential dump", () => {
  it("dumps every answer", () => {
    const out = process.env.UNCURATED_DIFF_OUT;
    if (!out) throw new Error("UNCURATED_DIFF_OUT unset");
    const probes = probeNames();
    const answers: Record<string, unknown> = {};
    // Shared-declaration IDENTITY: which probes resolve to the SAME object. Recorded
    // as a stable group index so `toBe`-style sharing is part of the differential.
    const objIndex = new Map<object, number>();
    for (const name of probes) {
      const d = uncuratedAnalyte(name);
      if (d && !objIndex.has(d)) objIndex.set(d, objIndex.size);
      answers[name] = d
        ? { ...d, __shared: objIndex.get(d), __key: normalizeCanonicalKey(name) }
        : null;
    }
    const dump = {
      probeCount: probes.length,
      answeredCount: probes.filter((n) => uncuratedAnalyte(n) !== null).length,
      // The registry's own listing, in order, with declaration identity.
      listing: uncuratedAnalytes().map(([name, d]) => [
        name,
        normalizeCanonicalKey(name),
        d,
        objIndex.has(d) ? objIndex.get(d) : `unprobed:${JSON.stringify(d)}`,
      ]),
      nullish: [uncuratedAnalyte(null), uncuratedAnalyte(undefined)],
      answers,
    };
    fs.writeFileSync(out, JSON.stringify(dump, null, 2));
  });
});

// Pre-generate the canonical biomarker reference dataset (lib/canonical-biomarkers.json).
//
// Calls the Anthropic API once per category to produce structured reference +
// longevity-optimal ranges for common biomarkers, then writes the merged result
// to lib/canonical-biomarkers.json. The file is COMMITTED and meant to be
// HUMAN-REVIEWED before it is trusted — the ranges are informational, not
// medical advice, and can be wrong. No per-request cost at app runtime; this is
// a one-off (re)generation step.
//
//   ANTHROPIC_API_KEY=... npm run gen:biomarkers
//
// Runs in batches by category to stay within the output budget. Existing entries
// in the JSON are preserved unless --overwrite is passed (so hand-curated edits
// survive a regen by default).
//
// The curated reference DATA it folds in — AGE_BANDS, CURATED_LABS, RETEST_DAYS,
// VELOCITY_PER_YEAR, the Biomarker shape, and the pure curateBiomarkers()
// transform — lives in lib/curated-biomarkers.ts (issue #80), not here. This
// script keeps only the generator LOGIC (the Anthropic calls, the merge/write
// orchestration, and the API-free --curated-only / --age-bands-only paths).

import "./load-env";

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  type Biomarker,
  AGE_BANDS,
  CURATED_LABS,
  curateBiomarkers,
} from "@/lib/curated-biomarkers";

const MODEL = process.env.HEALTH_AI_MODEL || "claude-sonnet-5";
const OUT = path.join(process.cwd(), "lib", "canonical-biomarkers.json");
const OVERWRITE = process.argv.includes("--overwrite");
// Re-apply only the curated pediatric age bands to the existing committed JSON,
// WITHOUT calling the model (no API key needed). Use this to refresh the age
// bands after editing AGE_BANDS below:  npx tsx scripts/gen-canonical-biomarkers.ts --age-bands-only
const AGE_BANDS_ONLY = process.argv.includes("--age-bands-only");
// Re-apply the curated static lab entries (CURATED_LABS) AND the age bands to the
// existing committed JSON, WITHOUT calling the model (no API key needed). Missing
// curated entries are appended (existing order + human edits preserved); use this
// after editing CURATED_LABS/AGE_BANDS:
//   npx tsx scripts/gen-canonical-biomarkers.ts --curated-only
const CURATED_ONLY = process.argv.includes("--curated-only");

// Attach the curated age bands to the matching biomarker rows (by exact canonical
// name). Rows without a curated entry keep ranges_by_age null (adult fields only).
// A name in AGE_BANDS with no matching row is reported so a rename can't silently
// drop bands. Deterministic and API-free — this is what --age-bands-only runs.
function applyAgeBands(map: Map<string, Biomarker>): void {
  const byName = new Map(
    [...map.values()].map((b) => [b.name.toLowerCase(), b])
  );
  for (const [name, bands] of Object.entries(AGE_BANDS)) {
    const row = byName.get(name.toLowerCase());
    if (!row) {
      console.warn(`  age bands: no biomarker named "${name}" — skipped`);
      continue;
    }
    row.ranges_by_age = bands;
  }
}

// Biomarker concentrations can't be negative, so clamp any negative bound the
// model emits up to 0. And an optimal_high of 0 on a "lower_better" toxin
// ("ideally undetectable") is unattainable — background exposure means almost
// no one reads exactly 0 — and renders as a nonsensical "optimal ≤ 0". Drop the
// optimal band in that case; a realistic low threshold is left to human review
// of the committed JSON.
function normalizeBounds(b: Biomarker): Biomarker {
  const clamp0 = (n: number | null) => (n != null && n < 0 ? 0 : n);
  const out: Biomarker = {
    ...b,
    ref_low: clamp0(b.ref_low),
    ref_high: clamp0(b.ref_high),
    optimal_low: clamp0(b.optimal_low),
    optimal_high: clamp0(b.optimal_high),
  };
  if (out.direction === "lower_better" && out.optimal_high === 0) {
    out.optimal_low = null;
    out.optimal_high = null;
  }
  return out;
}

// Categories to generate, with the kind of biomarkers each should cover.
const BATCHES: { category: string; prompt: string }[] = [
  {
    category: "lipids",
    prompt:
      "Common lipid-panel and cardiovascular-risk blood biomarkers (total/LDL/HDL/VLDL/non-HDL cholesterol, triglycerides, ApoB, Lp(a), ratios).",
  },
  {
    category: "metabolic",
    prompt:
      "Glucose-metabolism and inflammation biomarkers (fasting glucose, HbA1c, fasting insulin, HOMA-IR, C-peptide, hs-CRP, homocysteine, uric acid).",
  },
  {
    category: "organ",
    prompt:
      "Liver, kidney, electrolyte and metabolic-panel biomarkers (ALT, AST, ALP, bilirubin, albumin, GGT, BUN, creatinine, eGFR, cystatin C, sodium, potassium, calcium, magnesium).",
  },
  {
    category: "cbc",
    prompt:
      "Complete-blood-count biomarkers (hemoglobin, hematocrit, WBC, RBC, platelets, MCV, RDW, neutrophils, lymphocytes) and iron studies (ferritin, iron, TIBC, transferrin saturation).",
  },
  {
    category: "hormones",
    prompt:
      "Thyroid, vitamin and hormone biomarkers (TSH, free T4, free T3, vitamin D 25-OH, B12, folate, total/free testosterone, estradiol, DHEA-S, cortisol, IGF-1, PSA).",
  },
  {
    category: "body",
    prompt:
      "Vitals and body-composition/DEXA metrics (systolic/diastolic blood pressure, resting heart rate, VO2 max, body-fat percentage, bone-density T-score, visceral fat, lean-mass index).",
  },
];

const TOOL: Anthropic.Tool = {
  name: "save_biomarkers",
  description: "Save the structured canonical biomarker reference dataset.",
  input_schema: {
    type: "object",
    properties: {
      biomarkers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Canonical Title-Case name, no method/specimen qualifiers",
            },
            category: {
              type: "string",
              enum: ["lab", "vitals", "scan", "genomics", "biomarker"],
            },
            unit: {
              type: ["string", "null"],
              description: "Canonical unit the ranges are expressed in",
            },
            ref_low: { type: ["number", "null"] },
            ref_high: { type: ["number", "null"] },
            optimal_low: { type: ["number", "null"] },
            optimal_high: { type: ["number", "null"] },
            direction: {
              type: "string",
              enum: ["higher_better", "lower_better", "in_range"],
            },
            note: {
              type: ["string", "null"],
              description: "Short caveat, e.g. 'varies by sex/age'",
            },
            conversions: {
              type: ["object", "null"],
              description:
                'Optional map of alternate unit -> factor, where value_in_alt * factor = value in the canonical unit (e.g. for LDL in mg/dL: {"mmol/L": 38.67}). Only include well-established, analyte-specific factors; omit when unsure.',
              additionalProperties: { type: "number" },
            },
          },
          required: ["name", "category", "direction"],
        },
      },
    },
    required: ["biomarkers"],
  },
};

const SYSTEM = `You produce a controlled vocabulary of canonical biomarker names plus their
reference and longevity-optimal ranges, for adults. For each biomarker emit one row:
- name: a clean, consistent Title-Case canonical name with NO method/specimen qualifiers
  (no "direct"/"calculated"/"serum"). E.g. "LDL Cholesterol", "Hemoglobin A1c".
- unit: the single canonical unit the ranges are expressed in (no conversion mixing).
- ref_low/ref_high: a standard lab reference range in that unit. Either bound may be null
  for one-sided ranges (e.g. LDL has only an upper bound).
- optimal_low/optimal_high: the range current longevity/healthspan literature considers
  optimal for adults (often tighter than, or absent from, the lab reference range). Null
  bounds allowed. Leave both null if there is no well-established optimal target.
- direction: "lower_better", "higher_better", or "in_range" (for U-shaped/in-range optima).
- note: a short caveat when relevant (e.g. "varies by sex/age"), else null.
- conversions: when the analyte is commonly reported in another unit, include a map of
  that unit to a factor where value_in_alt * factor = value in the canonical unit (e.g.
  cholesterol mg/dL from mmol/L: {"mmol/L": 38.67}; glucose: {"mmol/L": 18.02}). These are
  analyte-specific (mass↔molar depends on molar mass) — only include well-established
  factors and omit affine conversions (e.g. HbA1c % ↔ mmol/mol) and anything uncertain.
These are INFORMATIONAL, not medical advice. Be accurate and conservative; prefer null over
a guessed number. Call save_biomarkers exactly once.`;

async function genCategory(
  client: Anthropic,
  prompt: string
): Promise<Biomarker[]> {
  const msg = await client.messages
    .stream({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "save_biomarkers" },
      messages: [
        {
          role: "user",
          content: `Generate canonical biomarker entries for: ${prompt}`,
        },
      ],
    })
    .finalMessage();
  const toolUse = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  const arr = (toolUse?.input as any)?.biomarkers;
  return Array.isArray(arr) ? (arr as Biomarker[]) : [];
}

// Load the committed dataset into a name-keyed map (empty when missing/malformed).
function loadExisting(): Map<string, Biomarker> {
  const existing = new Map<string, Biomarker>();
  if (fs.existsSync(OUT)) {
    try {
      const cur = JSON.parse(fs.readFileSync(OUT, "utf8"));
      for (const b of cur.biomarkers ?? [])
        existing.set(b.name.toLowerCase(), b);
    } catch {
      // ignore a malformed existing file
    }
  }
  return existing;
}

// Apply age bands, sort by name, and write the committed JSON.
function writeDataset(map: Map<string, Biomarker>): void {
  applyAgeBands(map);
  const biomarkers = [...map.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const out = {
    $comment:
      "Canonical biomarker reference dataset. Committed and HUMAN-REVIEWABLE. Regenerate with `npm run gen:biomarkers`. INFORMATIONAL, NOT MEDICAL ADVICE.",
    biomarkers,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${biomarkers.length} biomarkers to ${OUT}`);
  console.log("Review the ranges for plausibility before committing.");
}

// Surgically inject the curated age bands into the committed JSON, preserving its
// existing order, $comment, and every other field (the file has been human-curated
// since the last full generation, so a sort/rewrite would churn it destructively).
// Only the matching entries gain/refresh `ranges_by_age`. API-free.
function applyAgeBandsInPlace(): void {
  const cur = JSON.parse(fs.readFileSync(OUT, "utf8")) as {
    biomarkers?: Biomarker[];
  };
  const rows = cur.biomarkers ?? [];
  const byName = new Map(rows.map((b) => [b.name.toLowerCase(), b]));
  let applied = 0;
  for (const [name, bands] of Object.entries(AGE_BANDS)) {
    const row = byName.get(name.toLowerCase());
    if (!row) {
      console.warn(`  age bands: no biomarker named "${name}" — skipped`);
      continue;
    }
    row.ranges_by_age = bands;
    applied++;
  }
  fs.writeFileSync(OUT, JSON.stringify(cur, null, 2) + "\n");
  console.log(`Applied age bands to ${applied} biomarker(s) in ${OUT}`);
}

// Apply curateBiomarkers to the committed JSON in place, preserving its $comment
// and any other top-level fields. API-free.
function applyCurationInPlace(): void {
  const cur = JSON.parse(fs.readFileSync(OUT, "utf8")) as {
    biomarkers?: Biomarker[];
    [k: string]: unknown;
  };
  const before = cur.biomarkers ?? [];
  cur.biomarkers = curateBiomarkers(before);
  fs.writeFileSync(OUT, JSON.stringify(cur, null, 2) + "\n");
  console.log(
    `Curated dataset: ${cur.biomarkers.length} biomarkers (${CURATED_LABS.length} curated entries + age bands applied)`
  );
}

async function main() {
  // API-free refresh of the curated static labs + age bands over the existing JSON.
  if (CURATED_ONLY) {
    console.log("Applying curated lab entries + age bands to the dataset…");
    applyCurationInPlace();
    return;
  }

  // API-free refresh of just the curated age bands over the existing JSON.
  if (AGE_BANDS_ONLY) {
    console.log("Applying curated age bands to the existing dataset…");
    applyAgeBandsInPlace();
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "ANTHROPIC_API_KEY not set. Set it and re-run `npm run gen:biomarkers`\n" +
        "(or use `--age-bands-only` to refresh just the pediatric age bands)."
    );
    process.exit(1);
  }
  const client = new Anthropic({ apiKey });

  // Preserve existing curated entries (keyed by lowercased name) unless --overwrite.
  const existing = OVERWRITE ? new Map<string, Biomarker>() : loadExisting();

  const merged = new Map<string, Biomarker>(existing);
  // Seed the API-free curated lab entries so a full (re)generation — including
  // --overwrite — never drops them. An AI-returned row of the same name overrides.
  for (const lab of CURATED_LABS) {
    if (!merged.has(lab.name.toLowerCase()))
      merged.set(lab.name.toLowerCase(), lab);
  }
  for (const batch of BATCHES) {
    process.stdout.write(`Generating ${batch.category}… `);
    try {
      const rows = await genCategory(client, batch.prompt);
      let added = 0;
      for (const b of rows) {
        if (!b?.name) continue;
        const key = b.name.toLowerCase();
        if (!OVERWRITE && existing.has(key)) continue; // keep curated version
        merged.set(key, normalizeBounds(b));
        added++;
      }
      console.log(`${rows.length} returned, ${added} new/updated`);
    } catch (err) {
      console.log(
        `failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  writeDataset(merged);
}

// Run only when invoked as the CLI entry point — NOT when imported (e.g. by the
// drift unit test, which imports curateBiomarkers/CURATED_LABS from lib). tsx sets
// process.argv[1] to this script's path when run directly.
if (process.argv[1]?.includes("gen-canonical-biomarkers")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

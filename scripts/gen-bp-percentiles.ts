// Pre-generate the baked pediatric blood-pressure percentile dataset
// (lib/bp-percentiles.json) used to interpret a CHILD's blood pressure by AGE, SEX,
// and HEIGHT PERCENTILE — the AAP 2017 normative tables — instead of the fixed
// adult thresholds, which mis-classify children (issue #150).
//
// Mirrors the gen-growth-charts.ts / gen-fitness-norms.ts pattern: the published
// reference values are FIXED CONSTANTS embedded here as the source of truth, the
// committed JSON is GENERATED from them and HUMAN-REVIEWABLE, and it is a FIXED
// POINT of buildBpPercentiles() (guarded by lib/__tests__/bp-percentiles-dataset.test.ts
// so the generator and the committed file can't silently diverge). No API key — the
// values are public normative tables, so generation is fully deterministic:
//
//   npm run gen:bp-percentiles
//
// ── SOURCING (license-clean, published clinical reference data) ─────────────────
// Flynn JT, Kaelber DC, Baker-Smith CM, et al. "Clinical Practice Guideline for
//   Screening and Management of High Blood Pressure in Children and Adolescents."
//   (AAP 2017 Guideline.) Pediatrics. 2017;140(3):e20171904. Tables 3 (boys) and 4
//   (girls) — the 50th / 90th / 95th BP percentiles for systolic and diastolic
//   pressure by age (1–17 y) and height percentile (5th, 10th, 25th, 50th, 75th,
//   90th, 95th). Diastolic uses Korotkoff phase 5 (K5). These are the normative
//   reference values a percentile computation reads; the numbers themselves are
//   factual reference data, not a copyrightable expression.
//
// The Stage-2 threshold (95th percentile + 12 mmHg) and the AAP category cutoffs
// (Normal / Elevated / Stage 1 / Stage 2), plus the static adult-style thresholds
// applied at age ≥ 13, live in the pure lib (lib/bp-percentiles.ts) — this file
// only bakes the normative percentile grid.
//
// Height percentile itself is derived from the WHO/CDC growth charts the app already
// tracks (lib/growth.ts). CAVEAT DISCIPLINE (same as the other baked datasets):
// INFORMATIONAL population reference standards, NOT a measurement or medical advice;
// interpret against a clinician. NO PHI — pure published aggregate norms.

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "lib", "bp-percentiles.json");

// Height-percentile columns and BP-percentile rows the AAP tables are indexed by.
export const HEIGHT_PERCENTILES = [5, 10, 25, 50, 75, 90, 95] as const;
export const BP_PERCENTILES = [50, 90, 95] as const;
export const MIN_BP_AGE = 1;
export const MAX_BP_AGE = 17;

// One normative row: at `age` (whole years) and `pct` (a BP percentile 50/90/95),
// the systolic and diastolic mmHg values across the seven height-percentile columns
// (index-aligned to HEIGHT_PERCENTILES).
export interface BpRow {
  age: number;
  pct: number;
  sbp: number[];
  dbp: number[];
}
export interface BpPercentileDataset {
  $comment: string;
  source: string;
  heightPercentiles: number[];
  bpPercentiles: number[];
  minAge: number;
  maxAge: number;
  sexes: { male: BpRow[]; female: BpRow[] };
}

// ── AAP 2017 normative BP tables (Flynn 2017), verbatim ─────────────────────────
// Columns: age  bp%  <7 systolic mmHg by height pct>  <7 diastolic mmHg by height
// pct>. Height percentiles 5/10/25/50/75/90/95; BP percentiles 50/90/95.
const BOYS = `
1 50 85 85 86 86 87 88 88 40 40 40 41 41 42 42
1 90 98 99 99 100 100 101 101 52 52 53 53 54 54 54
1 95 102 102 103 103 104 105 105 54 54 55 55 56 57 57
2 50 87 87 88 89 89 90 91 43 43 44 44 45 46 46
2 90 100 100 101 102 103 103 104 55 55 56 56 57 58 58
2 95 104 105 105 106 107 107 108 57 58 58 59 60 61 61
3 50 88 89 89 90 91 92 92 45 46 46 47 48 49 49
3 90 101 102 102 103 104 105 105 58 58 59 59 60 61 61
3 95 106 106 107 107 108 109 109 60 61 61 62 63 64 64
4 50 90 90 91 92 93 94 94 48 49 49 50 51 52 52
4 90 102 103 104 105 105 106 107 60 61 62 62 63 64 64
4 95 107 107 108 108 109 110 110 63 64 65 66 67 67 68
5 50 91 92 93 94 95 96 96 51 51 52 53 54 55 55
5 90 103 104 105 106 107 108 108 63 64 65 65 66 67 67
5 95 107 108 109 109 110 111 112 66 67 68 69 70 70 71
6 50 93 93 94 95 96 97 98 54 54 55 56 57 57 58
6 90 105 105 106 107 109 110 110 66 66 67 68 68 69 69
6 95 108 109 110 111 112 113 114 69 70 70 71 72 72 73
7 50 94 94 95 97 98 98 99 56 56 57 58 58 59 59
7 90 106 107 108 109 110 111 111 68 68 69 70 70 71 71
7 95 110 110 111 112 114 115 116 71 71 72 73 73 74 74
8 50 95 96 97 98 99 99 100 57 57 58 59 59 60 60
8 90 107 108 109 110 111 112 112 69 70 70 71 72 72 73
8 95 111 112 112 114 115 116 117 72 73 73 74 75 75 75
9 50 96 97 98 99 100 101 101 57 58 59 60 61 62 62
9 90 107 108 109 110 112 113 114 70 71 72 73 74 74 74
9 95 112 112 113 115 116 118 119 74 74 75 76 76 77 77
10 50 97 98 99 100 101 102 103 59 60 61 62 63 63 64
10 90 108 109 111 112 113 115 116 72 73 74 74 75 75 76
10 95 112 113 114 116 118 120 121 76 76 77 77 78 78 78
11 50 99 99 101 102 103 104 106 61 61 62 63 63 63 63
11 90 110 111 112 114 116 117 118 74 74 75 75 75 76 76
11 95 114 114 116 118 120 123 124 77 78 78 78 78 78 78
12 50 101 101 102 104 106 108 109 61 62 62 62 62 63 63
12 90 113 114 115 117 119 121 122 75 75 75 75 75 76 76
12 95 116 117 118 121 124 126 128 78 78 78 78 78 79 79
13 50 103 104 105 108 110 111 112 61 60 61 62 63 64 65
13 90 115 116 118 121 124 126 126 74 74 74 75 76 77 77
13 95 119 120 122 125 128 130 131 78 78 78 78 80 81 81
14 50 105 106 109 111 112 113 113 60 60 62 64 65 66 67
14 90 119 120 123 126 127 128 129 74 74 75 77 78 79 80
14 95 123 125 127 130 132 133 134 77 78 79 81 82 83 84
15 50 108 110 112 113 114 114 114 61 62 64 65 66 67 68
15 90 123 124 126 128 129 130 130 75 76 78 79 80 81 81
15 95 127 129 131 132 134 135 135 78 79 81 83 84 85 85
16 50 111 112 114 115 115 116 116 63 64 66 67 68 69 69
16 90 126 127 128 129 131 131 132 77 78 79 80 81 82 82
16 95 130 131 133 134 135 136 137 80 81 83 84 85 86 86
17 50 114 115 116 117 117 118 118 65 66 67 68 69 70 70
17 90 128 129 130 131 132 133 134 78 79 80 81 82 82 83
17 95 132 133 134 135 137 138 138 81 82 84 85 86 86 87
`;

const GIRLS = `
1 50 84 85 86 86 87 88 88 41 42 42 43 44 45 46
1 90 98 99 99 100 101 102 102 54 55 56 56 57 58 58
1 95 101 102 102 103 104 105 105 59 59 60 60 61 62 62
2 50 87 87 88 89 90 91 91 45 46 47 48 49 50 51
2 90 101 101 102 103 104 105 106 58 58 59 60 61 62 62
2 95 104 105 106 106 107 108 109 62 63 63 64 65 66 66
3 50 88 89 89 90 91 92 93 48 48 49 50 51 53 53
3 90 102 103 104 104 105 106 107 60 61 61 62 63 64 65
3 95 106 106 107 108 109 110 110 64 65 65 66 67 68 69
4 50 89 90 91 92 93 94 94 50 51 51 53 54 55 55
4 90 103 104 105 106 107 108 108 62 63 64 65 66 67 67
4 95 107 108 109 109 110 111 112 66 67 68 69 70 70 71
5 50 90 91 92 93 94 95 96 52 52 53 55 56 57 57
5 90 104 105 106 107 108 109 110 64 65 66 67 68 69 70
5 95 108 109 109 110 111 112 113 68 69 70 71 72 73 73
6 50 92 92 93 94 96 97 97 54 54 55 56 57 58 59
6 90 105 106 107 108 109 110 111 67 67 68 69 70 71 71
6 95 109 109 110 111 112 113 114 70 71 72 72 73 74 74
7 50 92 93 94 95 97 98 99 55 55 56 57 58 59 60
7 90 106 106 107 109 110 111 112 68 68 69 70 71 72 72
7 95 109 110 111 112 113 114 115 72 72 73 73 74 74 75
8 50 93 94 95 97 98 99 100 56 56 57 59 60 61 61
8 90 107 107 108 110 111 112 113 69 70 71 72 72 73 73
8 95 110 111 112 113 115 116 117 72 73 74 74 75 75 75
9 50 95 95 97 98 99 100 101 57 58 59 60 60 61 61
9 90 108 108 109 111 112 113 114 71 71 72 73 73 73 73
9 95 112 112 113 114 116 117 118 74 74 75 75 75 75 75
10 50 96 97 98 99 101 102 103 58 59 59 60 61 61 62
10 90 109 110 111 112 113 115 116 72 73 73 73 73 73 73
10 95 113 114 114 116 117 119 120 75 75 76 76 76 76 76
11 50 98 99 101 102 104 105 106 60 60 60 61 62 63 64
11 90 111 112 113 114 116 118 120 74 74 74 74 74 75 75
11 95 115 116 117 118 120 123 124 76 77 77 77 77 77 77
12 50 102 102 104 105 107 108 108 61 61 61 62 64 65 65
12 90 114 115 116 118 120 122 122 75 75 75 75 76 76 76
12 95 118 119 120 122 124 125 126 78 78 78 78 79 79 79
13 50 104 105 106 107 108 108 109 62 62 63 64 65 65 66
13 90 116 117 119 121 122 123 123 75 75 75 76 76 76 76
13 95 121 122 123 124 126 126 127 79 79 79 79 80 80 81
14 50 105 106 107 108 109 109 109 63 63 64 65 66 66 66
14 90 118 118 120 122 123 123 123 76 76 76 76 77 77 77
14 95 123 123 124 125 126 127 127 80 80 80 80 81 81 82
15 50 105 106 107 108 109 109 109 64 64 64 65 66 67 67
15 90 118 119 121 122 123 123 124 76 76 76 77 77 78 78
15 95 124 124 125 126 127 127 128 80 80 80 81 82 82 82
16 50 106 107 108 109 109 110 110 64 64 65 66 66 67 67
16 90 119 120 122 123 124 124 124 76 76 76 77 78 78 78
16 95 124 125 125 127 127 128 128 80 80 80 81 82 82 82
17 50 107 108 109 110 110 110 111 64 64 65 66 66 66 67
17 90 120 121 123 124 124 125 125 76 76 77 77 78 78 78
17 95 125 125 126 127 128 128 128 80 80 80 81 82 82 82
`;

// Parse a verbatim table block into normative rows. Each non-blank line is
// `age pct s5..s95 d5..d95` (16 integers). Throws on a malformed line so a
// transcription slip fails generation loudly rather than baking bad data.
export function parseBpTable(block: string): BpRow[] {
  const rows: BpRow[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const n = line.split(/\s+/).map(Number);
    if (n.length !== 16 || n.some((x) => !Number.isFinite(x))) {
      throw new Error(`Malformed BP table row: "${line}"`);
    }
    rows.push({
      age: n[0],
      pct: n[1],
      sbp: n.slice(2, 9),
      dbp: n.slice(9, 16),
    });
  }
  return rows;
}

// Pure builder: assemble the dataset from the embedded tables. The committed
// lib/bp-percentiles.json is a FIXED POINT of this (guarded by the dataset test).
export function buildBpPercentiles(): BpPercentileDataset {
  return {
    $comment:
      "Baked pediatric blood-pressure percentile dataset (issue #150): the AAP 2017 " +
      "(Flynn et al., Pediatrics 2017) normative 50th/90th/95th systolic & diastolic " +
      "BP by age (1-17 y), sex, and height percentile. Used to classify a child's BP " +
      "(Normal / Elevated / Stage 1 / Stage 2) by percentile instead of adult " +
      "thresholds; see lib/bp-percentiles.ts. Committed + HUMAN-REVIEWABLE; regenerate " +
      "with `npm run gen:bp-percentiles`. INFORMATIONAL reference data, NOT medical advice.",
    source:
      "AAP 2017 Clinical Practice Guideline (Flynn et al., Pediatrics 2017;140:e20171904), Tables 3 & 4.",
    heightPercentiles: [...HEIGHT_PERCENTILES],
    bpPercentiles: [...BP_PERCENTILES],
    minAge: MIN_BP_AGE,
    maxAge: MAX_BP_AGE,
    sexes: {
      male: parseBpTable(BOYS),
      female: parseBpTable(GIRLS),
    },
  };
}

function writeDataset(): void {
  const dataset = buildBpPercentiles();
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");
  const n = dataset.sexes.male.length + dataset.sexes.female.length;
  console.log(`Wrote ${n} pediatric BP normative rows to ${OUT}`);
  console.log(
    "Review the values against AAP 2017 Tables 3 & 4 before committing."
  );
}

// Run only as the CLI entry point — NOT when imported (the dataset drift test
// imports buildBpPercentiles).
if (process.argv[1]?.includes("gen-bp-percentiles")) {
  writeDataset();
}

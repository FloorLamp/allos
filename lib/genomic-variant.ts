// Pure normalization + display helpers for structured genomic variants (#709).
//
// The ONE place raw genomic strings (from the AI report extractor OR a manual
// form) are coerced onto the DB's CHECK vocabularies, plus the display labels the
// UI reads. No DB/network imports, so both the Server Actions and the import
// persist path share the same coercion (the "one question, one computation" rule)
// and it unit-tests without a handle.
//
// Sensitivity: nothing here interprets a variant's meaning or emits risk language —
// it only maps a stated classification onto our enum and formats what the report
// already said. Predictive variants are stored factually; there is no risk
// editorializing anywhere in this module (see #711 for the product decision).

import type {
  GenomicResultType,
  GenomicSignificance,
  Zygosity,
} from "./types/medical";
import { PGX_GUIDANCE, PGX_ALLELES } from "./datasets/pgx";

export const GENOMIC_RESULT_TYPES: readonly GenomicResultType[] = [
  "pharmacogenomic",
  "hereditary-risk",
  "carrier",
  "diagnostic",
  "other",
];

export const GENOMIC_SIGNIFICANCES: readonly GenomicSignificance[] = [
  "pathogenic",
  "likely-pathogenic",
  "uncertain-significance",
  "likely-benign",
  "benign",
];

export const ZYGOSITIES: readonly Zygosity[] = [
  "heterozygous",
  "homozygous",
  "hemizygous",
];

// ---- The pharmacogenomic GENE vocabulary (issue #1676) ----------------------
//
// The gene symbols the PGx cross-check (lib/pgx.ts, #710) can actually act on,
// drawn from the curated CPIC dataset itself rather than re-typed here. The check
// matches `genomic_variants.gene` against its guidance rows by an exact
// case-insensitive symbol compare, so a drifted spelling ("Cyp 2C19", "cyp2c19 ")
// silently produced a variant row no guidance could ever reach. The form's picker
// offers these, and `canonicalGeneSymbol` folds a near-miss back onto the symbol on
// write.
//
// This is the PGx subset, NOT the set of genes worth recording: BRCA1 and friends
// belong in a hereditary-risk row and stay enterable as free text. The picker only
// promises "these ten are the ones the cross-check reads".
export const PGX_GENE_SYMBOLS: readonly string[] = [
  ...new Set([
    ...PGX_GUIDANCE.map((g) => g.gene),
    ...PGX_ALLELES.map((a) => a.gene),
  ]),
].sort((a, b) => a.localeCompare(b));

// Fold a symbol for comparison: case and every non-alphanumeric run drop out, so
// "hla-b", "HLA B" and "HLA_B" are one symbol.
function foldGeneSymbol(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const GENE_BY_FOLD = new Map<string, string>(
  PGX_GENE_SYMBOLS.map((g) => [foldGeneSymbol(g), g])
);

// The canonical PGx symbol for a typed gene, or null when it isn't one of them.
// null is not a rejection — a hereditary-risk variant's gene is stored as typed.
export function canonicalGeneSymbol(input: string): string | null {
  return GENE_BY_FOLD.get(foldGeneSymbol(input)) ?? null;
}

// The write-path helper: the canonical symbol when the PGx vocabulary recognizes the
// input, else the user's own trimmed text.
export function normalizeGeneSymbol(input: string): string {
  const raw = input.trim();
  return canonicalGeneSymbol(raw) ?? raw;
}

// Normalize a stated result-type onto the enum. Unknown / absent → 'other' (the
// safe default: an unclassified variant is stored but routes to neither the PGx
// nor the cadence consumer). Accepts the report's looser phrasings.
export function normalizeResultType(raw: unknown): GenomicResultType {
  if (typeof raw !== "string") return "other";
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (
    s.includes("pharmacogenom") ||
    s.includes("pgx") ||
    s.includes("drug-gene") ||
    s.includes("drug-response") ||
    s.includes("metaboli")
  )
    return "pharmacogenomic";
  if (
    s.includes("hereditary") ||
    s.includes("hereditary-risk") ||
    s.includes("predispos") ||
    s.includes("cancer-risk") ||
    s.includes("germline-risk")
  )
    return "hereditary-risk";
  if (s.includes("carrier")) return "carrier";
  if (s.includes("diagnos")) return "diagnostic";
  return (GENOMIC_RESULT_TYPES as readonly string[]).includes(s)
    ? (s as GenomicResultType)
    : "other";
}

// Normalize a stated ACMG significance onto the enum, or null when the report gives
// none. VUS / "variant of uncertain significance" → 'uncertain-significance'.
export function normalizeSignificance(
  raw: unknown
): GenomicSignificance | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const norm = s.replace(/[\s_]+/g, "-");
  if (norm === "vus" || s.includes("uncertain"))
    return "uncertain-significance";
  if (norm.includes("likely-pathogenic")) return "likely-pathogenic";
  if (norm.includes("likely-benign")) return "likely-benign";
  // Order matters: check the "likely-" compounds above before the bare terms.
  if (s.includes("pathogenic")) return "pathogenic";
  if (s.includes("benign")) return "benign";
  return null;
}

// Normalize a stated zygosity onto the enum, or null. Accepts common short forms.
export function normalizeZygosity(raw: unknown): Zygosity | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("het")) return "heterozygous";
  if (s.startsWith("hom")) return "homozygous";
  if (s.startsWith("hemi")) return "hemizygous";
  return null;
}

// Human labels for the UI (pickers + list badges). Kept here so the page, the
// import listing, and the passport can't disagree about how a term reads.
export function resultTypeLabel(t: GenomicResultType): string {
  switch (t) {
    case "pharmacogenomic":
      return "Pharmacogenomic";
    case "hereditary-risk":
      return "Hereditary risk";
    case "carrier":
      return "Carrier";
    case "diagnostic":
      return "Diagnostic";
    case "other":
      return "Other";
  }
}

export function significanceLabel(s: GenomicSignificance): string {
  switch (s) {
    case "pathogenic":
      return "Pathogenic";
    case "likely-pathogenic":
      return "Likely pathogenic";
    case "uncertain-significance":
      return "Uncertain significance (VUS)";
    case "likely-benign":
      return "Likely benign";
    case "benign":
      return "Benign";
  }
}

// The one-line identity a row shows in a list / tab / passport: the gene, then the
// most specific call available (star-allele → genotype → zygosity), then the
// variant id. Purely factual — no interpretation.
export function variantDisplayLabel(v: {
  gene: string;
  variant: string | null;
  genotype: string | null;
  star_allele: string | null;
  zygosity: Zygosity | null;
}): string {
  const call =
    v.star_allele?.trim() ||
    v.genotype?.trim() ||
    (v.zygosity ? v.zygosity : null);
  const head = call ? `${v.gene} ${call}` : v.gene;
  const id = v.variant?.trim();
  return id ? `${head} (${id})` : head;
}

// The summary row of the genomic-variant form (#5302, over #3218's primitive and
// #5300's grammar) — slice 4's third form, and the last of the twelve.
//
// A GENOMIC VARIANT IS A GENE, A CALL, AND WHAT THE REPORT ROUTES IT AS. The form asked
// eleven labelled questions — gene, variant id, genotype, star allele, zygosity, result
// type, clinical significance, report date, source lab, interpretation, notes. The GENE
// stays above the chips as rule 1's one identifying field: it is the coded pick over
// `PGX_GENE_SYMBOLS`, the form's own required value, and the column the PGx cross-check
// matches on an exact case-insensitive compare (#1676).
//
// WHY `result_type` IS ESSENTIAL, and it is the one most likely to be mistaken for
// bookkeeping. It is the ROUTER. Nothing downstream reads a variant that is not routed:
//
//   • `getPgxWarnings` filters `(v) => v.result_type === "pharmacogenomic"`
//     (lib/queries/intake/warnings.ts:244), and so does the intake form's own context
//     (lib/intake-form-context.ts:53), so a CYP2C19 row filed as anything else never
//     reaches `crossCheckPgx` and never warns about a drug the person is taking.
//   • `drivesHereditaryCadence` gates on `v.result_type === "hereditary-risk"`
//     (lib/risk-stratification.ts:384), so a pathogenic BRCA1 filed as anything else
//     never modulates a screening cadence.
//
// And the default is the one that reaches neither: the select is born `"other"` and
// `normalizeResultType` says so in its own words — "an unclassified variant is stored
// but routes to neither the PGx nor the cadence consumer" (lib/genomic-variant.ts:86-88).
// The select can never be blank, so this fact is ALWAYS STATED and the trailing
// affordance can never hold it — the allergy and injury forms' reading of a born-with-a-
// value select. Calling it optional would say the more-line might hold it, which is
// false.
//
// AND WHY `call` IS ESSENTIAL — the star allele, the genotype and the zygosity, ONE
// fact over ONE editor. CPIC keys on PHENOTYPE, and `resolvePhenotype` has exactly two
// ways to get one: the phenotype the report STATES in words, or the one DERIVED from the
// diplotype. `derivedPhenotype` reads `star_allele` first and falls back to a
// diplotype-shaped `genotype` (lib/pgx.ts:175-201) and "declines unless BOTH alleles are
// known, so it never guesses from an unmapped allele". With neither, `resolvePhenotype`
// returns null and `crossCheckPgx` skips every phenotype-keyed guidance row on
// `if (phenotype !== g.phenotype) continue` (lib/pgx.ts:269) — so a CYP2C19 row carrying
// a gene and nothing else produces no hit for any drug, however severe the guidance. The
// three columns are ONE chip because `variantCallLabel` is the single precedence
// (star-allele → genotype → zygosity) every surface reads them back through, the
// region-and-side rule at this address.
//
// AND WHY `significance` IS **OPTIONAL**, which is the classification most likely to be
// got wrong here — it reads like the headline clinical fact and it is the one this form
// must not dash. `drivesHereditaryCadence` tests `result_type === "hereditary-risk"`
// FIRST and only then the ACMG class, so on the other four result types — including this
// form's own default — the significance reaches no consumer at all. And a
// pharmacogenomic report does not classify pathogenicity: a `*2/*2` poor-metabolizer
// call has no ACMG significance to state, so a dashed prompt on every PGx row would
// press for a fact the report does not make. That is #715's scope-law failure in another
// domain, and the reason the essentials here are the ROUTER and the CALL rather than the
// word that sounds most clinical.
//
// AND `interpretation` IS OPTIONAL despite being `statedPhenotype`'s primary text
// source. It is one of three that function reads (interpretation, notes, genotype,
// lib/pgx.ts:148), the genotype half of which the `call` chip already carries, and it
// is the report's own paragraph — a chip states a fact, so this one is a marker (the
// skin row's reading of its finding field).
//
// AND `report_date` IS OPTIONAL, the asymmetry with the other three forms in this slice
// and argued rather than assumed. An undated immunization is dropped by both its
// consumers and an undated study by both of its; an undated VARIANT is dropped by none.
// A genotype does not change, so nothing here is a timeline: the column is read only by
// `ORDER BY COALESCE(report_date, '') DESC` in the list queries
// (lib/queries/clinical.ts:260) and by the search projection's day text. An undated
// variant sorts last and cross-checks exactly as well as a dated one.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over
// `genomicVariantFactSummary`.

import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import {
  resultTypeLabel,
  significanceLabel,
  variantCallLabel,
} from "./genomic-variant";
import { recordFactRow, type RecordFactSummary } from "./record-facts";
import type {
  GenomicResultType,
  GenomicSignificance,
  Zygosity,
} from "./types/medical";

// The facts, in the order the row draws them. The two essentials lead.
export type GenomicVariantFactKey =
  | "result_type"
  | "call"
  | "variant"
  | "significance"
  | "report_date"
  | "source_lab"
  | "interpretation"
  | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const GENOMIC_VARIANT_FACT_NOUNS: Record<GenomicVariantFactKey, string> =
  {
    result_type: "result type",
    call: "genotype and zygosity",
    variant: "variant id",
    significance: "clinical significance",
    report_date: "report date",
    source_lab: "source lab",
    interpretation: "interpretation",
    notes: "notes",
  };

export interface GenomicVariantFactInput {
  /** The result-type select. Born "other" and normalized on the server, so never blank. */
  resultType: string;
  /** The three call columns exactly as the form holds them; read back as one line. */
  genotype: string;
  starAllele: string;
  zygosity: string;
  variant: string;
  significance: string;
  reportDate: string;
  sourceLab: string;
  interpretation: string;
  notes: string;
  prefs?: DisplayFormatPrefs;
}

function isZygosity(v: string): v is Zygosity {
  return v === "heterozygous" || v === "homozygous" || v === "hemizygous";
}

function isSignificance(v: string): v is GenomicSignificance {
  return (
    v === "pathogenic" ||
    v === "likely-pathogenic" ||
    v === "uncertain-significance" ||
    v === "likely-benign" ||
    v === "benign"
  );
}

function isResultType(v: string): v is GenomicResultType {
  return (
    v === "pharmacogenomic" ||
    v === "hereditary-risk" ||
    v === "carrier" ||
    v === "diagnostic" ||
    v === "other"
  );
}

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 */
export function genomicVariantFactSummary(
  f: GenomicVariantFactInput
): RecordFactSummary<GenomicVariantFactKey> {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const row = recordFactRow<GenomicVariantFactKey>();

  // Born "other", so this one is stated on every open. `normalizeResultType` degrades
  // anything unrecognized onto the enum, matching the select's own option list.
  const type = f.resultType.trim();
  row.stated(
    "result_type",
    resultTypeLabel(isResultType(type) ? type : "other")
  );

  // Through `variantCallLabel`, the one precedence the list, the passport and the PGx
  // check all read these three columns back with.
  const zygosity = f.zygosity.trim();
  const call = variantCallLabel({
    genotype: f.genotype || null,
    star_allele: f.starAllele || null,
    zygosity: isZygosity(zygosity) ? zygosity : null,
  });
  if (call) row.stated("call", call);
  else row.missing("call", "Add the genotype or star allele");

  row.state("variant", f.variant, f.variant.trim());
  const significance = f.significance.trim();
  const graded = isSignificance(significance)
    ? significanceLabel(significance)
    : "";
  row.state("significance", graded, graded);
  const reported = f.reportDate.trim();
  row.state(
    "report_date",
    reported,
    reported ? `Reported ${formatMonthDay(reported, prefs)}` : ""
  );
  row.state("source_lab", f.sourceLab, f.sourceLab.trim());
  // The interpretation MARKER, not the interpretation.
  row.state("interpretation", f.interpretation, "Interpretation noted");
  // The notes MARKER, not the notes.
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}

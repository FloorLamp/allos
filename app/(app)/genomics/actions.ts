"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  normalizeResultType,
  normalizeSignificance,
  normalizeZygosity,
} from "@/lib/genomic-variant";

// Genomic-variant writes (#709). Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions/procedures), so the
// per-document import delete-set never touches them; editing an imported row leaves
// its provenance columns intact. The result_type / significance / zygosity strings
// are normalized onto the DB CHECK sets through the ONE shared coercion in
// lib/genomic-variant (the same one the import path uses), so a form value that
// isn't a valid enum can never trip the CHECK — it degrades to the safe default.
//
// Sensitivity (#709): a variant/gene name is written to the local DB only — it
// never leaves the box. Predictive variants are stored factually; nothing here
// derives or stores a risk interpretation.

function revalidateGenomics() {
  revalidatePath("/results");
  revalidatePath("/profile");
  revalidatePath("/");
}

const str = (formData: FormData, key: string): string | null =>
  String(formData.get(key) ?? "").trim() || null;

function dateOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return isRealIsoDate(v) ? v : null;
}

export async function addGenomicVariant(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const gene = String(formData.get("gene") ?? "").trim();
  if (!gene) return formError("Enter the gene symbol.");
  // A manual row carries a NULL document_id / external_id (omitted here so they
  // default NULL) so the per-document import delete-set never touches it — the same
  // shape as a manual procedure/condition.
  db.prepare(
    `INSERT INTO genomic_variants
       (gene, variant, genotype, star_allele, zygosity, significance,
        result_type, interpretation, source_lab, report_date, notes,
        source, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)`
  ).run(
    gene,
    str(formData, "variant"),
    str(formData, "genotype"),
    str(formData, "star_allele"),
    normalizeZygosity(formData.get("zygosity")),
    normalizeSignificance(formData.get("significance")),
    normalizeResultType(formData.get("result_type")),
    str(formData, "interpretation"),
    str(formData, "source_lab"),
    dateOrNull(formData.get("report_date")),
    str(formData, "notes"),
    profile.id
  );
  revalidateGenomics();
  return formOk();
}

export async function updateGenomicVariant(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const gene = String(formData.get("gene") ?? "").trim();
  if (!id) return formError("Couldn't find that variant.");
  if (!gene) return formError("Enter the gene symbol.");
  db.prepare(
    `UPDATE genomic_variants
       SET gene = ?, variant = ?, genotype = ?, star_allele = ?, zygosity = ?,
           significance = ?, result_type = ?, interpretation = ?, source_lab = ?,
           report_date = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    gene,
    str(formData, "variant"),
    str(formData, "genotype"),
    str(formData, "star_allele"),
    normalizeZygosity(formData.get("zygosity")),
    normalizeSignificance(formData.get("significance")),
    normalizeResultType(formData.get("result_type")),
    str(formData, "interpretation"),
    str(formData, "source_lab"),
    dateOrNull(formData.get("report_date")),
    str(formData, "notes"),
    id,
    profile.id
  );
  revalidateGenomics();
  return formOk();
}

export async function deleteGenomicVariant(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that variant.");
  db.prepare(
    "DELETE FROM genomic_variants WHERE id = ? AND profile_id = ?"
  ).run(id, profile.id);
  revalidateGenomics();
  return formOk();
}

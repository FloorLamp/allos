"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { addCoverageGap, removeCoverageGap } from "@/lib/queries";
import { COVERAGE_GAP_KINDS, type CoverageGapKind } from "@/lib/coverage-gaps";
import { enrichCoverageGap, type EnrichOutcome } from "@/lib/coverage-enrich";

// The coverage-gap registry write paths (issue #550). requireWriteAccess() is the
// ONLY auth gate — the lib cores (lib/coverage-gaps, lib/queries/coverage,
// lib/coverage-enrich) are auth-blind and profileId-scoped.

function parseKind(raw: unknown): CoverageGapKind | null {
  const k = String(raw ?? "");
  return (COVERAGE_GAP_KINDS as readonly string[]).includes(k)
    ? (k as CoverageGapKind)
    : null;
}

// Opt in to track a derivable gap so it can be filled + watched for coverage.
export async function trackCoverageGap(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const kind = parseKind(formData.get("kind"));
  const itemKey = String(formData.get("item_key") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  if (!kind || !itemKey || !label) return;
  addCoverageGap(profile.id, kind, itemKey, label);
  revalidatePath("/records");
}

// Stop tracking a gap.
export async function untrackCoverageGap(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0) return;
  removeCoverageGap(profile.id, id);
  revalidatePath("/records");
}

// Fill a gap with private/local AI descriptive context (fill path 1). Returns the
// typed outcome so the client can show a graceful message when AI isn't configured
// or the daily cap is hit; on success the stored blurb is picked up on revalidate.
export async function enrichCoverageGapAction(
  formData: FormData
): Promise<EnrichOutcome> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0) return { status: "not-found" };
  const outcome = await enrichCoverageGap(profile.id, id);
  revalidatePath("/records");
  return outcome;
}

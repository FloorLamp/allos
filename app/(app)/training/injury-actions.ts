"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  logInjuryCore,
  updateInjuryCore,
  setInjuryStatusCore,
  deleteInjuryCore,
} from "@/lib/injuries";
import {
  isValidRegion,
  isValidMuscleId,
  isDateStr,
  INJURY_STATUSES,
  type InjuryStatus,
} from "@/lib/injury-model";
import {
  getActiveSituations,
  setActiveSituations,
} from "@/lib/settings/profile-attrs";
import { BUILTIN_INJURY_SITUATION } from "@/lib/situations";
import { formError, formOk, type FormResult } from "@/lib/types";
import type { MuscleId, MuscleRegion } from "@/lib/lifts";

// Server write-path for the injury layer (issue #838). The Training-overview injury bar
// posts here; each action owns the auth gate (requireWriteAccess — the write-access scanner
// sees a literal call in every action) + validation + revalidation, and delegates the SQL
// to the auth-blind profileId-first cores in lib/injuries.ts. Injuries surface on the
// Training overview + the Timeline, so both are revalidated.

function revalidateInjuries(): void {
  revalidatePath("/training");
  revalidatePath("/timeline");
  // The recommendation exclusion/tempering rides the dashboard coaching widget too.
  revalidatePath("/");
}

// Parse the multi-valued `regions[]` / `muscles[]` form fields into valid vocabulary.
function parseRegionList(formData: FormData): MuscleRegion[] {
  return [...new Set(formData.getAll("regions").map(String))].filter(
    isValidRegion
  );
}
function parseMuscleList(formData: FormData): MuscleId[] {
  return [...new Set(formData.getAll("muscles").map(String))].filter(
    isValidMuscleId
  );
}

function parseStatus(formData: FormData): InjuryStatus | undefined {
  const raw = String(formData.get("status") ?? "").trim();
  return INJURY_STATUSES.includes(raw as InjuryStatus)
    ? (raw as InjuryStatus)
    : undefined;
}

function parseSince(formData: FormData): string | null {
  const raw = String(formData.get("since") ?? "").trim();
  return isDateStr(raw) ? raw : null;
}

// Log a new injury (the one-tap quick-log form). Regions (coarse) and/or muscles (fine)
// name what's off the table; the engine excludes/tempers by them.
export async function logInjury(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const label = String(formData.get("label") ?? "").trim();
  const out = logInjuryCore(profile.id, {
    label,
    regions: parseRegionList(formData),
    muscles: parseMuscleList(formData),
    status: parseStatus(formData) ?? "active",
    since: parseSince(formData) ?? today(profile.id),
    notes: String(formData.get("notes") ?? ""),
  });
  if (out.kind !== "ok")
    return formError("Add a label and at least one affected region.");
  revalidateInjuries();
  return formOk();
}

// Edit an existing injury in place.
export async function updateInjury(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return formError("Invalid injury.");
  const out = updateInjuryCore(profile.id, id, {
    label: String(formData.get("label") ?? "").trim(),
    regions: parseRegionList(formData),
    muscles: parseMuscleList(formData),
    status: parseStatus(formData) ?? "active",
    since: parseSince(formData),
    notes: String(formData.get("notes") ?? ""),
  });
  if (out.kind !== "ok")
    return formError("Add a label and at least one affected region.");
  revalidateInjuries();
  return formOk();
}

// Move an injury through its lifecycle (active → recovering → resolved). Resolving stamps
// the resolved date; the record is kept either way.
export async function setInjuryStatus(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const status = parseStatus(formData);
  if (!Number.isInteger(id) || !status) return formError("Invalid update.");
  const out = setInjuryStatusCore(
    profile.id,
    id,
    status,
    status === "resolved" ? today(profile.id) : null
  );
  if (out.kind !== "ok") return formError("Injury not found.");
  revalidateInjuries();
  return formOk();
}

// Delete an injury outright (a mistaken log). Plain profile-scoped delete — nothing is
// keyed to an injury id.
export async function deleteInjury(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return formError("Invalid injury.");
  if (!deleteInjuryCore(profile.id, id)) return formError("Injury not found.");
  revalidateInjuries();
  return formOk();
}

// The injury→situation bridge (#838, suggest-only #560): activate the built-in "Injury"
// situation on the user's confirmation. Never auto-activated — the bar offers it, this
// action honors the tap.
export async function activateInjurySituation(): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const active = new Set(getActiveSituations(profile.id));
  if (!active.has(BUILTIN_INJURY_SITUATION)) {
    active.add(BUILTIN_INJURY_SITUATION);
    setActiveSituations(profile.id, [...active]);
  }
  revalidatePath("/training");
  revalidatePath("/nutrition");
  revalidatePath("/");
  return formOk();
}

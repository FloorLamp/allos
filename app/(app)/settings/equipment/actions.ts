"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import {
  createEquipment,
  updateEquipment,
  deleteEquipment,
  setEquipmentRetired,
  equipmentNameExists,
} from "@/lib/equipment";
import type { Equipment } from "@/lib/types";

// Weight arrives already converted to kg by the client (it knows the display
// unit). null means the implement's own weight is unknown / not tracked.
export interface EquipmentFormInput {
  name: string;
  weight_kg: number | null;
  category: string | null;
}

function clean(input: EquipmentFormInput): EquipmentFormInput {
  const weight =
    typeof input.weight_kg === "number" && Number.isFinite(input.weight_kg)
      ? input.weight_kg
      : null;
  return {
    name: (input.name ?? "").trim(),
    weight_kg: weight,
    category: input.category?.trim() || null,
  };
}

function refresh() {
  // Equipment affects the importer and the journal's per-set implement labels.
  revalidatePath("/settings/equipment");
  revalidatePath("/data");
  revalidatePath("/training");
}

export async function createEquipmentAction(
  input: EquipmentFormInput
): Promise<{ ok: true; equipment: Equipment } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const c = clean(input);
  if (!c.name) return { ok: false, error: "Give the equipment a name." };
  if (equipmentNameExists(profile.id, c.name))
    return {
      ok: false,
      error: `You already have equipment named "${c.name}".`,
    };
  const equipment = createEquipment(profile.id, c);
  refresh();
  return { ok: true, equipment };
}

export async function updateEquipmentAction(
  id: number,
  input: EquipmentFormInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const c = clean(input);
  if (!c.name) return { ok: false, error: "Give the equipment a name." };
  if (equipmentNameExists(profile.id, c.name, id))
    return {
      ok: false,
      error: `You already have equipment named "${c.name}".`,
    };
  updateEquipment(profile.id, id, c);
  refresh();
  return { ok: true };
}

export async function deleteEquipmentAction(id: number): Promise<{ ok: true }> {
  const { profile } = await requireWriteAccess();
  deleteEquipment(profile.id, id);
  refresh();
  return { ok: true };
}

// Soft-retire / un-retire (issue #341): the reversible alternative to delete that
// keeps the row and its set links, just hiding it from pickers.
export async function setEquipmentRetiredAction(
  id: number,
  retired: boolean
): Promise<{ ok: true }> {
  const { profile } = await requireWriteAccess();
  setEquipmentRetired(profile.id, id, retired);
  refresh();
  return { ok: true };
}

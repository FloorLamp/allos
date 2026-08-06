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
  // Equipment now lives at /equipment (index + detail); it still affects the
  // importer, the journal's per-set implement labels, and protocol gear refs.
  revalidatePath("/equipment");
  revalidatePath("/data");
  revalidatePath("/training");
  revalidatePath("/longevity");
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

// Typed, changes-checked outcomes (#2138): both lifecycle writes below used to
// return `{ ok: true }` literals, so a silently-failed retire kept offering sold
// gear while the UI toasted success. Every refusal is rendered by the caller
// (the shared overflow menu's MenuActionResult plumbing / the detail action row);
// a refusal still revalidates, because it means the page the tap came from was
// stale and should re-render into the state that actually holds.
export async function deleteEquipmentAction(
  id: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const outcome = deleteEquipment(profile.id, id);
  refresh();
  if (outcome.kind === "not-found") {
    return {
      ok: false,
      error: "Couldn't find that equipment — it may already be deleted.",
    };
  }
  return { ok: true };
}

// Soft-retire / un-retire (issue #341): the reversible alternative to delete that
// keeps the row and its set links, just hiding it from pickers. `retired` is the
// state the caller's render promised; the core CASes it and a tap that changed
// nothing is answered with what actually holds (#2138).
export async function setEquipmentRetiredAction(
  id: number,
  retired: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const outcome = setEquipmentRetired(profile.id, id, retired);
  refresh();
  if (outcome.kind === "not-found") {
    return {
      ok: false,
      error: "Couldn't find that equipment — it may have been deleted.",
    };
  }
  if (outcome.kind === "already") {
    return {
      ok: false,
      error: retired
        ? "That equipment is already retired."
        : "That equipment is already active.",
    };
  }
  return { ok: true };
}

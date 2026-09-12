"use server";

// Server Actions for the declared food sensitivities (#5865). The auth gate and the
// revalidation live here; the SQL lives in the auth-blind store
// (lib/food-sensitivity-store.ts) and the vocabulary the writes are checked against is
// pure (lib/food-sensitivities.ts, lib/gi-effects.ts).
//
// EVERY WRITE IS THE PERSON'S OWN. There is no importer, no suggestion accepter and no
// background job on this table, and there must never be one: a sensitivity the app
// proposed would break the very thing that lets a declared pair sit inside the
// paired-observation registry (#2397/#2572).
//
// THE VOCABULARY IS CHECKED HERE, not only in the form. A trigger slug and an effect
// slug both come off closed lists, and a POST straight at one of these actions is
// judged by the same lists the select was built from — otherwise the table collects
// slugs no reader can label and no pair can count.

import { requireWriteAccess } from "@/lib/auth";
import { revalidateRoute } from "@/lib/revalidate";
import { isGiEffect } from "@/lib/gi-effects";
import {
  isTriggerSlug,
  type FoodSensitivity,
  type FoodSensitivityTriggerKind,
} from "@/lib/food-sensitivities";
import {
  createFoodSensitivity,
  deleteFoodSensitivity,
  foodSensitivityExists,
  setFoodSensitivityStatus,
  updateFoodSensitivity,
  type FoodSensitivityInput,
} from "@/lib/food-sensitivity-store";

export interface SensitivityFormInput {
  trigger_kind: FoodSensitivityTriggerKind;
  trigger_slug: string;
  effect: string;
  note: string;
}

type Checked =
  { ok: true; input: FoodSensitivityInput } | { ok: false; error: string };

function check(input: SensitivityFormInput): Checked {
  const slug = input.trigger_slug.trim();
  if (!slug) return { ok: false, error: "Pick what sets it off." };
  if (!isTriggerSlug(input.trigger_kind, slug))
    return { ok: false, error: "That isn’t a trigger this app knows." };
  const effect = input.effect.trim();
  if (!effect) return { ok: false, error: "Pick the effect." };
  if (!isGiEffect(effect))
    return { ok: false, error: "That isn’t an effect this app knows." };
  return {
    ok: true,
    input: {
      trigger_kind: input.trigger_kind,
      trigger_slug: slug,
      effect,
      note: input.note.trim() || null,
    },
  };
}

function refresh() {
  // The declaration is listed on Nutrition → Manage, and (once slices 2 and 3 land)
  // decides whether the food sheet shows a `This meal` chip at all.
  revalidateRoute("/nutrition");
}

export async function createFoodSensitivityAction(
  input: SensitivityFormInput
): Promise<
  { ok: true; sensitivity: FoodSensitivity } | { ok: false; error: string }
> {
  const { profile } = await requireWriteAccess();
  const checked = check(input);
  if (!checked.ok) return checked;
  if (foodSensitivityExists(profile.id, checked.input))
    return { ok: false, error: "You’ve already declared that one." };
  const sensitivity = createFoodSensitivity(profile.id, checked.input);
  refresh();
  return { ok: true, sensitivity };
}

export async function updateFoodSensitivityAction(
  id: number,
  input: SensitivityFormInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const checked = check(input);
  if (!checked.ok) return checked;
  if (foodSensitivityExists(profile.id, checked.input, id))
    return { ok: false, error: "You’ve already declared that one." };
  if (!updateFoodSensitivity(profile.id, id, checked.input))
    return {
      ok: false,
      error: "Couldn’t find that sensitivity — it may already be deleted.",
    };
  refresh();
  return { ok: true };
}

/**
 * Stop or resume counting. The shared catalog lifecycle control posts the state its
 * render promised (`inactive`), so a flip that did not land is a typed refusal rather
 * than a success the row invents (#2138).
 */
export async function setFoodSensitivityStoppedAction(
  id: number,
  stopped: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const landed = setFoodSensitivityStatus(
    profile.id,
    id,
    stopped ? "stopped" : "active"
  );
  refresh();
  if (!landed)
    return {
      ok: false,
      error: stopped
        ? "That sensitivity isn’t being tracked."
        : "That sensitivity is already being tracked.",
    };
  return { ok: true };
}

/**
 * Delete a declaration. MARKS ON PAST MEALS STAY: they are facts about those meals,
 * not about this row, and nothing here reaches `food_log_events`.
 */
export async function deleteFoodSensitivityAction(
  id: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const deleted = deleteFoodSensitivity(profile.id, id);
  refresh();
  if (!deleted)
    return {
      ok: false,
      error: "Couldn’t find that sensitivity — it may already be deleted.",
    };
  return { ok: true };
}

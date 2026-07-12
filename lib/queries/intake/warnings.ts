// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Stack-level safety warnings computed over the active items: NIH Tolerable
// Upper Intake Level (UL) exceedances and known drug/supplement interactions.
import { today } from "../../db";
import { ageFromBirthdate } from "../../date";
import { getUserSex, getUserBirthdate, getStoredAge } from "../../settings";
import { stackUlWarnings, type StackItem, type UlWarning } from "../../dri";
import {
  detectInteractions,
  type InteractionHit,
  type InteractionItem,
} from "../../drug-interactions";
import { parseRxcuiIngredients } from "../../rxnorm";
import { getSupplements, getSupplementDoses } from "./schedule";

// ---- Dietary limits: supplement stack-total UL warnings (issue #148) ----

// The active stack's nutrients whose summed daily supplemental intake exceeds the
// NIH Tolerable Upper Intake Level (UL) for the profile's age/sex. The SINGLE
// gather behind both surfaces — the /medicine warning rows and the dismissible
// Upcoming finding — so they can never disagree on which nutrients are over
// (AGENTS.md "one question, one computation"). Reuses the profile-scoped
// getSupplements + getSupplementDoses reads (no new SQL, so profile scoping is
// already enforced) and resolves age/sex from profile_settings; the UL math is the
// pure lib/dri.stackUlWarnings. `today` selects the age from a birthdate.
export function getDietaryLimitWarnings(
  profileId: number,
  todayStr: string = today(profileId)
): UlWarning[] {
  const supplements = getSupplements(profileId);
  const dosesBySupp = new Map<number, (string | null)[]>();
  for (const d of getSupplementDoses(profileId)) {
    const arr = dosesBySupp.get(d.item_id) ?? [];
    arr.push(d.amount);
    dosesBySupp.set(d.item_id, arr);
  }
  const items: StackItem[] = supplements.map((s) => ({
    name: s.name,
    active: !!s.active,
    doseAmounts: dosesBySupp.get(s.id) ?? [],
  }));

  const birthdate = getUserBirthdate(profileId);
  const ageYears = birthdate
    ? ageFromBirthdate(birthdate, todayStr)
    : getStoredAge(profileId);
  const sex = getUserSex(profileId);

  return stackUlWarnings(items, ageYears, sex);
}

// Known drug-/supplement-interactions among the profile's ACTIVE stack (issue #144).
// Reuses the pure detectInteractions over each item's name + cached RxCUI(s) +
// active flag — the SAME computation the /medicine warnings, the create/edit inline
// notice, and the dismissible Upcoming finding all format over. Cached ingredient
// CUIs (issue #279) let a combination product match each ingredient's concept.
// Profile-scoped (getSupplements filters profile_id); inactive/paused rows are
// dropped by the pure detector.
export function getInteractionWarnings(profileId: number): InteractionHit[] {
  const items: InteractionItem[] = getSupplements(profileId).map((s) => ({
    id: s.id,
    name: s.name,
    rxcui: s.rxcui,
    rxcuiIngredients: parseRxcuiIngredients(s.rxcui_ingredients),
    active: !!s.active,
  }));
  return detectInteractions(items);
}

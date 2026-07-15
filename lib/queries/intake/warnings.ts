// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Stack-level safety warnings computed over the active items: NIH Tolerable
// Upper Intake Level (UL) exceedances and known drug/supplement interactions.
import { today } from "../../db";
import { ageFromBirthdate } from "../../date";
import { getUserSex, getUserBirthdate, getStoredAge } from "../../settings";
import {
  stackUlWarnings,
  stackRdaAdequacy,
  ulConditionCaveat,
  type StackItem,
  type UlWarning,
  type RdaAdequacy,
} from "../../dri";
import { getConditions } from "../clinical";
import {
  detectInteractions,
  type InteractionHit,
  type InteractionItem,
} from "../../drug-interactions";
import { crossCheckPgx, type PgxHit, type PgxMedInput } from "../../pgx";
import {
  crossCheckContrast,
  parsePlannedStudy,
  type ContrastHit,
  type PlannedContrastStudy,
} from "../../contrast-safety";
import {
  getGenomicVariants,
  getCarePlanItems,
  getImagingStudies,
} from "../clinical";
import { getScheduledAppointments } from "../appointments";
import { isCarePlanItemOpen } from "../../care-plan-upcoming";
import { getIntakeSafetyContext } from "./safety";
import { parseRxcuiIngredients } from "../../rxnorm";
import { contributesToDailyLimit } from "../../supplement-schedule";
import { getSupplements, getSupplementDoses } from "./schedule";

// ---- Dietary limits: supplement stack-total UL warnings (issue #148) ----

// A UL warning enriched with an optional condition caveat: when an active condition
// makes the population UL unreliable for the nutrient (CKD × magnesium, #657), the
// caveat is computed here — the ONE place with the conditions in hand — and both
// surfaces (the /medicine row, the Upcoming finding) format it, so they can't disagree.
export type UlWarningWithCaveat = UlWarning & {
  conditionCaveat: string | null;
};

// The active stack's nutrients whose summed daily supplemental intake exceeds the
// NIH Tolerable Upper Intake Level (UL) for the profile's age/sex. The SINGLE
// gather behind both surfaces — the /medicine warning rows and the dismissible
// Upcoming finding — so they can never disagree on which nutrients are over
// (AGENTS.md "one question, one computation"). Reuses the profile-scoped
// getSupplements + getSupplementDoses reads (no new SQL, so profile scoping is
// already enforced) and resolves age/sex from profile_settings; the UL math is the
// pure lib/dri.stackUlWarnings. `today` selects the age from a birthdate. Each warning
// carries the #657 condition caveat when an active condition lowers the nutrient's ceiling.
export function getDietaryLimitWarnings(
  profileId: number,
  todayStr: string = today(profileId)
): UlWarningWithCaveat[] {
  const { items, ageYears, sex } = stackDriContext(profileId, todayStr);
  const conditions = getConditions(profileId, { status: "active" }).map(
    (c) => c.name
  );
  return stackUlWarnings(items, ageYears, sex).map((w) => ({
    ...w,
    conditionCaveat: ulConditionCaveat(w.key, conditions),
  }));
}

// The active stack's nutrients whose supplemental total falls BELOW the RDA for the
// profile's age/sex — the adequacy inverse of getDietaryLimitWarnings (issue #578),
// consuming the previously-unused RDA half of dri.json. Same stack/age/sex assembly,
// pointed at the other reference column, so the two reads can never disagree ("one
// question, one computation"). Wording (in lib/dri) is "supplements provide X% of the
// RDA", never "deficient" — food intake is unknown. Informational; no notification.
export function getDietaryAdequacy(
  profileId: number,
  todayStr: string = today(profileId)
): RdaAdequacy[] {
  const { items, ageYears, sex } = stackDriContext(profileId, todayStr);
  return stackRdaAdequacy(items, ageYears, sex);
}

// The shared DRI input assembly: the active stack as StackItems + the resolved
// age/sex band. Factored out so the UL and RDA reads build their input identically
// (they must, or the two nutrient sets could diverge). Profile-scoped through
// getSupplements/getSupplementDoses; no new SQL.
function stackDriContext(
  profileId: number,
  todayStr: string
): {
  items: StackItem[];
  ageYears: number | null;
  sex: ReturnType<typeof getUserSex>;
} {
  const supplements = getSupplements(profileId);
  const dosesBySupp = new Map<number, (string | null)[]>();
  for (const d of getSupplementDoses(profileId)) {
    const arr = dosesBySupp.get(d.item_id) ?? [];
    arr.push(d.amount);
    dosesBySupp.set(d.item_id, arr);
  }
  // Only items taken EVERY day contribute to the DAILY UL/RDA totals (#635): a PRN
  // item is on-demand and a workout/rest/situational item applies only on some
  // days, so summing either as a full daily dose was a standing false "above upper
  // limit" care-tier alarm. The pure contributesToDailyLimit mirrors isDueOn's PRN
  // short-circuit; the item's active flag is still gated downstream in the DRI math.
  const items: StackItem[] = supplements
    .filter((s) => contributesToDailyLimit(s))
    .map((s) => ({
      name: s.name,
      active: !!s.active,
      doseAmounts: dosesBySupp.get(s.id) ?? [],
    }));

  const birthdate = getUserBirthdate(profileId);
  const ageYears = birthdate
    ? ageFromBirthdate(birthdate, todayStr)
    : getStoredAge(profileId);
  const sex = getUserSex(profileId);
  return { items, ageYears, sex };
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

// Pharmacogenomics cross-check (issue #710): the profile's stored PGx variants
// (genomic_variants, result_type='pharmacogenomic') × its ACTIVE medications, matched
// against the curated CPIC gene–drug table. The SAME pure crossCheckPgx the /medicine
// row notice, the create/edit inline notice, and the dismissible Upcoming finding all
// format over ("one question, one computation"). The active meds come from the ONE
// shared safety-context gather (getIntakeSafetyContext, #661) — active + kind
// 'medication', each carrying its intake_items id — so the med set can't drift from
// the belt/food consumers. Profile-scoped through getGenomicVariants +
// getIntakeSafetyContext (both profile_id-filtered); no new SQL, so the scoping guard
// is unaffected. Informational, never prescriptive; absence of a flag is not clearance.
export function getPgxWarnings(profileId: number): PgxHit[] {
  const variants = getGenomicVariants(profileId).filter(
    (v) => v.result_type === "pharmacogenomic"
  );
  if (variants.length === 0) return [];
  const meds: PgxMedInput[] = getIntakeSafetyContext(profileId)
    .medications.filter((m): m is typeof m & { id: number } => m.id != null)
    .map((m) => ({
      id: m.id,
      name: m.name,
      rxcui: m.rxcui,
      rxcuiIngredients: m.rxcuiIngredients,
    }));
  return crossCheckPgx(variants, meds);
}

// Human modality label for an imaging_studies row's structured contrast study.
const IMAGING_MODALITY_LABEL: Record<string, string> = {
  ct: "CT",
  mri: "MRI",
};

// Contrast-safety cross-check (issue #701): a PLANNED contrast imaging study meeting a
// contrast/iodine/gadolinium ALLERGY or a renal (CKD) contraindication on file. The
// planned-study signal is gathered from THREE profile-scoped sources, then handed to
// the pure crossCheckContrast — the SAME computation the care-plan inline notice and
// the dismissible Upcoming finding format over ("one question, one computation"):
//   • OPEN care_plan_items whose description/notes indicate contrast (the primary
//     ordered/planned trigger),
//   • still-scheduled appointments whose title/notes indicate contrast, and
//   • FUTURE-dated imaging_studies rows with the structured contrast flag (#702) — a
//     completed/past study is deliberately NOT a trigger (the pre-procedure window has
//     passed), but a future structured row is a strong planned signal.
// Allergens + active conditions come from the ONE shared safety-context gather
// (getIntakeSafetyContext, #661), so this can't drift from the belt/food/PGx consumers.
// Profile-scoped through the underlying reads (all profile_id-filtered); no new SQL, so
// the scoping guard is unaffected. Informational, never prescriptive; absence of a flag
// is not clearance.
export function getContrastSafetyWarnings(
  profileId: number,
  todayStr: string = today(profileId)
): ContrastHit[] {
  const studies: PlannedContrastStudy[] = [];

  for (const cp of getCarePlanItems(profileId)) {
    if (!isCarePlanItemOpen(cp.status)) continue;
    const s = parsePlannedStudy({
      source: "careplan",
      sourceId: cp.id,
      text: [cp.description, cp.notes].filter(Boolean).join(" "),
      label: cp.description,
      date: cp.planned_date,
    });
    if (s) studies.push(s);
  }

  for (const a of getScheduledAppointments(profileId)) {
    const s = parsePlannedStudy({
      source: "appointment",
      sourceId: a.id,
      text: [a.title, a.notes].filter(Boolean).join(" "),
      label: a.title?.trim() || "Scheduled imaging",
      date: a.scheduled_at.slice(0, 10),
    });
    if (s) studies.push(s);
  }

  for (const im of getImagingStudies(profileId)) {
    // Only a FUTURE-dated, structured-contrast study is a planned trigger.
    if (!im.contrast) continue;
    if (!im.study_date || im.study_date <= todayStr) continue;
    const modLabel = IMAGING_MODALITY_LABEL[im.modality] ?? im.modality;
    const label = [modLabel, im.body_region, "with contrast"]
      .filter(Boolean)
      .join(" ");
    const s = parsePlannedStudy({
      source: "imaging",
      sourceId: im.id,
      text: label,
      label,
      date: im.study_date,
      modality: im.modality,
      contrastAgent: im.contrast_agent,
      contrastFlag: true,
    });
    if (s) studies.push(s);
  }

  if (studies.length === 0) return [];
  const { allergens, conditions } = getIntakeSafetyContext(profileId);
  return crossCheckContrast(studies, { allergens, conditions });
}

// The ONE field mapping of the merged intake form (#3216) — form state to the
// `addIntakeItem` / `updateIntakeItem` field set.
//
// WHY IT IS A PURE MODULE AND NOT A HANDLER. Three shells posted three field sets to
// the same action, which is exactly the #2184 drift the merge removes: a field, label
// or gate fixed in one had to be remembered in two. Now there is one mapping, so the
// two-tap create and the fully-edited save are literally the same computation with
// different state. #843's separate quick-add mapping is gone with the quick form it
// served; its guarantee — the quick path's row IS the full form's row — is now the
// merge's safety net, asserted in lib/__action_tests__/intake-row-parity.actions.test.ts
// against a hand-transcribed copy of what the old full form posted.
//
// HIDDEN IS NOT UNMOUNTED (#2014), STRUCTURALLY. The merged form shows at most one
// editor at a time, so a form that relied on named inputs would post only whatever
// editor happened to be open. It does not rely on them: every value is state, and
// this mapping writes all of it on every submit. A field whose editor was never
// opened still saves its seeded value because nothing here consults which editor was
// open — there is no such input.
//
// Pure: no React, no DB, no FormData-only reasoning that a test cannot reproduce.

import type {
  CadenceKind,
  FoodTiming,
  IntakeCondition,
  IntakeDose,
  IntakeItem,
  IntakeItemKind,
  IntakeObligation,
  MedicationCourse,
} from "./types";
import type { IntakePairDraft } from "./intake-rules";
import type { PurposeDraft } from "./intake-purposes";
import { parseRxcuiIngredients, serializeRxcuiIngredients } from "./rxnorm";
import { intakeKindAffordances } from "./intake-kind-affordances";
import { parseWeekdays } from "./intake-cadence";
import { itemSeedFromPool, type SupplyOption } from "./supply-product";

// One dose row, structurally what DoseRowsEditor edits (declared here so the mapping
// stays free of React).
export interface IntakeDoseDraft {
  id?: number;
  amount: string;
  time_of_day: string;
  food_timing: FoodTiming;
  weekdays: number[];
  start_date: string;
  end_date: string;
}

export interface IntakeIngredientDraft {
  name: string;
  amount: string;
}

export interface IntakeCadenceDraft {
  kind: CadenceKind;
  weekdays: number[];
  intervalDays: string;
  anchorDate: string;
}

export interface IntakeItemFormState {
  // Present ⇒ an edit; absent ⇒ a create.
  id?: number | null;
  kind: IntakeItemKind;
  name: string;
  brand: string;
  product: string;
  stack: string;
  condition: IntakeCondition;
  situation: string;
  pauseSituation: string;
  obligation: IntakeObligation;
  critical: boolean;
  escalateAfterMin: string;
  escalateChatId: string;
  minIntervalHours: string;
  maxDailyCount: string;
  maxDailyAmountMg: string;
  redoseNotice: boolean;
  rx: boolean;
  prescriber: string;
  pharmacy: string;
  rxNumber: string;
  provider: string;
  providerId: number | null;
  providerLoaded: string;
  indicationConditionId: string;
  startedOn: string;
  endDate: string;
  courseId: number | null;
  cadence: IntakeCadenceDraft;
  doses: IntakeDoseDraft[];
  pairs: IntakePairDraft[];
  ingredients: IntakeIngredientDraft[];
  // Purpose links (#2857) — the person's structured "why", for either kind. A
  // medication's clinical indication is separate and may coexist with these rows.
  purposes: PurposeDraft[];
  notes: string;
  rxcui: string | null;
  rxcuiIngredients: string[];
  quantityOnHand: string;
  qtyPerDose: string;
  quantityOnHandLoaded: string;
  supplyId: string;
}

export function emptyIntakeCadence(): IntakeCadenceDraft {
  return { kind: "daily", weekdays: [], intervalDays: "", anchorDate: "" };
}

// The action's field entries for this state, as [key, value] pairs.
//
// A BLANK IS WRITTEN, NOT OMITTED, for every field the form owns an editor for —
// clearing a note or a stop date has to reach the action as an empty string, and the
// action's own `strOrNull` turns it back into NULL. The medication-only fields are
// omitted for a supplement (the action clears them anyway; sending them would be a
// second place that decides kind).
export function intakeItemFields(
  state: IntakeItemFormState
): [string, string][] {
  const out: [string, string][] = [];
  const set = (k: string, v: string) => out.push([k, v]);
  const affordances = intakeKindAffordances(state.kind);

  if (state.id != null) set("id", String(state.id));
  set("kind", state.kind);
  set("name", state.name.trim());
  set("brand", state.brand.trim());
  set("product", state.product.trim());
  set("condition", state.condition);
  // The action only reads `situation` for a situational item, but posting it
  // unconditionally would let a stale value ride along; the form's own rules mapping
  // has already blanked it when no only-when rule stands.
  set(
    "situation",
    state.condition === "situational" ? state.situation.trim() : ""
  );
  set("pause_situation", state.pauseSituation.trim());
  set("obligation", state.obligation);
  set("notes", state.notes.trim());

  if (state.critical) {
    set("critical", "1");
    if (state.escalateAfterMin.trim())
      set("escalate_after_min", state.escalateAfterMin.trim());
    if (state.escalateChatId.trim())
      set("escalate_chat_id", state.escalateChatId.trim());
  }

  set("cadence_kind", state.cadence.kind);
  set("cadence_weekdays", state.cadence.weekdays.join(","));
  set("cadence_interval_days", state.cadence.intervalDays);
  set("cadence_anchor_date", state.cadence.anchorDate);

  if (affordances.prescription) {
    set("rx", state.rx ? "1" : "0");
    set("prescriber", state.prescriber.trim());
    set("pharmacy", state.pharmacy.trim());
    set("rx_number", state.rxNumber.trim());
    set("provider", state.provider.trim());
    if (state.id != null) {
      set(
        "provider_id",
        state.providerId != null ? String(state.providerId) : ""
      );
      set("provider_loaded", state.providerLoaded);
    }
    if (state.indicationConditionId.trim())
      set("indication_condition_id", state.indicationConditionId.trim());
    if (state.startedOn.trim()) set("started_on", state.startedOn.trim());
    if (state.courseId != null) set("course_id", String(state.courseId));
    if (state.id != null) set("end_date", state.endDate.trim());
    // The redose trio only exists for an as-needed medication; the action clears it
    // otherwise, and posting it for a scheduled med would be a second gate.
    if (affordances.redose && state.obligation === "may") {
      if (state.minIntervalHours.trim())
        set("min_interval_hours", state.minIntervalHours.trim());
      if (state.maxDailyCount.trim())
        set("max_daily_count", state.maxDailyCount.trim());
      if (state.maxDailyAmountMg.trim())
        set("max_daily_amount_mg", state.maxDailyAmountMg.trim());
      if (
        state.redoseNotice &&
        state.minIntervalHours.trim() &&
        state.maxDailyCount.trim()
      )
        set("redose_notice", "1");
    }
  }
  if (affordances.stack) {
    set("stack", state.stack.trim());
  }
  // Both child sets survive a kind flip (#3649). Posting them for every kind is what
  // makes the shared editors able to update or clear the rows instead of leaving an
  // invisible, absent-means-unchanged value behind.
  set("ingredients", JSON.stringify(state.ingredients));
  set("purposes", JSON.stringify(state.purposes));

  set("doses", JSON.stringify(state.doses));
  set("pairs", JSON.stringify(state.pairs));

  const rxcui = state.rxcui?.trim() ?? "";
  set("rxcui", rxcui);
  set(
    "rxcui_ingredients",
    rxcui ? (serializeRxcuiIngredients(state.rxcuiIngredients) ?? "") : ""
  );

  // Supply. A pooled item keeps no private count, so the form posts the blank the
  // action reads as "untracked" and the pool holds the number (#1374).
  set("quantity_on_hand", state.quantityOnHand.trim());
  set("qty_per_dose", state.qtyPerDose.trim() || "1");
  set("quantity_on_hand_loaded", state.quantityOnHandLoaded);
  if (state.supplyId.trim()) set("supply_id", state.supplyId.trim());

  return out;
}

export function intakeItemFormData(state: IntakeItemFormState): FormData {
  const fd = new FormData();
  for (const [k, v] of intakeItemFields(state)) fd.set(k, v);
  return fd;
}

// A blank state for the given kind — what a create-mode form starts from and what a
// test builds its two-tap case on top of.
export function emptyIntakeItemFormState(
  kind: IntakeItemKind
): IntakeItemFormState {
  return {
    kind,
    name: "",
    brand: "",
    product: "",
    stack: "",
    condition: "daily",
    situation: "",
    pauseSituation: "",
    obligation: intakeKindAffordances(kind).defaultObligation,
    critical: false,
    escalateAfterMin: "",
    escalateChatId: "",
    minIntervalHours: "",
    maxDailyCount: "",
    maxDailyAmountMg: "",
    redoseNotice: false,
    rx: false,
    prescriber: "",
    pharmacy: "",
    rxNumber: "",
    provider: "",
    providerId: null,
    providerLoaded: "",
    indicationConditionId: "",
    startedOn: "",
    endDate: "",
    courseId: null,
    cadence: emptyIntakeCadence(),
    doses: [
      {
        amount: "",
        time_of_day: "",
        food_timing: "any",
        weekdays: [],
        start_date: "",
        end_date: "",
      },
    ],
    pairs: [],
    ingredients: [],
    purposes: [],
    notes: "",
    rxcui: null,
    rxcuiIngredients: [],
    quantityOnHand: "",
    qtyPerDose: "1",
    quantityOnHandLoaded: "",
    supplyId: "",
  };
}

// THE ONE SEEDING (#4664). What a mounted intake form starts from, for every mount:
// the blank for the kind with the stored row, its course, its dose rows and the picked
// bottle merged in.
//
// WHY IT IS HERE AND NOT IN THE COMPONENT. The form used to seed field-by-field, one
// `item?.…` expression per `useState` — an undeduped copy of `emptyIntakeItemFormState`
// with the row merged in, 29 expressions long. A field added to the type and to the
// blank but forgotten here is seeded as blank on an edit, which reads as data loss and
// nothing catches it. One factory over the one type is testable without React, so the
// seeding rules ("a course's start date wins over today", "an as-needed item has no
// start date", "a bottle answers the strength") are asserted rather than assumed.
//
// WHAT IT DOES NOT DECIDE. `situation`, `pauseSituation` and `pairs` are seeded from
// the row, but the live form re-derives them from the rule SENTENCES it built out of
// this same row (lib/intake-rules); likewise `rxcui`, which the RxNorm confirm hook
// owns after mount. They are seeded so this state is a faithful reading of the row —
// what a test of the seeding asks about — not so the form reads them back from here.
export function intakeItemFormStateFrom(seed: {
  kind: IntakeItemKind;
  // Present ⇒ an edit, seeded from the row; absent ⇒ a create.
  item?: IntakeItem | null;
  // The open course, whose window wins over the row's own dates (#1204).
  course?: MedicationCourse | null;
  // The profile-local day (never `new Date()` here — the caller resolves it).
  todayStr?: string | null;
  // A bottle picked at the door (#1705): it answers the name and the strength, and
  // rides as `supply_id` on this item's own save.
  supply?: SupplyOption | null;
  doses?: readonly IntakeDose[] | null;
  ingredients?: readonly IntakeIngredientDraft[] | null;
  purposes?: readonly PurposeDraft[] | null;
  pairs?: readonly IntakePairDraft[] | null;
}): IntakeItemFormState {
  const item = seed.item ?? null;
  const supplySeed = seed.supply ? itemSeedFromPool(seed.supply) : null;
  const blank = emptyIntakeItemFormState(seed.kind);
  const onHand =
    item?.quantity_on_hand != null
      ? String(Math.max(0, item.quantity_on_hand))
      : "";
  const sortedWeekdays = (csv: string | null | undefined) =>
    [...parseWeekdays(csv)].sort((a, b) => a - b);
  return {
    ...blank,
    id: item?.id ?? null,
    name: item?.name ?? supplySeed?.name ?? "",
    brand: item?.brand ?? "",
    product: item?.product ?? "",
    stack: item?.stack ?? "",
    condition: item?.condition ?? blank.condition,
    situation: item?.situation ?? "",
    pauseSituation: item?.pause_situation ?? "",
    obligation: item?.obligation ?? blank.obligation,
    critical: item?.critical === 1,
    escalateAfterMin:
      item?.escalate_after_min != null ? String(item.escalate_after_min) : "",
    escalateChatId: item?.escalate_chat_id ?? "",
    minIntervalHours:
      item?.min_interval_hours != null ? String(item.min_interval_hours) : "",
    maxDailyCount:
      item?.max_daily_count != null ? String(item.max_daily_count) : "",
    maxDailyAmountMg:
      item?.max_daily_amount_mg != null
        ? String(item.max_daily_amount_mg)
        : "",
    redoseNotice: item?.redose_notice === 1,
    rx: item?.rx === 1,
    prescriber: item?.prescriber ?? "",
    pharmacy: item?.pharmacy ?? "",
    rxNumber: item?.rx_number ?? "",
    provider: item?.provider_name ?? "",
    providerId: item?.provider_id ?? null,
    // What the form LOADED, for the action's own concurrency check — frozen at mount
    // on purpose, because that is the value the person is editing against.
    providerLoaded: item?.provider_name ?? "",
    indicationConditionId:
      item?.indication_condition_id != null
        ? String(item.indication_condition_id)
        : "",
    // An as-needed item has no start date to volunteer; everything else starts today
    // unless a course states otherwise.
    startedOn:
      seed.course?.started_on ??
      (item?.obligation === "may" ? "" : (seed.todayStr ?? "")),
    endDate: seed.course?.stopped_on ?? "",
    courseId: seed.course?.id ?? null,
    cadence: {
      kind: item?.cadence_kind ?? blank.cadence.kind,
      weekdays: sortedWeekdays(item?.cadence_weekdays),
      intervalDays:
        item?.cadence_interval_days != null
          ? String(item.cadence_interval_days)
          : "",
      anchorDate: item?.cadence_anchor_date ?? "",
    },
    doses:
      seed.doses && seed.doses.length
        ? seed.doses.map((d) => ({
            id: d.id,
            amount: d.amount ?? "",
            time_of_day: d.time_of_day ?? "",
            food_timing: d.food_timing,
            weekdays: sortedWeekdays(d.weekdays),
            start_date: d.start_date ?? "",
            end_date: d.end_date ?? "",
          }))
        : [{ ...blank.doses[0], amount: supplySeed?.amount ?? "" }],
    pairs: [...(seed.pairs ?? [])],
    ingredients: [...(seed.ingredients ?? [])],
    purposes: [...(seed.purposes ?? [])],
    notes: item?.notes ?? "",
    rxcui: item?.rxcui ?? null,
    rxcuiIngredients: parseRxcuiIngredients(item?.rxcui_ingredients ?? null),
    quantityOnHand: onHand,
    qtyPerDose: String(item?.qty_per_dose ?? 1),
    quantityOnHandLoaded: onHand,
    supplyId:
      item?.supply_id != null
        ? String(item.supply_id)
        : seed.supply
          ? String(seed.supply.id)
          : "",
  };
}

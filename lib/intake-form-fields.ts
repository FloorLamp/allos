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
import type { PairRelation } from "./types";
import type { IntakePairDraft } from "./intake-rules";
import {
  normalizePurposeDrafts,
  type PurposeDraft,
  type PurposeWrite,
} from "./intake-purposes";
import {
  normalizeIngredientDrafts,
  type IngredientDraftResult,
} from "./intake-ingredients";
import { parseRxcuiIngredients, serializeRxcuiIngredients } from "./rxnorm";
import { intakeKindAffordances } from "./intake-kind-affordances";
import { FOOD_TIMINGS, type CollapsibleDose } from "./intake-schedule";
import { normalizeWeekdays, parseWeekdays } from "./intake-cadence";
import { isRealIsoDate } from "./date";
import { strOrNull } from "./parse";
import { itemSeedFromPool, type SupplyOption } from "./supply-product";

// THE ONE SPELLING OF EVERY INTAKE FORM KEY (#4666). These 43 names used to be
// written twice — once in the `set(` calls below, once in the `formData.get/has`
// reads in app/(app)/nutrition/intake-actions.ts — with nothing connecting the two
// copies, so a rename typechecked clean on both sides and failed at runtime as a
// silently dropped field. Both sides now take an `IntakeField`, so renaming a key
// here is a compile error at every site still spelling the old name.
export type IntakeField =
  | "id"
  | "kind"
  | "name"
  | "brand"
  | "product"
  | "condition"
  | "situation"
  | "pause_situation"
  | "obligation"
  | "notes"
  | "critical"
  | "escalate_after_min"
  | "escalate_chat_id"
  | "cadence_kind"
  | "cadence_weekdays"
  | "cadence_interval_days"
  | "cadence_anchor_date"
  | "rx"
  | "prescriber"
  | "pharmacy"
  | "rx_number"
  | "provider"
  | "provider_id"
  | "provider_loaded"
  | "indication_condition_id"
  | "started_on"
  | "course_id"
  | "end_date"
  | "min_interval_hours"
  | "max_daily_count"
  | "max_daily_amount_mg"
  | "redose_notice"
  | "stack"
  | "ingredients"
  | "purposes"
  | "doses"
  | "pairs"
  | "rxcui"
  | "rxcui_ingredients"
  | "quantity_on_hand"
  | "qty_per_dose"
  | "quantity_on_hand_loaded"
  | "supply_id";

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
): [IntakeField, string][] {
  const out: [IntakeField, string][] = [];
  const set = (k: IntakeField, v: string) => out.push([k, v]);
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

// THE PAYLOAD SIDE OF THE SAME ROUND TRIP (#4666). Four fields ride as JSON, and the
// server used to re-derive their shapes through `(p as any)`. They are parsed here,
// beside the drafts that wrote them and KEYED ON those drafts: every value stays
// `unknown` (untrusted client text at a write boundary), but a key the draft does not
// have is a compile error in the parse instead of an `undefined` at runtime. The
// distributed `keyof` is what lets a union draft (PurposeDraft) offer every variant's
// keys rather than only the ones all three share. Anything that is not an array of
// objects reads as NO ROWS — a malformed payload never throws.
type PostedRow<T> = Partial<
  Record<T extends unknown ? keyof T : never, unknown>
>;

function jsonRows<T>(formData: FormData, key: IntakeField): PostedRow<T>[] {
  const value = formData.get(key);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(typeof value === "string" ? value : "[]");
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? parsed.filter(
        (r): r is PostedRow<T> => typeof r === "object" && r !== null
      )
    : [];
}

// Was this field posted at all? `absent` is a different statement from `empty` for the
// two child sets below, and the key is checked like every other.
const posted = (formData: FormData, key: IntakeField) => formData.has(key);

const textOf = (v: unknown): string => (typeof v === "string" ? v : "");
// A malformed date is dropped rather than stored: an unparseable window reads as "no
// window", and storing it would leave a value that looks like a rule but constrains
// nothing.
const isoDateOrNull = (v: unknown): string | null =>
  typeof v === "string" && isRealIsoDate(v) ? v : null;

// Parse the doses JSON the form submits. Always returns at least one dose so an item
// is never left without a schedule entry. normalizeWeekdays drops anything out of
// range and canonicalizes the order (#1602), so an equivalent re-submission stores
// identically and a no-op edit never looks like a change.
export function parseIntakeDoses(formData: FormData): CollapsibleDose[] {
  const rows = jsonRows<IntakeDoseDraft>(formData, "doses").map((d) => ({
    id: typeof d.id === "number" ? d.id : undefined,
    amount: strOrNull(d.amount),
    time_of_day: strOrNull(d.time_of_day),
    food_timing: FOOD_TIMINGS.find((t) => t === d.food_timing) ?? "any",
    weekdays: normalizeWeekdays(
      Array.isArray(d.weekdays) ? d.weekdays.map((x) => Number(x)) : []
    ),
    start_date: isoDateOrNull(d.start_date),
    end_date: isoDateOrNull(d.end_date),
  }));
  return rows.length
    ? rows
    : [
        {
          amount: null,
          time_of_day: null,
          food_timing: "any",
          weekdays: null,
          start_date: null,
          end_date: null,
        },
      ];
}

// A submitted pair: the relationship from the edited item to another of this
// profile's. The id is untrusted and is checked against the profile at the write.
export interface IntakePairInput {
  otherId: number;
  relation: PairRelation;
  note: string | null;
}

// Parse the interactions JSON the form submits.
export function parseIntakePairs(formData: FormData): IntakePairInput[] {
  return jsonRows<IntakePairDraft>(formData, "pairs")
    .map((p): IntakePairInput => ({
      otherId: Number(p.otherId) || 0,
      relation: p.relation === "with" ? "with" : "separate",
      note: strOrNull(p.note),
    }))
    .filter((p) => p.otherId > 0);
}

// Parse the ingredients JSON the form's repeater submits (issue #2856). The posted
// shape is the LABEL's own words — a name and the amount text as printed — and the
// canonical (amount, unit) pair is derived at the write boundary by the shared pure
// normalizer, never trusted from the client. Blank rows are dropped; a row with a name
// and no amount is KEPT, because "this blend contains St. John's Wort" is exactly what
// the interaction belt needs even when the label hides the milligrams.
//
// ABSENT MEANS UNCHANGED (review of #2856). `null` here is "this form did not post a
// composition", which is a different statement from "this item has no composition" and
// must not clear one. Two forms share updateIntakeItem, and only one of them renders
// the repeater; without this distinction a medication edit — or any future form
// reusing the action — would silently delete a person's transcribed label. An explicit
// empty array from a form that DOES render the repeater still clears it, which is how
// someone removes every row.
//
// A row whose amount carries digits but is not one clean quantity refuses the whole
// save (see readIngredientAmount): storing it as "no stated amount" would drop a real
// upper-limit contribution exactly as quietly as the fabricated zero it replaced.
export function parseIntakeIngredients(
  formData: FormData
): IngredientDraftResult | null {
  if (!posted(formData, "ingredients")) return null;
  return normalizeIngredientDrafts(
    jsonRows<IntakeIngredientDraft>(formData, "ingredients").map((g) => ({
      name: textOf(g.name),
      amount_text: textOf(g.amount),
    }))
  );
}

// Parse the purposes JSON the form submits (issue #2857) — the structured "why" of an
// item: a goal key, a condition id, or a canonical biomarker name with an optional
// flag direction, normalized at the write boundary by the shared pure normalizer.
//
// ABSENT MEANS UNCHANGED, exactly as it does for the composition above and for the same
// reason: `null` is "this form did not post purposes", which is not "this item has no
// purposes" and must not clear one.
//
// Nothing here can REFUSE a save. A purpose is an annotation; an unrenderable row is
// dropped by the normalizer and the rest of the person's edit lands (see
// normalizePurposeDrafts).
export function parseIntakePurposes(formData: FormData): PurposeWrite[] | null {
  if (!posted(formData, "purposes")) return null;
  const drafts: PurposeDraft[] = [];
  for (const p of jsonRows<PurposeDraft>(formData, "purposes")) {
    if (p.kind === "goal") {
      drafts.push({ kind: "goal", goalKey: textOf(p.goalKey) });
    } else if (p.kind === "condition") {
      drafts.push({ kind: "condition", conditionId: Number(p.conditionId) });
    } else if (p.kind === "biomarker") {
      drafts.push({
        kind: "biomarker",
        biomarkerKey: textOf(p.biomarkerKey),
        direction:
          p.direction === "low" || p.direction === "high" ? p.direction : null,
      });
    }
  }
  return normalizePurposeDrafts(drafts);
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
      item?.max_daily_amount_mg != null ? String(item.max_daily_amount_mg) : "",
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

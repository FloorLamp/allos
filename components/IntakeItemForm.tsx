"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import IntakeItemCombobox from "@/components/IntakeItemCombobox";
import FilterPills from "@/components/FilterPills";
import ProviderCombobox from "@/components/ProviderCombobox";
import { useIntakeOptions } from "@/components/IntakeOptionsContext";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { useResettableState } from "@/components/useResettableState";
import { useConfirm } from "@/components/ConfirmDialog";
import DraftRestoreBanner from "@/components/DraftRestoreBanner";
import { useFormDraft } from "@/components/useFormDraft";
import RxNormAffordance from "@/components/intake/RxNormAffordance";
import IntakeInteractionNotices from "@/components/intake/IntakeInteractionNotices";
import DoseRowsEditor, {
  emptyDose,
  type DoseState,
} from "@/components/intake/DoseRowsEditor";
import RetiredDoses from "@/components/intake/RetiredDoses";
import CadenceEditor, {
  type CadenceState,
} from "@/components/intake/CadenceEditor";
import CriticalEscalation from "@/components/intake/CriticalEscalation";
import RefillTracking from "@/components/intake/RefillTracking";
import IntakeNotesField from "@/components/intake/IntakeNotesField";
import IngredientsEditor, {
  emptyIngredient,
  ingredientStates,
  ingredientsAreEmpty,
  type IngredientState,
} from "@/components/intake/IngredientsEditor";
import PediatricDoseBandPicker from "@/components/medications/PediatricDoseBandPicker";
import PediatricWeightUpdate from "@/components/medications/PediatricWeightUpdate";
import { useIntakeRxcui } from "@/components/intake/useIntakeRxcui";
import IntakeFactRow, {
  type IntakeOpenPanel,
} from "@/components/intake/IntakeFactRow";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import IntakeRulesEditor from "@/components/intake/IntakeRulesEditor";
import { parseWeekdays, cadenceLabel } from "@/lib/intake-cadence";
import {
  applyProductSeed,
  bottleForOptionLabel,
  bottleOptionLabel,
  bottlesForKindDoor,
  itemSeedFromPool,
  type SupplyOption,
} from "@/lib/supply-product";
import { listSharedSupplyOptions } from "@/app/(app)/supplies/actions";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { IntakeItemIngredient } from "@/lib/intake-ingredients";
import PurposesEditor from "@/components/intake/PurposesEditor";
import {
  purposeToDraft,
  purposeLabel,
  type IntakeItemPurpose,
  type PurposeDraft,
} from "@/lib/intake-purposes";
import type { PgxVariantInput } from "@/lib/pgx";
import {
  medicationBrandOptions,
  resolveMedicationPick,
  getMedicationInfo,
} from "@/lib/medication-info";
import { SUPPLEMENT_CATALOG } from "@/lib/supplement-catalog";
import { SUPPLEMENT_BRANDS } from "@/lib/supplement-brands";
import { prnDefaultsFor, redoseLabelDefaults } from "@/lib/prn-defaults";
import type { PediatricBand } from "@/lib/datasets/prn-defaults";
import {
  formulationSlugForProduct,
  isChildProfileAge,
  pediatricAgeYears,
  pediatricDoseSuggestion,
  type PediatricFormContext,
} from "@/lib/prn-dosing";
import {
  DEFAULT_FORMULATION_SLUG,
  defaultFormulationSlug,
  formulationChoices,
  formulationDoseAmount,
  formulationRedosePreset,
  pediatricContextLine,
} from "@/lib/intake-formulations";
import {
  applyPrefill,
  emptyPrefillLedger,
  resolveIntakePrefill,
  touchPrefill,
  withdrawPrefill,
  type IntakeLabelSource,
  type IntakePrefillSource,
  type PrefillField,
  type PrefillLedger,
  type PrefillValues,
} from "@/lib/intake-prefill";
import {
  CONDITION_LABELS,
  OBLIGATIONS,
  OBLIGATION_HINTS,
  OBLIGATION_LABELS,
  pauseLinkNeedsConfirm,
} from "@/lib/intake-schedule";
import {
  brandOptionsFor,
  dosageOptionsFor,
  intakeKindAffordances,
} from "@/lib/intake-kind-affordances";
import {
  intakeFactSummary,
  type IntakeFactKey,
  INTAKE_FACT_NOUNS,
} from "@/lib/intake-facts";
import {
  fieldsFromRules,
  rulesFromFields,
  suggestedRulesForFoodTiming,
  type IntakeRule,
} from "@/lib/intake-rules";
import {
  emptyIntakeCadence,
  intakeItemFormData,
  type IntakeItemFormState,
} from "@/lib/intake-form-fields";
import type {
  FormResult,
  IntakeCondition,
  IntakeConditionOption,
  IntakeItem,
  IntakeItemKind,
  IntakeDose,
  IntakeObligation,
  IntakePair,
  MedicationCourse,
} from "@/lib/types";
import { requireIntakeFormKind } from "@/lib/intake-form-kind";
import Disclosure from "@/components/Disclosure";

const CATALOG_BY_NAME = new Map(
  SUPPLEMENT_CATALOG.map((c) => [c.name.toLowerCase(), c])
);

// THE ONE INTAKE FORM (#3216) — the merge of MedicationForm (1,356 lines),
// SupplementForm (703) and QuickAddMedication (407) into a single kind-aware form
// that every host mounts.
//
// WHAT THE THREE SHELLS COST, each observed: the quick/full split existed only for
// medications, so a supplement had no frictionless door at all; the kind split forced
// an upfront question the data usually already answered; and three shells over one
// write path is #2184's drift class standing armed — every field, label and gate
// fixed in one had to be remembered in two others.
//
// THE INTERACTION MODEL (owner decision, 2026-08-19). After a pick the form renders
// NO editors. It renders the FACTS it is about to save, as a row of tappable
// sentences, and one editor opens at a time behind whichever fact you disagree with.
// This is not a cosmetic preference: front-loading every field is what made the OTC
// quick-add necessary, and a first consolidation attempt during prototyping put every
// field on screen at once and hit exactly the same wall. Grouping does not fix it;
// only not asking does.
//
// HIDDEN IS NOT UNMOUNTED (#2014), AND HERE IT IS STRUCTURAL. Every value is React
// state and every submit serializes ALL of it through lib/intake-form-fields — the
// mapping cannot consult which editor was open because it is a pure function that is
// never told. A field whose editor was never opened still saves its seeded value, and
// the two-tap create posts the same row the old full form did.
//
// WHAT STAYS OUT. The facts-with-editors pattern is deliberately LOCAL to this form:
// #3218 extracts it as a shared primitive once a second consumer exists
// (convergence-by-consolidation — extract at the second use, not speculatively).

export default function IntakeItemForm({
  action,
  item,
  kind: requestedKind,
  doses: initialDoses,
  ingredients: initialIngredients = [],
  purposes: initialPurposes = [],
  biomarkers = [],
  retiredDoses = [],
  allIntakeItems = [],
  conditions = [],
  stackItems = [],
  pgxVariants = [],
  pairs: initialPairs = [],
  onDone,
  pediatric,
  course,
  todayStr,
  initialSupply = null,
  activityScheduleAvailable = true,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  // Present ⇒ edit mode, seeded from the row; absent ⇒ create.
  item?: IntakeItem;
  // Every shipped door is kind-locked (/medications or Nutrition → Supplements).
  // There is no generic chooser route, so the host must state which write it owns.
  kind: IntakeItemKind;
  doses?: IntakeDose[];
  ingredients?: IntakeItemIngredient[];
  // Declared purpose links (#2857), seeding the "What you take it for" control on edit.
  purposes?: IntakeItemPurpose[];
  // Canonical biomarker names this profile has results for (getUsedCanonicalNames) —
  // the biomarker purpose's picker source. Empty ⇒ that row does not render.
  biomarkers?: string[];
  retiredDoses?: IntakeDose[];
  allIntakeItems?: { id: number; name: string }[];
  conditions?: IntakeConditionOption[];
  stackItems?: InteractionItem[];
  pgxVariants?: PgxVariantInput[];
  pairs?: IntakePair[];
  onDone?: () => void;
  pediatric?: PediatricFormContext;
  course?: MedicationCourse;
  todayStr?: string;
  initialSupply?: SupplyOption | null;
  activityScheduleAvailable?: boolean;
}) {
  const lockedKind = requireIntakeFormKind(requestedKind);
  const s = item;
  const fid = s?.id ?? "new";
  const toast = useToast();
  const confirm = useConfirm();
  const formRef = useRef<HTMLFormElement>(null);
  const catalogOptions = useIntakeOptions();
  const [error, setError] = useState<string | null>(null);
  // The one-editor-at-a-time state and its Done/Esc contract come from the shared
  // facts-with-editors primitive (#3218); this form supplies only its own fact keys.
  // The form element is the scope the primitive searches to hand focus back to the chip
  // that opened an editor (#3311).
  const {
    openEditor: openPanel,
    open: setOpenPanel,
    close: closePanel,
    onKeyDown: onFormKeyDown,
  } = useFactEditor<IntakeOpenPanel>({ scopeRef: formRef });
  // Whether the rules panel was entered to ADD one (the chip row's "+ rule") rather
  // than to correct an existing sentence.
  const [rulesStartOnMenu, setRulesStartOnMenu] = useState(false);

  const supplySeed = initialSupply ? itemSeedFromPool(initialSupply) : null;
  const seededRef = useRef(supplySeed);

  // ---- The one field ----
  const [name, setName] = useState(s?.name ?? supplySeed?.name ?? "");
  // The household's bottles, offered in the SAME field as the vocabularies (#3216
  // decision 3). This is the #1705 create-mode branch promoted from the refill fold to
  // the front door: "there is a shared bottle of D3 5000 IU; add it for my daughter"
  // is one pick, not a form plus a disclosure. Create mode only — an existing item
  // links and unlinks through SharedSupplyPicker, whose separate-submit, one-way
  // count-migration design this does not touch.
  const [bottles, setBottles] = useState<SupplyOption[]>(
    initialSupply ? [initialSupply] : []
  );
  useEffect(() => {
    let live = true;
    void listSharedSupplyOptions().then((options) => {
      const offered = bottlesForKindDoor(options, lockedKind);
      const linkedId = s?.supply_id ?? initialSupply?.id;
      const linked = options.find((option) => option.id === linkedId);
      if (linked && !offered.some((option) => option.id === linked.id))
        offered.unshift(linked);
      if (live) setBottles(offered);
    });
    return () => {
      live = false;
    };
  }, [s, initialSupply, lockedKind]);
  const rx = useIntakeRxcui(s);

  const kind = lockedKind;
  const isMed = kind === "medication";
  const affordances = intakeKindAffordances(kind, {
    activityScheduleAvailable,
    storedCondition: s?.condition ?? null,
  });

  // ---- State: every fact the form will post ----
  const [brand, setBrand] = useState(s?.brand ?? "");
  const [brandNarrowing, setBrandNarrowing] = useState<string[] | null>(null);
  const [product, setProduct] = useState(s?.product ?? "");
  const [stack, setStack] = useState(s?.stack ?? "");
  const [condition, setCondition] = useState<IntakeCondition>(
    s?.condition ?? "daily"
  );
  const [obligation, setObligationState] = useState<IntakeObligation>(
    s?.obligation ?? affordances.defaultObligation
  );
  const [critical, setCritical] = useState(s?.critical === 1);
  const [escalateAfterMin, setEscalateAfterMin] = useState(
    s?.escalate_after_min != null ? String(s.escalate_after_min) : ""
  );
  const [escalateChatId, setEscalateChatId] = useState(
    s?.escalate_chat_id ?? ""
  );
  const [minIntervalHours, setMinIntervalHours] = useState(
    s?.min_interval_hours != null ? String(s.min_interval_hours) : ""
  );
  const [maxDailyCount, setMaxDailyCount] = useState(
    s?.max_daily_count != null ? String(s.max_daily_count) : ""
  );
  const [maxDailyAmountMg, setMaxDailyAmountMg] = useState(
    s?.max_daily_amount_mg != null ? String(s.max_daily_amount_mg) : ""
  );
  const [redoseNotice, setRedoseNotice] = useState(s?.redose_notice === 1);
  const [rxFlag, setRxFlag] = useState(s?.rx === 1);
  const [prescriber, setPrescriber] = useState(s?.prescriber ?? "");
  const [pharmacy, setPharmacy] = useState(s?.pharmacy ?? "");
  const [rxNumber, setRxNumber] = useState(s?.rx_number ?? "");
  const [provider, setProvider] = useState(s?.provider_name ?? "");
  const [indicationConditionId, setIndicationConditionId] = useState(
    s?.indication_condition_id != null ? String(s.indication_condition_id) : ""
  );
  const [startedOn, setStartedOn] = useState(
    course?.started_on ?? (s?.obligation === "may" ? "" : (todayStr ?? ""))
  );
  const [startedOnTouched, setStartedOnTouched] = useState(false);
  const [endDate, setEndDate] = useState(course?.stopped_on ?? "");
  const [notes, setNotes] = useState(s?.notes ?? "");
  const [quantityOnHand, setQuantityOnHand] = useState(
    s?.quantity_on_hand != null ? String(Math.max(0, s.quantity_on_hand)) : ""
  );
  const [qtyPerDose, setQtyPerDose] = useState(String(s?.qty_per_dose ?? 1));
  const [supplyId, setSupplyId] = useState(
    s?.supply_id != null
      ? String(s.supply_id)
      : initialSupply
        ? String(initialSupply.id)
        : ""
  );
  const [supplyLabel, setSupplyLabel] = useState<string | null>(
    s?.supply_name ?? initialSupply?.name ?? null
  );
  // Selection-prefill bookkeeping (#846, #4665). ONE ledger answers "may I overwrite
  // this field?" for all seven seed paths, and marks everything it lets through: before
  // it there were four mechanisms and the places they disagreed were bugs. The rules
  // themselves are pure and tested in lib/intake-prefill.ts; this holds the state.
  //
  // MIRRORED IN A REF because a name pick now awaits its own RxNorm confirm before it
  // seeds (below), so the ledger it consults must be the one that stands WHEN it seeds
  // and not the one captured by the render that started the pick.
  const [ledger, setLedgerState] = useState<PrefillLedger>(emptyPrefillLedger);
  const ledgerRef = useRef(ledger);
  function setLedger(next: PrefillLedger) {
    ledgerRef.current = next;
    setLedgerState(next);
  }
  function markTouched(...fields: PrefillField[]) {
    setLedger(touchPrefill(ledgerRef.current, ...fields));
  }
  // Offer these values to the ledger and return the ones it permits, already marked.
  function offerPrefill(offer: PrefillValues): PrefillValues {
    const applied = applyPrefill(ledgerRef.current, offer);
    setLedger(applied.ledger);
    return applied.writes;
  }
  // The ONE writer for a permitted prefill. Every seed path ends here, so a field is
  // written the same way whichever vocabulary or control offered it.
  function writePrefill(writes: PrefillValues) {
    if (writes.asNeeded !== undefined)
      setObligation(writes.asNeeded ? "may" : "must");
    if (writes.minIntervalHours !== undefined)
      setMinIntervalHours(String(writes.minIntervalHours));
    if (writes.maxDailyCount !== undefined)
      setMaxDailyCount(String(writes.maxDailyCount));
    if (writes.doseAmount !== undefined || writes.timeOfDay !== undefined)
      setDoses((ds) =>
        ds.map((d, i) =>
          i === 0
            ? {
                ...d,
                amount: writes.doseAmount ?? d.amount,
                time_of_day: writes.timeOfDay ?? d.time_of_day,
              }
            : d
        )
      );
  }
  const [formulationSlug, setFormulationSlug] = useState("");
  const [selectedPediatricBandMinLbs, setSelectedPediatricBandMinLbs] =
    useState<number | null>(null);
  const [pediatricContext, setPediatricContext] = useResettableState(
    pediatric,
    pediatric
  );
  const [ingredients, setIngredients] = useState<IngredientState[]>(() =>
    ingredientStates(initialIngredients)
  );
  const [ingredientSeedNote, setIngredientSeedNote] = useState<string | null>(
    null
  );
  const [purposes, setPurposes] = useState<PurposeDraft[]>(() =>
    initialPurposes
      .map(purposeToDraft)
      .filter((d): d is PurposeDraft => d != null)
  );
  // The declared purposes as one phrase for the fact chip. Built HERE because only the
  // form holds the live condition names — a purpose row stores the id (#203).
  const purposeSummary = useMemo(
    () =>
      purposes
        .map((d) =>
          purposeLabel(
            {
              kind: d.kind,
              goal_key: d.kind === "goal" ? d.goalKey : null,
              biomarker_key: d.kind === "biomarker" ? d.biomarkerKey : null,
              direction: d.kind === "biomarker" ? (d.direction ?? null) : null,
            },
            d.kind === "condition"
              ? (conditions.find((c) => c.id === d.conditionId)?.name ?? null)
              : null
          )
        )
        .filter((l): l is string => !!l)
        .join(" · "),
    [purposes, conditions]
  );
  const [doses, setDoses] = useState<DoseState[]>(
    initialDoses && initialDoses.length
      ? initialDoses.map((d) => ({
          id: d.id,
          amount: d.amount ?? "",
          time_of_day: d.time_of_day ?? "",
          food_timing: d.food_timing,
          weekdays: [...parseWeekdays(d.weekdays)].sort((a, b) => a - b),
          start_date: d.start_date ?? "",
          end_date: d.end_date ?? "",
        }))
      : [{ ...emptyDose(), amount: supplySeed?.amount ?? "" }]
  );
  const [cadence, setCadence] = useState<CadenceState>(() => ({
    kind: s?.cadence_kind ?? "daily",
    weekdays: [...parseWeekdays(s?.cadence_weekdays)].sort((a, b) => a - b),
    intervalDays:
      s?.cadence_interval_days != null ? String(s.cadence_interval_days) : "",
    anchorDate: s?.cadence_anchor_date ?? "",
  }));
  // The rule SENTENCES. In edit mode they are read back out of the stored row, which
  // is what makes the summary double as the item's review.
  const [rules, setRules] = useState<IntakeRule[]>(() =>
    rulesFromFields({
      condition: s?.condition ?? null,
      situation: s?.situation ?? null,
      pauseSituation: s?.pause_situation ?? null,
      foodTiming: initialDoses?.[0]?.food_timing ?? null,
      pairs: initialPairs,
      selfId: s?.id ?? null,
    })
  );

  const others = allIntakeItems.filter((x) => x.id !== s?.id);
  const itemNames = useMemo(
    () => new Map(allIntakeItems.map((x) => [x.id, x.name])),
    [allIntakeItems]
  );

  function setObligation(next: IntakeObligation) {
    setObligationState(next);
    if (!s && !startedOnTouched)
      setStartedOn(next === "may" ? "" : (todayStr ?? ""));
  }

  // ---- Datasets for the derived kind ----
  const prnDefaults = useMemo(
    () =>
      isMed && name.trim()
        ? prnDefaultsFor({
            name,
            rxcui: rx.rxcui,
            rxcuiIngredients: rx.rxcuiIngredients,
          })
        : null,
    [isMed, name, rx.rxcui, rx.rxcuiIngredients]
  );
  const catalogEntry = CATALOG_BY_NAME.get(name.trim().toLowerCase());
  // One call site each for the two suggestion lists #846 found teaching wrong.
  const dosageOptions = useMemo(
    () =>
      dosageOptionsFor(affordances.dosageSource, {
        otcStrengths: prnDefaults
          ? [
              ...new Set([
                `${prnDefaults.adult.doseMgLow} mg`,
                `${prnDefaults.adult.doseMgHigh} mg`,
              ]),
            ]
          : [],
        catalogDosages: catalogEntry?.dosages ?? [],
      }),
    [affordances.dosageSource, catalogEntry, prnDefaults]
  );
  const brandOptions = brandOptionsFor(affordances.catalogSource, {
    medicationBrands: brandNarrowing ?? catalogOptions.medicationBrands,
    supplementBrands: SUPPLEMENT_BRANDS,
  });

  // MEMOIZED for the compiler, not for the arithmetic. The rule is one comparison, but
  // it is now a CALL (the one spelling, #4672), and the compiler treats an opaque call
  // whose result feeds `activeSlug` as something that may change later — which makes it
  // abandon the `pediatricResult` memo below. Stating the boundary here keeps the memo.
  const isChildProfile = useMemo(
    () => isChildProfileAge(pediatricContext?.ageMonths),
    [pediatricContext]
  );
  // The age-aware label figures to OFFER (#851 item 12) — pediatric for a child where
  // the label differs, else adult, and NULL for a child whose ingredient has no
  // pediatric figure (a deliberate refusal to prefill adult numbers below a child's
  // floor, #798).
  const redoseDefaults = prnDefaults
    ? redoseLabelDefaults(prnDefaults, isChildProfile)
    : null;
  // The educational "what is this drug" explainer, matched from the name. Passive
  // context beside the field it explains — it is not a fact being saved, so it is not
  // a chip.
  const medInfo = useMemo(
    () => (isMed ? getMedicationInfo(name) : null),
    [isMed, name]
  );

  // ---- Formulation (decision 2) ----
  const choices = useMemo(
    () => (affordances.pediatric ? formulationChoices(prnDefaults) : []),
    [affordances.pediatric, prnDefaults]
  );
  // The profile's age picks the default; a stored product wins over it, so an edit
  // reads back what was saved rather than being re-derived out from under the user.
  const storedSlug = useMemo(
    () =>
      formulationSlugForProduct(
        prnDefaults?.pediatric?.formulations ?? [],
        s?.product
      ),
    [prnDefaults, s?.product]
  );
  const activeSlug =
    formulationSlug ||
    defaultFormulationSlug({ choices, isChildProfile, storedSlug });
  const activeChoice =
    choices.find((c) => c.slug === activeSlug) ?? choices[0] ?? null;

  const pediatricResult = useMemo(() => {
    if (
      !affordances.pediatric ||
      !prnDefaults?.pediatric ||
      !pediatricContext ||
      pediatricContext.ageMonths == null
    )
      return null;
    if (!isChildProfileAge(pediatricContext.ageMonths)) return null;
    return pediatricDoseSuggestion({
      entry: prnDefaults,
      ageMonths: pediatricContext.ageMonths,
      weightKg: pediatricContext.weightKg,
      weightDate: pediatricContext.weightDate,
      today: pediatricContext.today,
      formulationSlug: activeSlug || null,
    });
  }, [affordances.pediatric, prnDefaults, pediatricContext, activeSlug]);

  // Switching the formulation re-derives what the PRODUCT decides — the dose amount
  // (volume with its milligram equivalence), the redose preset, and the pediatric
  // context line — and nothing the PERSON decided.
  function pickFormulation(slug: string) {
    setFormulationSlug(slug);
    const choice = choices.find((c) => c.slug === slug) ?? null;
    setProduct(choice?.product ?? "");
    const preset = formulationRedosePreset(prnDefaults, choice);
    // The amount stays in milligrams; the VOLUME is derived from the product at every
    // display boundary, so a switch re-derives the product and the reader does the rest.
    const mg =
      pediatricResult?.kind === "dose"
        ? pediatricResult.mg
        : (prnDefaults?.adult.doseMgLow ?? null);
    // Everything here follows from the PRODUCT, so it is an offer like any other: the
    // ledger refuses whichever figures the person set themselves, and marks the rest.
    writePrefill(
      offerPrefill({
        ...(preset
          ? {
              minIntervalHours: preset.minIntervalHours,
              maxDailyCount: preset.maxDailyCount,
            }
          : {}),
        ...(mg != null ? { doseAmount: formulationDoseAmount(mg) } : {}),
      })
    );
  }

  // ---- Picks ----
  //
  // ONE RESOLVER FOR THREE VOCABULARIES (#4665). The name field offers medications,
  // supplement catalog entries and the household's bottles; each used to have its own
  // seeding code, and the two that were not `resolveIntakePrefill` wrote values without
  // marking them. Now every arm builds a source and hands it to the one resolver.
  //
  // Generation-guarded because the medication arm awaits its own RxNorm confirm: a
  // second pick during that wait owns the form, and the first must not land on top of it.
  const pickGeneration = useRef(0);

  async function onPickName(picked: string, query?: string) {
    const generation = ++pickGeneration.current;
    setSelectedPediatricBandMinLbs(null);
    setFormulationSlug("");
    // A BOTTLE row. It seeds the product facts the pool is authoritative for, rides as
    // supply_id on this item's own save. The locked door filters the bottle choices
    // to its own kind before this point.
    const bottle = bottleForOptionLabel(bottles, picked);
    const bottleSeed = bottle ? itemSeedFromPool(bottle) : null;
    const pickedName = bottleSeed ? bottleSeed.name : picked;
    if (bottle) {
      onPickSupply(bottle);
    }
    // A bottle pick answers the strength itself; whatever vocabulary its name also
    // resolves to answers the conventions around it. One source, so one offer (#4608).
    const withBottle = (label: IntakeLabelSource): IntakePrefillSource =>
      bottleSeed
        ? { vocabulary: "bottle", amount: bottleSeed.amount, label }
        : label;

    const supplementEntry = CATALOG_BY_NAME.get(pickedName.toLowerCase());
    if (
      supplementEntry &&
      (bottle ? lockedKind === "supplement" : !getMedicationInfo(pickedName))
    ) {
      setName(pickedName);
      seedFromPick(
        withBottle({ vocabulary: "catalog", entry: supplementEntry })
      );
      return;
    }

    const resolved = resolveMedicationPick(
      pickedName,
      bottle ? undefined : query
    );
    const generic = bottle ? pickedName : resolved.name || pickedName;
    setName(generic);
    setProduct("");
    if (resolved.brand) setBrand(resolved.brand);

    // ONE PRN resolution per name resolution, from the code THIS pick confirmed. It
    // used to be resolved here from `rx.rxcui` as it stood before the pick — a value the
    // confirm had not produced yet — and resolved again by the `prnDefaults` memo once
    // it landed: two computations of one fact, one of them reading a stale code (#4665).
    const confirmed = await rx.autoConfirm(generic);
    if (pickGeneration.current !== generation) return;
    seedFromPick(
      withBottle({
        vocabulary: "medication",
        info: getMedicationInfo(generic),
        prn: prnDefaultsFor({
          name: generic,
          rxcui: confirmed?.rxcui ?? null,
          rxcuiIngredients: confirmed?.rxcuiIngredients ?? null,
        }),
      })
    );
  }

  // What a pick writes, once the ledger has said which parts of the offer it may.
  function seedFromPick(source: IntakePrefillSource) {
    const pf = resolveIntakePrefill({
      source,
      pediatric: pediatricContext,
      ledger: ledgerRef.current,
    });
    setLedger(pf.ledger);
    writePrefill(pf.writes);
    setBrandNarrowing(
      pf.brandSuggestions.length
        ? medicationBrandOptions(pf.brandSuggestions)
        : null
    );
    // The label's food relationship arrives as a SUGGESTED rule — an offer that
    // renders marked and deletable, never a silent write (#1505). A pick that states
    // none clears the previous pick's offer rather than leaving it standing.
    setRules((current) => [
      ...current.filter((r) => !(r.type === "food" && r.suggested)),
      ...suggestedRulesForFoodTiming(pf.writes.foodTiming ?? null),
    ]);
    // A catalogued blend's label composition (#2856). The repeater owns these rows, so
    // they are seeded only into an empty list — the person's own rows are never replaced.
    if (pf.ingredients.length > 0 && ingredientsAreEmpty(ingredients)) {
      setIngredients(pf.ingredients);
      setIngredientSeedNote(pf.ingredientNote);
    }
  }

  // Picking a shared bottle (#1705), promoted from the refill fold to the front door:
  // it seeds the product facts the pool is authoritative for, rides as `supply_id` on
  // this item's own save. The door's locked kind already scoped which bottles were
  // offered, so a bottle never changes the form's kind.
  function onPickSupply(supply: SupplyOption | null): void {
    const seed = supply ? itemSeedFromPool(supply) : null;
    const previous = seededRef.current;
    // The NAME is product identity rather than a label figure, so it keeps the pool's
    // own previous-seed rule; the STRENGTH is an offer about a dose, so it goes through
    // the ledger with every other offer and is marked like every other offer.
    setName((current) =>
      applyProductSeed(current, previous?.name ?? null, seed?.name ?? "")
    );
    if (seed) {
      writePrefill(offerPrefill({ doseAmount: seed.amount }));
    } else if (ledgerRef.current.suggested.has("doseAmount")) {
      // Unlinked: the bottle that stated this strength is gone, so the offer goes with
      // it. A figure the person typed is theirs and is never withdrawn.
      setDoses((ds) => ds.map((d, i) => (i === 0 ? { ...d, amount: "" } : d)));
      setLedger(withdrawPrefill(ledgerRef.current, "doseAmount"));
    }
    onLinkSupply(supply);
    seededRef.current = seed;
  }

  function onLinkSupply(supply: SupplyOption | null): void {
    setSupplyId(supply ? String(supply.id) : "");
    setSupplyLabel(supply?.name ?? null);
    if (supply && !bottles.some((option) => option.id === supply.id))
      setBottles([...bottles, supply]);
  }

  function selectPediatricBand(band: PediatricBand) {
    setSelectedPediatricBandMinLbs(band.minLbs);
    markTouched("doseAmount");
    setDoses((current) =>
      current.map((dose, index) =>
        index === 0 ? { ...dose, amount: formulationDoseAmount(band.mg) } : dose
      )
    );
  }

  // ---- The rule sentences decide the fields they own ----
  const ruleFields = useMemo(() => fieldsFromRules(rules), [rules]);
  const effectiveCondition = ruleFields.condition ?? condition;

  // ---- The state the mapping posts ----
  // Memoized because it IS the draft (#1699): a new object every render would rewrite
  // the local draft on every render rather than on every change.
  const formState: IntakeItemFormState = useMemo(
    () => ({
      id: s?.id ?? null,
      kind,
      name,
      brand,
      product,
      stack,
      condition: effectiveCondition,
      situation: ruleFields.situation,
      pauseSituation: ruleFields.pauseSituation,
      obligation,
      critical,
      escalateAfterMin,
      escalateChatId,
      minIntervalHours,
      maxDailyCount,
      maxDailyAmountMg,
      redoseNotice,
      rx: rxFlag,
      prescriber,
      pharmacy,
      rxNumber,
      provider,
      providerId: s?.provider_id ?? null,
      providerLoaded: s?.provider_name ?? "",
      indicationConditionId,
      startedOn,
      endDate,
      courseId: course?.id ?? null,
      cadence,
      doses: doses.map((d) => ({
        ...d,
        food_timing: ruleFields.foodTiming ?? "any",
      })),
      pairs: ruleFields.pairs,
      ingredients,
      purposes,
      notes,
      rxcui: rx.rxcui,
      rxcuiIngredients: rx.rxcuiIngredients ?? [],
      quantityOnHand,
      qtyPerDose,
      quantityOnHandLoaded:
        s?.quantity_on_hand != null
          ? String(Math.max(0, s.quantity_on_hand))
          : "",
      supplyId,
    }),
    [
      s,
      kind,
      name,
      brand,
      product,
      stack,
      effectiveCondition,
      ruleFields,
      obligation,
      critical,
      escalateAfterMin,
      escalateChatId,
      minIntervalHours,
      maxDailyCount,
      maxDailyAmountMg,
      redoseNotice,
      rxFlag,
      prescriber,
      pharmacy,
      rxNumber,
      provider,
      indicationConditionId,
      startedOn,
      endDate,
      course,
      cadence,
      doses,
      ingredients,
      purposes,
      notes,
      rx.rxcui,
      rx.rxcuiIngredients,
      quantityOnHand,
      qtyPerDose,
      supplyId,
    ]
  );

  // Which FACT each still-suggested field belongs to, so the chip carries the #846
  // marking the old always-visible inputs carried on their labels.
  const suggestedFacts = useMemo(() => {
    const out = new Set<IntakeFactKey>();
    for (const field of ledger.suggested) {
      if (field === "doseAmount") out.add("dose");
      else if (field === "asNeeded") out.add("importance");
      else out.add("timing");
    }
    return out;
  }, [ledger]);

  const summary = intakeFactSummary({
    kind,
    amount: doses[0]?.amount ?? "",
    formulationLabel: activeChoice?.pediatric ? activeChoice.label : "",
    extraDoses: doses.slice(1).map((d) => ({
      amount: d.amount,
      timeOfDay: d.time_of_day,
    })),
    firstDoseTimeOfDay: doses[0]?.time_of_day ?? "",
    obligation,
    critical,
    minIntervalHours,
    maxDailyCount,
    maxDailyAmountMg,
    cadenceSentence: cadenceLabel({
      cadence_kind: cadence.kind,
      cadence_weekdays: cadence.weekdays.join(","),
      cadence_interval_days: cadence.intervalDays
        ? Number(cadence.intervalDays)
        : null,
      cadence_anchor_date: cadence.anchorDate,
    }),
    rx: rxFlag,
    prescriber,
    indication:
      conditions.find((c) => String(c.id) === indicationConditionId)?.name ??
      "",
    brand,
    product,
    stack,
    supplyLabel,
    quantityOnHand,
    stopDate: endDate,
    ingredientCount: ingredients.filter((g) => g.name.trim()).length,
    purposeSummary,
    notes,
    rules,
    itemNames,
    suggestedFacts,
  });

  // ---- Draft (#1699) ----
  const draftExtra = useMemo(
    () => ({ state: formState, rules, formulationSlug }),
    // The whole posted state is the draft, so one dependency is honest: any change
    // to any fact rewrites it.
    [formState, rules, formulationSlug]
  );
  type IntakeDraft = typeof draftExtra;
  const draft = useFormDraft<IntakeDraft>({
    formKey: isMed ? "medication" : "supplement",
    recordId: s?.id ?? null,
    formRef,
    extra: draftExtra,
    onRestore: (d) => {
      const v = d.state;
      setName(v.name);
      setBrand(v.brand);
      setProduct(v.product);
      setStack(v.stack);
      setCondition(v.condition);
      setObligationState(v.obligation);
      setCritical(v.critical);
      setEscalateAfterMin(v.escalateAfterMin);
      setEscalateChatId(v.escalateChatId);
      setMinIntervalHours(v.minIntervalHours);
      setMaxDailyCount(v.maxDailyCount);
      setMaxDailyAmountMg(v.maxDailyAmountMg);
      setRedoseNotice(v.redoseNotice);
      setRxFlag(v.rx);
      setPrescriber(v.prescriber);
      setPharmacy(v.pharmacy);
      setRxNumber(v.rxNumber);
      setProvider(v.provider);
      setIndicationConditionId(v.indicationConditionId);
      setStartedOn(v.startedOn);
      setEndDate(v.endDate);
      setNotes(v.notes);
      setQuantityOnHand(v.quantityOnHand);
      setQtyPerDose(v.qtyPerDose);
      setSupplyId(v.supplyId);
      setCadence(v.cadence);
      setDoses(v.doses);
      setIngredients(v.ingredients);
      setPurposes(v.purposes);
      setRules(d.rules ?? []);
      setFormulationSlug(d.formulationSlug ?? "");
    },
    confirmReplace: () =>
      confirm({
        title: "Resume the unsaved entry?",
        message:
          "This replaces what you have typed here with the entry kept on this device.",
        confirmLabel: "Resume",
      }),
  });

  async function handle() {
    setError(null);
    const label = name.trim() || (isMed ? "Medication" : "Supplement");
    const pause = ruleFields.pauseSituation.trim();
    if (
      pause &&
      pause !== (s?.pause_situation ?? "") &&
      pauseLinkNeedsConfirm({ kind, obligation })
    ) {
      const ok = await confirm({
        title: "Pause reminders?",
        message: `This will silence reminders for ${label} while ${pause} is active. Link the pause?`,
        confirmLabel: "Link pause",
      });
      if (!ok) return;
    }
    // The med guardrail (#1505 Part 0), unchanged: consent is owed for LOSING a
    // safety net you had, so it is asked only when an EXISTING must medication is
    // moved down — never for a new declaration, never on an unrelated edit.
    const wasMust = s != null && (s.obligation ?? "must") === "must";
    if (isMed && obligation !== "must" && wasMust) {
      const ok = await confirm({
        title: `Reduce reminders for ${label}?`,
        message:
          obligation === "may"
            ? `${label} will get no reminders, no missed-dose escalation, and no missed-dose safety net. It stays on your list and one tap away when you want it. Continue?`
            : `${label} will still be reminded and still counted, but it loses missed-dose escalation — no follow-up nudge if a dose goes unconfirmed, no caregiver alert. Continue?`,
        confirmLabel: "Reduce reminders",
      });
      if (!ok) return;
    }

    let result: FormResult;
    try {
      result = await action(intakeItemFormData(formState));
    } catch {
      setError("Couldn't save this. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    draft.clear();
    toast(s ? `${label} updated` : `${label} added`);
    if (onDone) return onDone();
    reset();
  }

  function reset() {
    formRef.current?.reset();
    setName("");
    rx.reset();
    setBrand("");
    setBrandNarrowing(null);
    setProduct("");
    setStack("");
    setCondition("daily");
    setObligationState(affordances.defaultObligation);
    setCritical(false);
    setEscalateAfterMin("");
    setEscalateChatId("");
    setMinIntervalHours("");
    setMaxDailyCount("");
    setMaxDailyAmountMg("");
    setRedoseNotice(false);
    setRxFlag(false);
    setPrescriber("");
    setPharmacy("");
    setRxNumber("");
    setProvider("");
    setIndicationConditionId("");
    setStartedOn(todayStr ?? "");
    setStartedOnTouched(false);
    setEndDate("");
    setNotes("");
    setQuantityOnHand("");
    setQtyPerDose("1");
    setSupplyId("");
    setSupplyLabel(null);
    setFormulationSlug("");
    setSelectedPediatricBandMinLbs(null);
    setIngredients([]);
    setIngredientSeedNote(null);
    setDoses([emptyDose()]);
    setCadence(emptyIntakeCadence());
    setRules([]);
    setLedger(emptyPrefillLedger());
    closePanel();
  }

  // Bottles lead: a bottle the household already has is a more specific answer than a
  // vocabulary entry with the same name, and it is the one that carries a count.
  //
  // BOTH HALVES OF THIS LIST ANSWER TO THE DOOR (#3270). The catalog half always did;
  // the bottle half did not, so the Add supplement door listed the household's
  // medications and picking one wrote a supplement named Ibuprofen — a locked door
  // cannot be corrected, so nothing asked and nothing showed. `bottleFitsKindDoor`
  // holds the rule and the no-sibling ruling.
  const nameOptions = useMemo(
    () => [
      ...(s ? [] : bottles.map(bottleOptionLabel)),
      ...catalogOptions[
        affordances.catalogSource === "supplement"
          ? "supplements"
          : "medications"
      ],
    ],
    [s, bottles, catalogOptions, affordances.catalogSource]
  );

  const ingredientNames = useMemo(
    () => ingredients.map((g) => g.name.trim()).filter((n) => n.length > 0),
    [ingredients]
  );

  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onFormKeyDown}
      data-testid="intake-item-form"
      data-kind={kind}
      className="grid gap-4 sm:grid-cols-2"
    >
      <DraftRestoreBanner
        draft={draft}
        noun={isMed ? "medication" : "supplement"}
        className="sm:col-span-2"
      />

      <div className="sm:col-span-2">
        <label className="label" htmlFor={`intake-name-${fid}`}>
          Name
        </label>
        <IntakeItemCombobox
          id={`intake-name-${fid}`}
          ariaLabel="Name"
          value={name}
          onChange={(v) => {
            if (v !== name) {
              setFormulationSlug("");
              setSelectedPediatricBandMinLbs(null);
            }
            setName(v);
            rx.onNameChange();
          }}
          onPick={onPickName}
          options={nameOptions}
          placeholder={affordances.namePlaceholder}
        />
        <RxNormAffordance name={name} rx={rx} />
        {isChildProfile && name.trim() && isMed && !prnDefaults?.pediatric ? (
          <p
            data-testid="medication-pediatric-no-chart"
            className="mt-1 text-xs text-slate-500 dark:text-slate-400"
          >
            No pediatric label weight-band chart is available for this
            medication.
          </p>
        ) : null}
        {medInfo && (
          <dl
            data-testid="medication-info-preview"
            className="mt-3 space-y-1 text-sm"
          >
            <div>
              <dt className="section-label">Category</dt>
              <dd className="mt-0.5 font-medium text-slate-700 dark:text-slate-200">
                {medInfo.drug_class ?? "Medication"}
              </dd>
            </div>
            <div>
              <dt className="section-label">Description</dt>
              <dd className="mt-0.5 leading-relaxed text-slate-500 dark:text-slate-400">
                {medInfo.description}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {choices.length > 0 && (
        <div
          data-testid="intake-formulation-row"
          className="flex flex-wrap items-center gap-1.5 sm:col-span-2"
        >
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Form
          </span>
          <FilterPills
            mode="button"
            layout="wrap"
            label="Form"
            value={activeSlug}
            onSelect={pickFormulation}
            options={choices.map((choice) => ({
              value: choice.slug,
              label: choice.label,
              testId: "intake-formulation-choice",
              data: {
                "data-slug": choice.slug || DEFAULT_FORMULATION_SLUG,
              },
            }))}
          />
        </div>
      )}

      {pediatricContextLine(activeChoice, isChildProfile) && (
        <p
          data-testid="intake-pediatric-context"
          className="text-xs text-slate-500 sm:col-span-2 dark:text-slate-400"
        >
          {pediatricContextLine(activeChoice, isChildProfile)}
        </p>
      )}

      {/* Safety surfacing never drops: the stack-interaction, PGx and food notices
          render as a passive line before Save, whichever editor is open. */}
      <IntakeInteractionNotices
        name={name}
        ingredientNames={ingredientNames}
        rxcui={rx.rxcui}
        rxcuiIngredients={rx.rxcuiIngredients}
        stackItems={stackItems}
        pgxVariants={pgxVariants}
        excludeId={s?.id}
        age={pediatricAgeYears(pediatricContext)}
      />

      {openPanel == null ? (
        <IntakeFactRow
          summary={summary}
          openEditor={openPanel}
          onOpen={(key, focusKey) => {
            setRulesStartOnMenu(false);
            setOpenPanel(key, focusKey);
          }}
          onAddRule={(focusKey) => {
            setRulesStartOnMenu(true);
            setOpenPanel("rules", focusKey);
          }}
          onRemoveRule={(id) =>
            setRules((current) => current.filter((r) => r.id !== id))
          }
        />
      ) : (
        <FactEditorHost
          testId="intake-editor"
          doneTestId="intake-editor-done"
          panel={openPanel}
          onDone={closePanel}
          className="sm:col-span-2"
          bodyClassName="grid gap-4 sm:grid-cols-2"
        >
          {renderPanel()}
        </FactEditorHost>
      )}

      {error && (
        <p
          role="alert"
          className="text-sm text-rose-600 sm:col-span-2 dark:text-rose-400"
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 sm:col-span-2">
        <SubmitButton pendingLabel="Saving…" variant="primary">
          {s ? "Save" : "Add"}
        </SubmitButton>
        {onDone && (
          <button type="button" onClick={onDone} className="btn-ghost">
            Cancel
          </button>
        )}
      </div>
    </form>
  );

  function renderPanel() {
    switch (openPanel) {
      case "dose":
        return (
          <>
            {pediatricResult && pediatricResult.kind !== "no-pediatric" && (
              <section
                data-testid="pediatric-suggestion"
                className="text-sm sm:col-span-2"
              >
                <p className="font-semibold">
                  Pediatric label dose — {prnDefaults?.label}
                </p>
                {pediatricResult.kind === "ask-doctor" && (
                  <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                    {pediatricResult.reason}
                  </p>
                )}
                {pediatricResult.kind === "need-weight" && (
                  <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                    Enter a current weight to match the package label’s weight
                    band.
                  </p>
                )}
                {pediatricResult.kind === "stale-weight" && (
                  <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                    The latest recorded weight is over{" "}
                    {pediatricResult.thresholdDays} days old. Enter a current
                    weight before using a weight band.
                  </p>
                )}
                {pediatricResult.kind === "below-weight-band" && (
                  <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                    Recorded weight is {pediatricResult.weightLbs} lb. The
                    available package-label chart starts at{" "}
                    {pediatricResult.minimumLbs} lb, so no dose band is
                    suggested. Check the product label and ask a clinician or
                    pharmacist before use.
                  </p>
                )}
                {pediatricContext && (
                  <PediatricWeightUpdate
                    idPrefix={`pediatric-${fid}`}
                    context={pediatricContext}
                    initiallyOpen={
                      pediatricResult.kind === "need-weight" ||
                      pediatricResult.kind === "stale-weight"
                    }
                    onSaved={(next) => {
                      setPediatricContext(next);
                      setSelectedPediatricBandMinLbs(null);
                      // A new weight re-derives the label's OFFER, never the
                      // caregiver's own number. An untouched suggestion follows the
                      // new band — and is CLEARED when the new weight has no band,
                      // because leaving the old weight's figure standing would be a
                      // dose attributed to a measurement that no longer supports it.
                      if (!prnDefaults) return;
                      const nextResult = pediatricDoseSuggestion({
                        entry: prnDefaults,
                        ageMonths: next.ageMonths as number,
                        weightKg: next.weightKg,
                        weightDate: next.weightDate,
                        today: next.today,
                        formulationSlug: activeSlug || null,
                      });
                      // The ledger refuses a figure the caregiver typed. The extra
                      // empty-check is the one thing it cannot answer: a stored row's
                      // amount is neither offered nor marked touched, and a new weight
                      // must not rewrite what was already saved.
                      const offered =
                        ledgerRef.current.suggested.has("doseAmount");
                      if (
                        nextResult.kind === "dose" &&
                        (offered || !doses[0]?.amount.trim())
                      ) {
                        writePrefill(
                          offerPrefill({
                            doseAmount: formulationDoseAmount(nextResult.mg),
                          })
                        );
                      } else if (nextResult.kind !== "dose" && offered) {
                        setDoses((current) =>
                          current.map((dose, index) =>
                            index === 0 ? { ...dose, amount: "" } : dose
                          )
                        );
                        setLedger(
                          withdrawPrefill(ledgerRef.current, "doseAmount")
                        );
                      }
                    }}
                  />
                )}
                {(pediatricResult.kind === "dose" ||
                  pediatricResult.kind === "below-weight-band") && (
                  <PediatricDoseBandPicker
                    idPrefix={`pediatric-${fid}`}
                    result={pediatricResult}
                    bands={prnDefaults?.pediatric?.bands ?? []}
                    formulations={prnDefaults?.pediatric?.formulations ?? []}
                    formulationSlug={activeSlug}
                    today={pediatricContext?.today ?? todayStr ?? ""}
                    selectedBandMinLbs={selectedPediatricBandMinLbs}
                    currentAmount={doses[0]?.amount ?? ""}
                    onBandSelect={selectPediatricBand}
                    onFormulationChange={pickFormulation}
                    hideFormulationSelect
                  />
                )}
              </section>
            )}
            <DoseRowsEditor
              doses={doses}
              setDoses={(update) => {
                // Any hand edit protects the dose-derived fields from a LATER pick.
                markTouched("doseAmount", "timeOfDay");
                setSelectedPediatricBandMinLbs(null);
                setDoses(update);
              }}
              dosageOptions={[...dosageOptions]}
              amountPlaceholder={isMed ? "e.g. 200 mg" : "amount"}
              singleAmountOnly={obligation === "may"}
              hideFoodTiming
            />
            {s && (
              <RetiredDoses
                doses={retiredDoses}
                onRestored={(d) => setDoses((ds) => [...ds, d])}
              />
            )}
          </>
        );

      case "timing":
        return (
          <>
            {affordances.conditions.length > 1 && !isMed && (
              <div>
                <label className="label" htmlFor={`intake-when-${fid}`}>
                  When
                </label>
                <select
                  id={`intake-when-${fid}`}
                  value={
                    effectiveCondition === "situational"
                      ? "daily"
                      : effectiveCondition
                  }
                  onChange={(e) =>
                    setCondition(e.target.value as IntakeCondition)
                  }
                  className="input"
                >
                  {affordances.conditions
                    .filter((c) => c !== "situational")
                    .map((c) => (
                      <option key={c} value={c}>
                        {CONDITION_LABELS[c]}
                      </option>
                    ))}
                </select>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Only on certain days? Add a “Take only when…” rule instead.
                </p>
              </div>
            )}
            <CadenceEditor value={cadence} onChange={setCadence} />
            {affordances.redose && obligation === "may" && (
              <div
                data-testid="redose-block"
                className="sm:col-span-2 border-t border-black/5 pt-4 dark:border-white/5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    Redose reminder (optional)
                  </div>
                  {redoseDefaults && (
                    <button
                      type="button"
                      data-testid="redose-prefill"
                      className="btn-ghost btn-sm"
                      onClick={() => {
                        setMinIntervalHours(
                          String(redoseDefaults.minIntervalHours)
                        );
                        setMaxDailyCount(String(redoseDefaults.maxDailyCount));
                        markTouched("minIntervalHours", "maxDailyCount");
                      }}
                    >
                      <span className="block">Use label defaults</span>
                      <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
                        {redoseDefaults.minIntervalHours} hours · maximum{" "}
                        {redoseDefaults.maxDailyCount} doses/day
                      </span>
                    </button>
                  )}
                </div>
                {/* One-line explainer (#851 item 5); the fuller confirm-discipline
                    text lives behind the disclosure. A <details> can't nest in a <p>. */}
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Reminds you when the minimum interval has passed — set from
                  the label.
                </p>
                <Disclosure className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  <summary className="cursor-pointer text-brand-700 hover:underline dark:text-brand-400">
                    How it works
                  </summary>
                  <p className="mt-1">
                    After a dose is logged you get a one-time reminder when the
                    minimum interval passes (e.g. {`"`}6h since Ibuprofen — 2 of
                    4 in 24h{`"`}). These are YOUR confirmed numbers —
                    pre-filled from the label as a suggestion, never applied on
                    their own; leave them blank for no reminder.
                    {prnDefaults && ` Label source: ${prnDefaults.source}.`}
                  </p>
                </Disclosure>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor={`redose-interval-${fid}`}>
                      Minimum hours between doses
                    </label>
                    <input
                      id={`redose-interval-${fid}`}
                      data-testid="redose-interval"
                      type="number"
                      min={0}
                      step="any"
                      value={minIntervalHours}
                      onChange={(e) => {
                        setMinIntervalHours(e.target.value);
                        markTouched("minIntervalHours");
                      }}
                      className="input"
                      placeholder="e.g. 6"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor={`redose-max-${fid}`}>
                      Maximum doses in 24 hours
                    </label>
                    <input
                      id={`redose-max-${fid}`}
                      data-testid="redose-max"
                      type="number"
                      min={1}
                      step={1}
                      value={maxDailyCount}
                      onChange={(e) => {
                        setMaxDailyCount(e.target.value);
                        markTouched("maxDailyCount");
                      }}
                      className="input"
                      placeholder="e.g. 4"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor={`redose-max-mg-${fid}`}>
                      Maximum mg in 24 hours
                    </label>
                    <input
                      id={`redose-max-mg-${fid}`}
                      data-testid="redose-max-mg"
                      type="number"
                      min={0}
                      step="any"
                      value={maxDailyAmountMg}
                      onChange={(e) => setMaxDailyAmountMg(e.target.value)}
                      className="input"
                      placeholder="e.g. 1200"
                    />
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Sums the logged dose amounts across same-ingredient items;
                      leave blank to count doses instead.
                    </p>
                  </div>
                </div>
                <label className="mt-3 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    data-testid="redose-optin"
                    checked={redoseNotice}
                    onChange={(e) => setRedoseNotice(e.target.checked)}
                    className="h-4 w-4 rounded-sm border-slate-300 text-brand-600 dark:border-slate-600"
                  />
                  Remind me when the redose window opens
                </label>
                <p className="mt-1 pl-6 text-xs text-slate-500 dark:text-slate-400">
                  Requires both interval and maximum-dose fields above.
                </p>
              </div>
            )}
          </>
        );

      case "rules":
        return (
          // `min-w-0` releases this grid item's content floor, and it is load-bearing
          // rather than decorative (#3631). The rules editor renders a `select` of
          // ITEM NAMES — unbounded by anything the page controls — and a grid item's
          // `min-width: auto` resolves to its CONTENT minimum, so the track widened to
          // the widest option and nothing downstream could shrink it. Measured at
          // 390px with a 63-character imported name: the select rendered 476px wide,
          // 119px past the viewport, WITH `min-w-0` already on the select itself.
          // #3478's fix on the control is necessary and was not sufficient here; the
          // guard is in e2e/dose-ledger-phone.mobile.spec.ts.
          <div className="min-w-0 sm:col-span-2">
            <IntakeRulesEditor
              key={rulesStartOnMenu ? "add" : "edit"}
              rules={rules}
              setRules={setRules}
              others={others}
              startOnMenu={rulesStartOnMenu}
            />
          </div>
        );

      case "importance":
        return (
          <>
            <div className="sm:col-span-2">
              <label className="label" htmlFor={`intake-obligation-${fid}`}>
                Obligation
              </label>
              <select
                id={`intake-obligation-${fid}`}
                data-testid="intake-obligation"
                value={obligation}
                onChange={(e) => {
                  setObligation(e.target.value as IntakeObligation);
                  markTouched("asNeeded");
                }}
                className="input"
              >
                {OBLIGATIONS.map((o) => (
                  <option key={o} value={o}>
                    {OBLIGATION_LABELS[o]}
                  </option>
                ))}
              </select>
              <p
                className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                data-testid="intake-obligation-hint"
              >
                {OBLIGATION_HINTS[obligation]}
              </p>
            </div>
            <CriticalEscalation
              fid={fid}
              critical={critical}
              setCritical={setCritical}
              escalateAfterMin={escalateAfterMin}
              setEscalateAfterMin={setEscalateAfterMin}
              escalateChatId={escalateChatId}
              setEscalateChatId={setEscalateChatId}
            />
          </>
        );

      case "prescription":
        return affordances.prescription ? (
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                data-testid="rx-toggle"
                checked={rxFlag}
                onChange={(e) => setRxFlag(e.target.checked)}
                className="h-4 w-4 rounded-sm border-slate-300 text-brand-600 dark:border-slate-600"
              />
              Prescription medication
            </label>
            {rxFlag && (
              <div
                data-testid="prescription-fields"
                className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                <div>
                  <label className="label" htmlFor={`med-prescriber-${fid}`}>
                    Prescriber
                  </label>
                  <input
                    id={`med-prescriber-${fid}`}
                    value={prescriber}
                    onChange={(e) => setPrescriber(e.target.value)}
                    className="input"
                    placeholder="e.g. Dr. Rivera"
                  />
                </div>
                <div>
                  <label className="label" htmlFor={`med-pharmacy-${fid}`}>
                    Pharmacy
                  </label>
                  <input
                    id={`med-pharmacy-${fid}`}
                    value={pharmacy}
                    onChange={(e) => setPharmacy(e.target.value)}
                    className="input"
                    placeholder="e.g. Walgreens #1234"
                  />
                </div>
                <div>
                  <label className="label" htmlFor={`med-rx-${fid}`}>
                    Rx number
                  </label>
                  <input
                    id={`med-rx-${fid}`}
                    value={rxNumber}
                    onChange={(e) => setRxNumber(e.target.value)}
                    className="input"
                    placeholder="e.g. RX7654321"
                  />
                </div>
                <div>
                  <label className="label" htmlFor={`med-provider-${fid}`}>
                    Provider / pharmacy
                  </label>
                  <ProviderCombobox
                    id={`med-provider-${fid}`}
                    name="provider"
                    ariaLabel="Provider / pharmacy"
                    defaultValue={s?.provider_name ?? ""}
                    onChange={setProvider}
                    placeholder="e.g. Sample Care East"
                  />
                </div>
              </div>
            )}
          </div>
        ) : null;

      case "indication":
        return affordances.indication ? (
          <div className="sm:col-span-2">
            <label className="label" htmlFor={`med-indication-${fid}`}>
              For condition
            </label>
            <select
              id={`med-indication-${fid}`}
              value={indicationConditionId}
              onChange={(e) => setIndicationConditionId(e.target.value)}
              className="input"
              data-testid="med-indication-picker"
            >
              <option value="">—</option>
              {conditions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ) : null;

      case "identity":
        return (
          <>
            <div>
              <label className="label" htmlFor={`intake-brand-${fid}`}>
                Brand
              </label>
              <IntakeItemCombobox
                id={`intake-brand-${fid}`}
                ariaLabel="Brand"
                value={brand}
                onChange={setBrand}
                options={[...brandOptions]}
                placeholder={affordances.brandPlaceholder}
              />
            </div>
            {affordances.stack && (
              <>
                <div>
                  <label className="label" htmlFor={`intake-product-${fid}`}>
                    Product
                  </label>
                  <input
                    id={`intake-product-${fid}`}
                    value={product}
                    onChange={(e) => setProduct(e.target.value)}
                    className="input"
                    placeholder="e.g. Vitamin D/K2"
                  />
                </div>
                <div>
                  <label className="label" htmlFor={`intake-stack-${fid}`}>
                    Stack (optional)
                  </label>
                  {/* The stack field joins the vocabulary substrate (#3100). Stacks
                      cluster by EXACT STRING everywhere they are read, so a bare
                      input meant "AM stack" and "AM Stack" were two clusters and
                      nothing said so. The list is the profile's OWN stack names,
                      resolved once by getIntakeCatalogOptions like every other
                      intake vocabulary (#221) — never a second query from here.
                      Free text stays on: a new stack is one keystroke away, the
                      vocabulary suggests and never gates (#1676). */}
                  <IntakeItemCombobox
                    id={`intake-stack-${fid}`}
                    ariaLabel="Stack (optional)"
                    value={stack}
                    onChange={setStack}
                    options={catalogOptions.stacks}
                    placeholder="e.g. D3 + K2"
                  />
                </div>
              </>
            )}
          </>
        );

      case "supply":
        return (
          <RefillTracking
            fid={fid}
            item={s}
            bottles={bottles}
            supplyId={supplyId}
            supplyName={supplyLabel}
            onPickSupply={s ? onLinkSupply : onPickSupply}
            quantityOnHand={quantityOnHand}
            setQuantityOnHand={setQuantityOnHand}
            qtyPerDose={qtyPerDose}
            setQtyPerDose={setQtyPerDose}
          />
        );

      case "stopDate":
        return (
          <>
            <div>
              <label className="label" htmlFor={`intake-started-on-${fid}`}>
                {obligation === "may" ? "Using since" : "Started on"}
                {obligation === "may" && (
                  <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">
                    (optional)
                  </span>
                )}
              </label>
              <DateField
                id={`intake-started-on-${fid}`}
                value={startedOn}
                onChange={(value) => {
                  setStartedOn(value);
                  setStartedOnTouched(true);
                }}
                max={todayStr}
                required={obligation !== "may"}
              />
              {obligation === "may" && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Leave blank if you don’t know when you started using it.
                </p>
              )}
            </div>
            {s && (
              <div>
                <label className="label" htmlFor={`intake-ended-on-${fid}`}>
                  Stop date (optional)
                </label>
                <DateField
                  id={`intake-ended-on-${fid}`}
                  value={endDate}
                  onChange={setEndDate}
                  min={startedOn || undefined}
                  max={todayStr}
                  data-testid="med-end-date"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Set the day you stopped to move it to Past. Clear it to make
                  it active again.
                </p>
              </div>
            )}
          </>
        );

      case "composition":
        return affordances.composition ? (
          <div className="sm:col-span-2">
            {ingredients.length === 0 ? (
              <button
                type="button"
                data-testid="add-ingredients"
                onClick={() => setIngredients([emptyIngredient()])}
                className="btn-ghost btn-sm"
              >
                List what&apos;s in this
              </button>
            ) : (
              <IngredientsEditor
                rows={ingredients}
                setRows={setIngredients}
                seedNote={ingredientSeedNote}
              />
            )}
          </div>
        ) : null;

      case "purpose":
        return (
          <PurposesEditor
            rows={purposes}
            setRows={setPurposes}
            name={name}
            ingredientNames={ingredientNames}
            conditions={conditions}
            biomarkers={biomarkers}
            fid={fid}
          />
        );

      case "notes":
        return <IntakeNotesField fid={fid} value={notes} onChange={setNotes} />;

      case "more":
        return (
          <div className="flex flex-wrap gap-1.5 sm:col-span-2">
            {summary.more.map((key) => (
              <button
                key={key}
                type="button"
                data-testid={`intake-more-${key}`}
                onClick={() => setOpenPanel(key)}
                className="min-h-11 rounded-full border border-(--border) px-3 py-1.5 text-sm transition hover:bg-(--ghost-hover)"
              >
                {INTAKE_FACT_NOUNS[key]}
              </button>
            ))}
          </div>
        );

      default:
        return null;
    }
  }
}

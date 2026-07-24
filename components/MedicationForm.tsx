"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SupplementCombobox from "@/components/SupplementCombobox";
import Combobox from "@/components/Combobox";
import ProviderCombobox from "@/components/ProviderCombobox";
import { useSituationOptions } from "@/components/SituationOptionsContext";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import RxNormAffordance from "@/components/intake/RxNormAffordance";
import IntakeInteractionNotices from "@/components/intake/IntakeInteractionNotices";
import DoseRowsEditor, {
  emptyDose,
  type DoseState,
} from "@/components/intake/DoseRowsEditor";
import KeepApartPairsEditor, {
  type PairState,
} from "@/components/intake/KeepApartPairsEditor";
import CriticalEscalation from "@/components/intake/CriticalEscalation";
import RefillTracking from "@/components/intake/RefillTracking";
import IntakeNotesField from "@/components/intake/IntakeNotesField";
import PediatricDoseBandPicker from "@/components/medications/PediatricDoseBandPicker";
import PediatricWeightUpdate from "@/components/medications/PediatricWeightUpdate";
import { useIntakeRxcui } from "@/components/intake/useIntakeRxcui";
import { serializeRxcuiIngredients } from "@/lib/rxnorm";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import {
  medicationCatalogOptions,
  medicationBrandOptions,
  resolveMedicationPick,
  getMedicationInfo,
} from "@/lib/medication-info";
import { prnDefaultsFor, redoseLabelDefaults } from "@/lib/prn-defaults";
import type { PediatricBand } from "@/lib/datasets/prn-defaults";
import {
  formulationForSlug,
  formulationSlugForProduct,
  PEDIATRIC_MAX_AGE_MONTHS,
  pediatricDoseSuggestion,
  type PediatricFormContext,
} from "@/lib/prn-dosing";
import { resolveIntakePrefill, type PrefillField } from "@/lib/intake-prefill";
import { CONDITION_LABELS } from "@/lib/supplement-schedule";
import type {
  FormResult,
  Supplement,
  SupplementDose,
  SupplementPair,
  MedicationCourse,
} from "@/lib/types";

// The medication name combobox source (#817): generics + brand names from the curated
// medication-descriptions set, so adding a med suggests "Ibuprofen"/"Advil" — not the
// supplement catalog. The RxNorm lookup stays the long tail for anything unlisted.
// One combobox option per medication, "Generic (Brand, Brand)" (#851 item 14) — the
// brands ride in the label so a typed brand token still filters to the entry.
const MED_CATALOG_OPTIONS = medicationCatalogOptions();
// Brand suggestions with "Generic" first (#851 item 3); narrowed to a picked med's own
// brands by the prefill resolver.
const MED_BRAND_OPTIONS = medicationBrandOptions();
// A medication's condition is either scheduled (daily) or context-gated (situational);
// the workout/rest-day scheduling is a SUPPLEMENT concept and lives only on the
// supplement form. PRN is the separate `as_needed` toggle below.
const MED_CONDITIONS: Supplement["condition"][] = ["daily", "situational"];

function savedFormulationSlug(s?: Supplement): string {
  if (!s?.product) return "";
  const entry = prnDefaultsFor({ name: s.name, rxcui: s.rxcui });
  return formulationSlugForProduct(
    entry?.pediatric?.formulations ?? [],
    s.product
  );
}

// A tiny "from label defaults" marker for a selection-prefilled field (#846) — the
// value is an editable suggestion the datasets supplied, not a stored fact.
function PrefillBadge() {
  return (
    <span
      data-testid="prefill-badge"
      className="ml-2 inline-block rounded bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300"
    >
      from label defaults
    </span>
  );
}

// The medication add/edit form (#846, real split from the former shared
// IntakeItemForm). Owns the medication-shaped surface — the med name combobox (#817) +
// brand suggestions, prescriber/pharmacy/Rx, the PRN toggle + redose-notice + pediatric
// weight-band dosing (#798), the critical flag, dose strengths from OTC label data, and
// SELECTION PREFILL (picking a med fills every knowable field as an editable, marked
// suggestion that never clobbers a touched field). Renders NONE of the supplement
// concepts (no catalog/priority/stack, no workout scheduling); composes the shared
// subcomponents. With no `supplement` it adds; with one it edits and calls `onDone`.
export default function MedicationForm({
  action,
  supplement,
  doses: initialDoses,
  allSupplements = [],
  stackItems = [],
  pgxVariants = [],
  pairs: initialPairs = [],
  onDone,
  pediatric,
  age = null,
  course,
  todayStr,
  conditions = [],
}: {
  action: (formData: FormData) => Promise<FormResult>;
  supplement?: Supplement;
  doses?: SupplementDose[];
  allSupplements?: { id: number; name: string }[];
  // The profile's recorded conditions, for the optional "For condition…" indication
  // picker (#1052). Absent → the picker doesn't render (surfaces that don't thread it).
  conditions?: { id: number; name: string }[];
  stackItems?: InteractionItem[];
  pgxVariants?: PgxVariantInput[];
  pairs?: SupplementPair[];
  onDone?: () => void;
  // Accepted for prop symmetry with the supplement form / existing med plumbing, but
  // unused: a medication has no workout/rest-day scheduling to gate (#846).
  trainingRestricted?: boolean;
  // Pediatric label-dosing context (#798): the child's age + latest recorded weight,
  // so a PRN medication form can reproduce the OTC weight-band suggestion AND the
  // dose-amount prefill can come from the band for a child. Absent for surfaces that
  // don't thread it (the pediatric block simply doesn't render).
  pediatric?: PediatricFormContext;
  // The profile's age in whole years (issue #851 item 4), threaded to the form's food
  // notice so an age-gated line (alcohol → adult) is hidden for a child. Null = unknown.
  age?: number | null;
  // The edit form changes the current course, or the latest course for a past med.
  // A new medication starts today unless the user chooses another date.
  course?: MedicationCourse;
  todayStr?: string;
}) {
  const s = supplement;
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const fid = s?.id ?? "new";
  const [pediatricContext, setPediatricContext] = useState(pediatric);

  useEffect(() => {
    setPediatricContext(pediatric);
  }, [pediatric]);

  const [name, setName] = useState(s?.name ?? "");
  const rx = useIntakeRxcui(s);
  const [condition, setCondition] = useState(s?.condition ?? "daily");
  const [situation, setSituation] = useState(s?.situation ?? "");
  const situationOptions = useSituationOptions();
  const [brand, setBrand] = useState(s?.brand ?? "");
  const [brandOptions, setBrandOptions] = useState<string[]>(MED_BRAND_OPTIONS);
  // Rx / OTC (#851 items 1–2). A prescription (rxFlag=1) reveals the prescriber/
  // pharmacy/Rx-number/provider fields; an OTC med hides them behind a small "this is
  // a prescription" disclosure. Defaults from the stored flag, or OTC for a new med;
  // the combobox pick and any recorded prescriber flip it on.
  const [rxFlag, setRxFlag] = useState(s?.rx === 1);
  const [asNeeded, setAsNeeded] = useState(s?.as_needed === 1);
  const [startedOn, setStartedOn] = useState(
    course?.started_on ?? (s?.as_needed === 1 ? "" : (todayStr ?? ""))
  );
  const [startedOnTouched, setStartedOnTouched] = useState(false);
  // End date (#1140 Part D): the current course's stopped_on. Editing an existing med only
  // — a date ends the med as of that day; clearing it reactivates. Routed server-side
  // through the shared stop/restart cores (never a raw stopped_on write).
  const [endDate, setEndDate] = useState(course?.stopped_on ?? "");
  const [minIntervalHours, setMinIntervalHours] = useState(
    s?.min_interval_hours != null ? String(s.min_interval_hours) : ""
  );
  const [maxDailyCount, setMaxDailyCount] = useState(
    s?.max_daily_count != null ? String(s.max_daily_count) : ""
  );
  const [redoseNotice, setRedoseNotice] = useState(s?.redose_notice === 1);
  const [product, setProduct] = useState(s?.product ?? "");
  const [formulationSlug, setFormulationSlug] = useState(() =>
    savedFormulationSlug(s)
  );
  const [selectedPediatricBandMinLbs, setSelectedPediatricBandMinLbs] =
    useState<number | null>(null);
  const [critical, setCritical] = useState(s?.critical === 1);
  const [error, setError] = useState<string | null>(null);
  const medInfo = useMemo(() => getMedicationInfo(name), [name]);
  const [doses, setDoses] = useState<DoseState[]>(
    initialDoses && initialDoses.length
      ? initialDoses.map((d) => ({
          id: d.id,
          amount: d.amount ?? "",
          time_of_day: d.time_of_day ?? "",
          food_timing: d.food_timing,
        }))
      : [emptyDose()]
  );

  // A scheduled regimen starts today by default because its adherence window needs a
  // beginning. PRN use is often intermittent and may predate this record, so do not
  // invent a start date when the user switches a NEW medication to as-needed. Once the
  // user edits the field, toggling the medication type preserves their explicit value.
  useEffect(() => {
    if (s || startedOnTouched) return;
    setStartedOn(asNeeded ? "" : (todayStr ?? ""));
  }, [asNeeded, s, startedOnTouched, todayStr]);

  // Selection-prefill bookkeeping (#846): `suggested` marks fields currently showing
  // the "from label defaults" badge; `touched` records fields the user edited so a
  // later pick never clobbers them. Editing a field clears its suggestion + marks it
  // touched.
  const [suggested, setSuggested] = useState<Set<PrefillField>>(new Set());
  const [touched, setTouched] = useState<Set<PrefillField>>(new Set());
  function markTouched(...fields: PrefillField[]) {
    setSuggested((prev) => {
      const next = new Set(prev);
      for (const f of fields) next.delete(f);
      return next;
    });
    setTouched((prev) => {
      const next = new Set(prev);
      for (const f of fields) next.add(f);
      return next;
    });
  }

  const others = allSupplements.filter((x) => x.id !== s?.id);
  const [pairRows, setPairRows] = useState<PairState[]>(
    initialPairs.map((p) => ({
      otherId: p.a_id === s?.id ? p.b_id : p.a_id,
      relation: p.relation,
      note: p.note ?? "",
    }))
  );

  // Curated OTC defaults for the current name (#798): the adult interval/max and the
  // pediatric weight-band chart; null when the ingredient isn't in the dataset.
  const prnDefaults = useMemo(
    () =>
      name.trim()
        ? prnDefaultsFor({
            name,
            rxcui: rx.rxcui,
            rxcuiIngredients: rx.rxcuiIngredients,
          })
        : null,
    [name, rx.rxcui, rx.rxcuiIngredients]
  );
  // Medication dose strengths for the amount datalist (#846): the OTC label figures,
  // not the supplement catalog.
  const medDosageOptions = useMemo(() => {
    if (!prnDefaults) return [];
    const { doseMgLow, doseMgHigh } = prnDefaults.adult;
    return [...new Set([`${doseMgLow} mg`, `${doseMgHigh} mg`])];
  }, [prnDefaults]);

  const pediatricResult = useMemo(() => {
    if (
      !prnDefaults?.pediatric ||
      !pediatricContext ||
      pediatricContext.ageMonths == null
    ) {
      return null;
    }
    if (pediatricContext.ageMonths >= PEDIATRIC_MAX_AGE_MONTHS) return null;
    return pediatricDoseSuggestion({
      entry: prnDefaults,
      ageMonths: pediatricContext.ageMonths,
      weightKg: pediatricContext.weightKg,
      weightDate: pediatricContext.weightDate,
      today: pediatricContext.today,
      formulationSlug: formulationSlug || null,
    });
  }, [prnDefaults, pediatricContext, formulationSlug]);

  // Whether this profile is a child for whom the pediatric label figures — not the
  // adult ones — are the redose defaults (#851 item 12). Matches the pediatric-band gate.
  const isChildProfile =
    pediatricContext?.ageMonths != null &&
    pediatricContext.ageMonths < PEDIATRIC_MAX_AGE_MONTHS;

  // The age-aware redose interval/max to offer as label defaults (#851 item 12): the
  // pediatric label figures for a child (when the label differs), else the adult
  // figures — and NULL for a child whose ingredient has no pediatric label figure, a
  // deliberate refusal to prefill the adult numbers below a child's floor (#798).
  const redoseDefaults = prnDefaults
    ? redoseLabelDefaults(prnDefaults, isChildProfile)
    : null;

  function applyPrnDefaults() {
    if (!redoseDefaults) return;
    setMinIntervalHours(String(redoseDefaults.minIntervalHours));
    setMaxDailyCount(String(redoseDefaults.maxDailyCount));
    markTouched("minIntervalHours", "maxDailyCount");
  }

  // Picking a med (#846/#851): resolve generic + brand from the collapsed catalog
  // label (#851 item 14 — a query-matched brand prefills `brand`), auto-confirm an
  // unambiguous RxNorm code (#851 item 7), then SELECTION PREFILL every knowable field
  // from the datasets as an editable, marked suggestion that respects what the user
  // already touched. `query` is what the user typed before choosing the option.
  function onPickName(picked: string, query?: string) {
    const resolved = resolveMedicationPick(picked, query);
    const generic = resolved.name || picked;
    if (resolved.name) setName(generic);
    setFormulationSlug("");
    setSelectedPediatricBandMinLbs(null);
    setProduct("");
    if (resolved.brand && !touched.has("asNeeded")) setBrand(resolved.brand);

    // Auto-confirm the RxNorm code for the picked med (#851 item 7): run the lookup and
    // adopt an UNAMBIGUOUS top match; an ambiguous list surfaces for a manual pick, and
    // an offline/no-match lookup degrades silently (the affordance stays available).
    void rx.autoConfirm(generic);

    const info = getMedicationInfo(generic);
    const prn = prnDefaultsFor({
      name: generic,
      rxcui: rx.rxcui,
      rxcuiIngredients: rx.rxcuiIngredients,
    });
    const touchedRec: Partial<Record<PrefillField, boolean>> = {};
    for (const f of touched) touchedRec[f] = true;
    const pf = resolveIntakePrefill({
      info,
      prn,
      pediatric: pediatricContext,
      touched: touchedRec,
    });

    // Brand suggestions narrow to this med's brands when known, always led by "Generic"
    // (#851 item 3).
    setBrandOptions(medicationBrandOptions(pf.brandSuggestions));
    if (pf.asNeeded !== undefined) setAsNeeded(pf.asNeeded);
    if (pf.minIntervalHours !== undefined)
      setMinIntervalHours(String(pf.minIntervalHours));
    if (pf.maxDailyCount !== undefined)
      setMaxDailyCount(String(pf.maxDailyCount));
    if (
      pf.doseAmount !== undefined ||
      pf.foodTiming !== undefined ||
      pf.timeOfDay !== undefined
    ) {
      setDoses((ds) =>
        ds.map((d, i) =>
          i === 0
            ? {
                ...d,
                amount: pf.doseAmount ?? d.amount,
                food_timing: pf.foodTiming ?? d.food_timing,
                time_of_day: pf.timeOfDay ?? d.time_of_day,
              }
            : d
        )
      );
    }
    setSuggested(new Set(pf.marked));
  }

  // Any dose-row edit (or add/remove) marks the dose-derived fields touched so a
  // later pick won't overwrite hand-entered strengths/timing.
  function setDosesTouched(update: React.SetStateAction<DoseState[]>) {
    setSelectedPediatricBandMinLbs(null);
    markTouched("doseAmount", "foodTiming", "timeOfDay");
    setDoses(update);
  }

  function selectPediatricBand(band: PediatricBand) {
    setSelectedPediatricBandMinLbs(band.minLbs);
    markTouched("doseAmount");
    setDoses((current) =>
      current.map((dose, index) =>
        index === 0 ? { ...dose, amount: `${band.mg} mg` } : dose
      )
    );
  }

  const doseSuggested =
    suggested.has("doseAmount") ||
    suggested.has("foodTiming") ||
    suggested.has("timeOfDay");

  async function handle(formData: FormData) {
    setError(null);
    formData.set("doses", JSON.stringify(doses));
    formData.set("pairs", JSON.stringify(pairRows));
    const label = name.trim() || "Medication";
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this medication. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(s ? `${label} updated` : `${label} added`);
    if (onDone) onDone();
    else {
      formRef.current?.reset();
      setName("");
      rx.reset();
      setCondition("daily");
      setSituation("");
      setBrand("");
      setBrandOptions(MED_BRAND_OPTIONS);
      setRxFlag(false);
      setAsNeeded(false);
      setStartedOn(todayStr ?? "");
      setStartedOnTouched(false);
      setMinIntervalHours("");
      setMaxDailyCount("");
      setRedoseNotice(false);
      setFormulationSlug("");
      setSelectedPediatricBandMinLbs(null);
      setProduct("");
      setCritical(false);
      setDoses([emptyDose()]);
      setPairRows([]);
      setSuggested(new Set());
      setTouched(new Set());
      router.refresh();
    }
  }

  return (
    <form ref={formRef} action={handle} className="grid gap-4 sm:grid-cols-2">
      {s && <input type="hidden" name="id" value={s.id} />}
      <input type="hidden" name="kind" value="medication" />
      <input type="hidden" name="product" value={product} />
      <input type="hidden" name="rxcui" value={rx.rxcui ?? ""} />
      <input
        type="hidden"
        name="rxcui_ingredients"
        value={serializeRxcuiIngredients(rx.rxcuiIngredients ?? []) ?? ""}
      />

      <div className="section-label sm:col-span-2">Medication details</div>

      <div
        data-testid="medication-details-grid"
        className={`grid gap-4 sm:col-span-2 sm:items-start ${
          medInfo ? "sm:grid-cols-2" : ""
        }`}
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor={`med-name-${fid}`}>
              Name
            </label>
            <SupplementCombobox
              id={`med-name-${fid}`}
              name="name"
              ariaLabel="Name"
              value={name}
              onChange={(v) => {
                if (v !== name) {
                  setFormulationSlug("");
                  setSelectedPediatricBandMinLbs(null);
                  setProduct("");
                }
                setName(v);
                rx.onNameChange();
              }}
              onPick={onPickName}
              options={MED_CATALOG_OPTIONS}
              placeholder="e.g. Ibuprofen"
            />
            <RxNormAffordance name={name} rx={rx} />
            {isChildProfile && name.trim() && !prnDefaults?.pediatric ? (
              <p
                data-testid="medication-pediatric-no-chart"
                className="mt-1 text-xs text-slate-500 dark:text-slate-400"
              >
                No pediatric label weight-band chart is available for this
                medication.
              </p>
            ) : null}
          </div>

          <div>
            <label className="label" htmlFor={`med-brand-${fid}`}>
              Brand
            </label>
            <SupplementCombobox
              id={`med-brand-${fid}`}
              name="brand"
              ariaLabel="Brand"
              value={brand}
              onChange={setBrand}
              options={brandOptions}
              placeholder="e.g. Advil"
            />
          </div>

          <div>
            <label className="label" htmlFor={`med-when-${fid}`}>
              Schedule
            </label>
            <select
              id={`med-when-${fid}`}
              name="condition"
              value={condition}
              onChange={(e) =>
                setCondition(e.target.value as Supplement["condition"])
              }
              className="input"
            >
              {MED_CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {CONDITION_LABELS[c]}
                </option>
              ))}
            </select>
          </div>

          {conditions.length > 0 && (
            <div>
              <label className="label" htmlFor={`med-indication-${fid}`}>
                For condition
                <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">
                  (optional)
                </span>
              </label>
              {/* Med → indication link (#1052): what this med treats, chosen from the
                  profile's recorded conditions. Submits indication_condition_id, which
                  the action validates for ownership. */}
              <select
                id={`med-indication-${fid}`}
                name="indication_condition_id"
                defaultValue={s?.indication_condition_id ?? ""}
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
          )}

          <div>
            <label className="label" htmlFor={`med-started-on-${fid}`}>
              {asNeeded ? "Using since" : "Started on"}
              {asNeeded && (
                <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">
                  (optional)
                </span>
              )}
            </label>
            <DateField
              id={`med-started-on-${fid}`}
              name="started_on"
              value={startedOn}
              onChange={(value) => {
                setStartedOn(value);
                setStartedOnTouched(true);
              }}
              max={todayStr}
              required={!asNeeded}
            />
            {asNeeded && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Leave blank if you don’t know when you started using it.
              </p>
            )}
            {course && (
              <input type="hidden" name="course_id" value={course.id} />
            )}
          </div>

          {s && (
            <div>
              <label className="label" htmlFor={`med-ended-on-${fid}`}>
                End date
                <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">
                  (optional)
                </span>
              </label>
              <DateField
                id={`med-ended-on-${fid}`}
                name="end_date"
                value={endDate}
                onChange={setEndDate}
                min={startedOn || undefined}
                max={todayStr}
                data-testid="med-end-date"
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Set the day you stopped taking it to move it to Past. Clear it
                to mark the medication active again.
              </p>
            </div>
          )}

          {condition === "situational" && (
            <div>
              <label className="label" htmlFor={`med-situation-${fid}`}>
                Situation
              </label>
              <Combobox
                id={`med-situation-${fid}`}
                name="situation"
                ariaLabel="Situation"
                value={situation}
                onChange={setSituation}
                options={situationOptions}
                allowFreeText
                placeholder="e.g. Illness"
              />
            </div>
          )}
        </div>

        {medInfo && (
          <dl className="space-y-3" data-testid="medication-info-preview">
            <div>
              <dt className="section-label">Category</dt>
              <dd className="mt-0.5 text-sm font-medium text-slate-700 dark:text-slate-200">
                {medInfo.drug_class ?? "Medication"}
              </dd>
            </div>
            <div>
              <dt className="section-label">Description</dt>
              <dd className="mt-0.5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                {medInfo.description}
              </dd>
            </div>
          </dl>
        )}
      </div>

      <IntakeInteractionNotices
        name={name}
        rxcui={rx.rxcui}
        rxcuiIngredients={rx.rxcuiIngredients}
        stackItems={stackItems}
        pgxVariants={pgxVariants}
        excludeId={s?.id}
        age={age}
      />

      {/* Medication identity (#851 items 1–2). The Rx/OTC flag rides as a hidden field
          the toggle keeps in sync. The PRN toggle is ALWAYS shown (an OTC ibuprofen is
          commonly PRN); the prescriber/pharmacy/Rx-number/provider fields show only for
          a prescription — a small disclosure flips an OTC med to Rx for the edge case,
          so an OTC med isn't asked for a prescriber it doesn't have. */}
      <input type="hidden" name="rx" value={rxFlag ? "1" : "0"} />
      <div className="sm:col-span-2 border-t border-black/5 pt-4 dark:border-white/5">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            name="as_needed"
            value="1"
            checked={asNeeded}
            onChange={(e) => {
              setAsNeeded(e.target.checked);
              markTouched("asNeeded");
            }}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
          />
          As needed
          {suggested.has("asNeeded") && <PrefillBadge />}
        </label>
        <p className="mt-1 pl-6 text-xs text-slate-500 dark:text-slate-400">
          Log doses when they are taken instead of using scheduled reminders.
        </p>
      </div>

      {/* PRN redose notice + pediatric label dosing (#798). Shown only for a PRN
          medication. The interval/max PRE-FILL from the curated OTC dataset but the
          user confirms them here; an empty field means NO notice, ever. */}
      {asNeeded && (
        <div
          data-testid="redose-block"
          className="sm:col-span-2 border-t border-black/5 pt-4 dark:border-white/5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Redose reminder (optional)
              {(suggested.has("minIntervalHours") ||
                suggested.has("maxDailyCount")) && <PrefillBadge />}
            </div>
            {redoseDefaults && (
              <button
                type="button"
                data-testid="redose-prefill"
                className="btn-ghost btn-sm"
                onClick={applyPrnDefaults}
                title={`Use ${redoseDefaults.tier} label defaults: ${redoseDefaults.minIntervalHours} hours, maximum ${redoseDefaults.maxDailyCount} doses per day`}
              >
                Use label defaults
              </button>
            )}
          </div>
          {/* One-line explainer (#851 item 5); the fuller confirm-discipline text
              lives behind the disclosure. A <details> can't nest inside a <p>. */}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Reminds you when the minimum interval has passed — set from the
            label.
          </p>
          <details className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            <summary className="cursor-pointer text-brand-700 hover:underline dark:text-brand-400">
              How it works
            </summary>
            <p className="mt-1">
              After a dose is logged you get a one-time reminder when the
              minimum interval passes (e.g. {`"`}6h since Ibuprofen — 2 of 4
              today{`"`}). These are YOUR confirmed numbers — pre-filled from
              the label as a suggestion, never applied on their own; leave them
              blank for no reminder.
              {prnDefaults && ` Label source: ${prnDefaults.source}.`}
            </p>
          </details>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`redose-interval-${fid}`}>
                Minimum hours between doses
              </label>
              <input
                id={`redose-interval-${fid}`}
                data-testid="redose-interval"
                name="min_interval_hours"
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
                Maximum doses per day
              </label>
              <input
                id={`redose-max-${fid}`}
                data-testid="redose-max"
                name="max_daily_count"
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
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              name="redose_notice"
              value="1"
              data-testid="redose-optin"
              checked={redoseNotice}
              onChange={(e) => setRedoseNotice(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
            />
            Remind me when the redose window opens
          </label>
          <p className="mt-1 pl-6 text-xs text-slate-500 dark:text-slate-400">
            Requires both interval and maximum-dose fields above.
          </p>
        </div>
      )}

      <div className="sm:col-span-2 border-t border-black/5 pt-4 dark:border-white/5">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            data-testid="rx-toggle"
            checked={rxFlag}
            onChange={(e) => setRxFlag(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
          />
          Prescription medication
        </label>
        <p className="mt-1 pl-6 text-xs text-slate-500 dark:text-slate-400">
          Add prescriber, pharmacy, and prescription details.
        </p>

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
                name="prescriber"
                defaultValue={s?.prescriber ?? ""}
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
                name="pharmacy"
                defaultValue={s?.pharmacy ?? ""}
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
                name="rx_number"
                defaultValue={s?.rx_number ?? ""}
                className="input"
                placeholder="e.g. RX7654321"
              />
            </div>
            <div>
              <label className="label" htmlFor={`med-provider-${fid}`}>
                Provider / pharmacy
              </label>
              {/* Provider picker: create-on-type ProviderCombobox (#1176) over the
                  page's shared registry rows. */}
              <ProviderCombobox
                id={`med-provider-${fid}`}
                name="provider"
                ariaLabel="Provider / pharmacy"
                defaultValue={s?.provider_name ?? ""}
                placeholder="e.g. Sample Care East"
              />
              {/* Round-trip the loaded link so an untouched field keeps its id (#601). */}
              {s && (
                <>
                  <input
                    type="hidden"
                    name="provider_id"
                    value={s.provider_id ?? ""}
                  />
                  <input
                    type="hidden"
                    name="provider_loaded"
                    value={s.provider_name ?? ""}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <CriticalEscalation
        fid={fid}
        supplement={s}
        critical={critical}
        setCritical={setCritical}
      />

      <RefillTracking fid={fid} supplement={s} />

      <div className="sm:col-span-2 border-t border-black/5 pt-4 dark:border-white/5">
        {/* Pediatric label context precedes the fields it can populate. The complete
            label chart is informational (neutral); refusal/stale-weight states keep
            the warning tone. Bands only — never a mg/kg calculation. */}
        {pediatricResult && pediatricResult.kind !== "no-pediatric" && (
          <section data-testid="pediatric-suggestion" className="mb-4 text-sm">
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
                Enter a current weight to match the package label’s weight band.
              </p>
            )}
            {pediatricResult.kind === "stale-weight" && (
              <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                The latest recorded weight is over{" "}
                {pediatricResult.thresholdDays} days old
                {pediatricResult.recordedDate
                  ? ` (${pediatricResult.recordedDate})`
                  : ""}
                . Enter a current weight before using a weight band.
              </p>
            )}
            {pediatricResult.kind === "below-weight-band" && (
              <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                Recorded weight is {pediatricResult.weightLbs} lb. The available
                package-label chart starts at {pediatricResult.minimumLbs} lb,
                so no dose band is suggested. Check the product label and ask a
                clinician or pharmacist before use.
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
                  if (!prnDefaults || touched.has("doseAmount")) return;
                  const nextResult = pediatricDoseSuggestion({
                    entry: prnDefaults,
                    ageMonths: next.ageMonths as number,
                    weightKg: next.weightKg,
                    weightDate: next.weightDate,
                    today: next.today,
                    formulationSlug: formulationSlug || null,
                  });
                  if (
                    nextResult.kind === "dose" &&
                    (suggested.has("doseAmount") || !doses[0]?.amount.trim())
                  ) {
                    setDoses((current) =>
                      current.map((dose, index) =>
                        index === 0
                          ? { ...dose, amount: `${nextResult.mg} mg` }
                          : dose
                      )
                    );
                    setSuggested((current) =>
                      new Set(current).add("doseAmount")
                    );
                  } else if (
                    nextResult.kind !== "dose" &&
                    suggested.has("doseAmount")
                  ) {
                    // The old weight's label suggestion is no longer supported by a
                    // band. Preserve hand-entered/explicitly-selected amounts, but
                    // clear an untouched automatic suggestion.
                    setDoses((current) =>
                      current.map((dose, index) =>
                        index === 0 ? { ...dose, amount: "" } : dose
                      )
                    );
                    setSuggested((current) => {
                      const nextSuggested = new Set(current);
                      nextSuggested.delete("doseAmount");
                      return nextSuggested;
                    });
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
                formulationSlug={formulationSlug}
                today={pediatricContext?.today ?? todayStr ?? ""}
                selectedBandMinLbs={selectedPediatricBandMinLbs}
                currentAmount={doses[0]?.amount ?? ""}
                onBandSelect={selectPediatricBand}
                onFormulationChange={(slug) => {
                  setFormulationSlug(slug);
                  setProduct(
                    formulationForSlug(
                      prnDefaults?.pediatric?.formulations ?? [],
                      slug
                    )?.label ?? ""
                  );
                }}
              />
            )}
          </section>
        )}

        {doseSuggested && (
          <p
            data-testid="prefill-note"
            className="mb-1 text-xs text-brand-700 dark:text-brand-400"
          >
            Dose strength / timing pre-filled from label defaults — edit as
            needed.
          </p>
        )}
        <DoseRowsEditor
          doses={doses}
          setDoses={setDosesTouched}
          dosageOptions={medDosageOptions}
          amountPlaceholder="e.g. 200 mg"
          singleAmountOnly={asNeeded}
        />
      </div>

      <KeepApartPairsEditor
        pairRows={pairRows}
        setPairRows={setPairRows}
        others={others}
      />

      <IntakeNotesField fid={fid} defaultValue={s?.notes} />

      {error && (
        <p
          role="alert"
          className="text-sm text-rose-600 sm:col-span-2 dark:text-rose-400"
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 sm:col-span-2">
        <SubmitButton pendingLabel="Saving…">{s ? "Save" : "Add"}</SubmitButton>
        {onDone && (
          <button type="button" onClick={onDone} className="btn-ghost">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

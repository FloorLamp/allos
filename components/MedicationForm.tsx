"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SupplementCombobox from "@/components/SupplementCombobox";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { NOTICE_TONE } from "@/components/Notice";
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
import {
  pediatricDoseSuggestion,
  type PediatricFormContext,
} from "@/lib/prn-dosing";
import { resolveIntakePrefill, type PrefillField } from "@/lib/intake-prefill";
import {
  CONDITION_LABELS,
  SUGGESTED_SITUATIONS,
} from "@/lib/supplement-schedule";
import type {
  FormResult,
  Supplement,
  SupplementDose,
  SupplementPair,
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
const CHILD_MAX_AGE_MONTHS = 216; // 18 years — above this, no pediatric chart applies

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
}: {
  action: (formData: FormData) => Promise<FormResult>;
  supplement?: Supplement;
  doses?: SupplementDose[];
  allSupplements?: { id: number; name: string }[];
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
}) {
  const s = supplement;
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const fid = s?.id ?? "new";

  const [name, setName] = useState(s?.name ?? "");
  const rx = useIntakeRxcui(s);
  const [condition, setCondition] = useState(s?.condition ?? "daily");
  const [brand, setBrand] = useState(s?.brand ?? "");
  const [brandOptions, setBrandOptions] = useState<string[]>(MED_BRAND_OPTIONS);
  // Rx / OTC (#851 items 1–2). A prescription (rxFlag=1) reveals the prescriber/
  // pharmacy/Rx-number/provider fields; an OTC med hides them behind a small "this is
  // a prescription" disclosure. Defaults from the stored flag, or OTC for a new med;
  // the combobox pick and any recorded prescriber flip it on.
  const [rxFlag, setRxFlag] = useState(s?.rx === 1);
  const [asNeeded, setAsNeeded] = useState(s?.as_needed === 1);
  const [minIntervalHours, setMinIntervalHours] = useState(
    s?.min_interval_hours != null ? String(s.min_interval_hours) : ""
  );
  const [maxDailyCount, setMaxDailyCount] = useState(
    s?.max_daily_count != null ? String(s.max_daily_count) : ""
  );
  const [redoseNotice, setRedoseNotice] = useState(s?.redose_notice === 1);
  const [formulationSlug, setFormulationSlug] = useState("");
  const [critical, setCritical] = useState(s?.critical === 1);
  const [error, setError] = useState<string | null>(null);
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
    if (!prnDefaults?.pediatric || !pediatric || pediatric.ageMonths == null) {
      return null;
    }
    if (pediatric.ageMonths >= CHILD_MAX_AGE_MONTHS) return null;
    return pediatricDoseSuggestion({
      entry: prnDefaults,
      ageMonths: pediatric.ageMonths,
      weightKg: pediatric.weightKg,
      weightDate: pediatric.weightDate,
      today: pediatric.today,
      formulationSlug: formulationSlug || null,
    });
  }, [prnDefaults, pediatric, formulationSlug]);

  // Whether this profile is a child for whom the pediatric label figures — not the
  // adult ones — are the redose defaults (#851 item 12). Matches the pediatric-band gate.
  const isChildProfile =
    pediatric?.ageMonths != null && pediatric.ageMonths < CHILD_MAX_AGE_MONTHS;

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
      pediatric,
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
    markTouched("doseAmount", "foodTiming", "timeOfDay");
    setDoses(update);
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
      setError("Couldn't save this medication. Please try again.");
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
      setBrand("");
      setBrandOptions(MED_BRAND_OPTIONS);
      setRxFlag(false);
      setAsNeeded(false);
      setMinIntervalHours("");
      setMaxDailyCount("");
      setRedoseNotice(false);
      setFormulationSlug("");
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
      <input type="hidden" name="rxcui" value={rx.rxcui ?? ""} />
      <input
        type="hidden"
        name="rxcui_ingredients"
        value={serializeRxcuiIngredients(rx.rxcuiIngredients ?? []) ?? ""}
      />

      <div>
        <label className="label">Name</label>
        <SupplementCombobox
          name="name"
          ariaLabel="Name"
          value={name}
          onChange={(v) => {
            setName(v);
            rx.onNameChange();
          }}
          onPick={onPickName}
          options={MED_CATALOG_OPTIONS}
          placeholder="e.g. Ibuprofen"
        />
        <RxNormAffordance name={name} rx={rx} />
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

      <div>
        <label className="label" htmlFor={`med-when-${fid}`}>
          When
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

      <div>
        <label className="label">Brand</label>
        <SupplementCombobox
          name="brand"
          ariaLabel="Brand"
          value={brand}
          onChange={setBrand}
          options={brandOptions}
          placeholder="e.g. Advil"
        />
      </div>

      {condition === "situational" && (
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`med-situation-${fid}`}>
            Situation
          </label>
          <input
            id={`med-situation-${fid}`}
            name="situation"
            list="situation-options"
            defaultValue={s?.situation ?? ""}
            className="input"
            placeholder="e.g. Illness"
          />
          <datalist id="situation-options">
            {SUGGESTED_SITUATIONS.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </div>
      )}

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
          As needed (PRN) — no scheduled reminders
          {suggested.has("asNeeded") && <PrefillBadge />}
        </label>

        <label className="mt-3 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            data-testid="rx-toggle"
            checked={rxFlag}
            onChange={(e) => setRxFlag(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
          />
          This is a prescription (Rx)
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
              {/* Provider picker: create-on-type from the shared registry via the
                  page's <datalist id="provider-names">. */}
              <input
                id={`med-provider-${fid}`}
                name="provider"
                list="provider-names"
                defaultValue={s?.provider_name ?? ""}
                className="input"
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

      {/* PRN redose notice + pediatric label dosing (#798). Shown only for a PRN
          medication. The interval/max PRE-FILL from the curated OTC dataset but the
          user confirms them here; an empty field means NO notice, ever. */}
      {asNeeded && (
        <div
          data-testid="redose-block"
          className="sm:col-span-2 border-t border-black/5 pt-4 dark:border-white/5"
        >
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Redose reminder (optional)
              {(suggested.has("minIntervalHours") ||
                suggested.has("maxDailyCount")) && <PrefillBadge />}
            </label>
            {redoseDefaults && (
              <button
                type="button"
                data-testid="redose-prefill"
                className="btn-ghost px-2 py-0.5 text-xs"
                onClick={applyPrnDefaults}
              >
                Use {redoseDefaults.tier} label defaults (
                {redoseDefaults.minIntervalHours}h · max{" "}
                {redoseDefaults.maxDailyCount}/day)
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
            Remind me when the redose window opens (needs both fields above)
          </label>
        </div>
      )}

      <CriticalEscalation
        fid={fid}
        supplement={s}
        critical={critical}
        setCritical={setCritical}
      />

      <RefillTracking fid={fid} supplement={s} />

      <div className="sm:col-span-2">
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
          datalistId={`dosage-options-${fid}`}
          amountPlaceholder="e.g. 200 mg"
          singleAmountOnly={asNeeded}
        />

        {/* Pediatric weight-band suggestion (#798), placed by the dose-amount editor it
            informs (#851 item 8): it answers "how MUCH" a child gets, so it belongs
            next to the amount, not in the redose ("how often") block. Bands only — never
            a mg/kg calculation. Informational; confirm against the package. */}
        {pediatricResult && pediatricResult.kind !== "no-pediatric" && (
          <div
            data-testid="pediatric-suggestion"
            className={`mt-3 rounded-lg border px-3 py-2.5 text-sm ${NOTICE_TONE.amber}`}
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
                Record this child’s weight first — the label doses by weight
                band.
              </p>
            )}
            {pediatricResult.kind === "stale-weight" && (
              <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                The latest recorded weight is over{" "}
                {pediatricResult.thresholdDays} days old
                {pediatricResult.recordedDate
                  ? ` (${pediatricResult.recordedDate})`
                  : ""}
                . Update it before using a weight band — kids grow.
              </p>
            )}
            {pediatricResult.kind === "dose" && (
              <div className="mt-0.5 space-y-1 text-amber-700 dark:text-amber-300">
                <p>
                  <span className="font-medium">
                    {pediatricResult.bandLabel} → {pediatricResult.mg} mg
                  </span>{" "}
                  using {pediatricResult.weightLbs} lb
                  {pediatricResult.recordedDate
                    ? `, recorded ${pediatricResult.recordedDate}`
                    : ""}
                  .
                </p>
                {prnDefaults?.pediatric &&
                  prnDefaults.pediatric.formulations.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        className="text-xs"
                        htmlFor={`pediatric-form-${fid}`}
                      >
                        Your product:
                      </label>
                      <select
                        id={`pediatric-form-${fid}`}
                        data-testid="pediatric-formulation"
                        value={formulationSlug}
                        onChange={(e) => setFormulationSlug(e.target.value)}
                        className="input h-8 w-auto py-0 text-xs"
                      >
                        <option value="">mg only (measure per package)</option>
                        {prnDefaults.pediatric.formulations.map((f) => (
                          <option key={f.slug} value={f.slug}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      {pediatricResult.ml != null && (
                        <span className="text-xs font-medium">
                          ≈ {pediatricResult.ml} mL
                        </span>
                      )}
                    </div>
                  )}
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {pediatricResult.caveat}
                </p>
              </div>
            )}
          </div>
        )}
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

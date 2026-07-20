"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import SupplementCombobox from "@/components/SupplementCombobox";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import PediatricDoseBandPicker from "@/components/medications/PediatricDoseBandPicker";
import PediatricWeightUpdate from "@/components/medications/PediatricWeightUpdate";
import {
  medicationCatalogOptions,
  resolveMedicationPick,
  getMedicationInfo,
} from "@/lib/medication-info";
import { prnDefaultsFor } from "@/lib/prn-defaults";
import type { PediatricBand } from "@/lib/datasets/prn-defaults";
import {
  formulationForSlug,
  PEDIATRIC_MAX_AGE_MONTHS,
  pediatricDoseSuggestion,
  type PediatricFormContext,
} from "@/lib/prn-dosing";
import { resolveIntakePrefill } from "@/lib/intake-prefill";
import { quickAddMedicationFormData } from "@/lib/quick-add-medication";
import type { FormResult } from "@/lib/types";

// The OTC medication quick-add (issue #843, door C). Collapses the common case — an
// common OTC entry to name + amount + optional PRN details. It starts scheduled;
// picking a med checks PRN only when the curated defaults identify it as as-needed.
// Picking a med prefills every knowable field from the #846 resolver over
// the cited #798 OTC datasets (dose amount, redose interval/max, brand suggestions,
// pediatric band context), each editable. Submitting builds the SAME intake-form fields
// the full MedicationForm posts and calls the SAME `addSupplement` action, so the row is
// identical (proven in the action tier) — no new model, no migration. The full form
// stays the long-tail path (Rx meds, schedules, prescriber). Renders on both the
// Medications page and inline in the shared illness medication workspace.
const MED_CATALOG_OPTIONS = medicationCatalogOptions();

export default function QuickAddMedication({
  action,
  pediatric,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  // Pediatric label-dosing context (#798) — a child's dose amount comes from the OTC
  // weight band, and the band context is displayed (never invented). Absent → adult.
  pediatric?: PediatricFormContext;
  // Called after a successful add (e.g. to collapse the inline symptom-card panel).
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pediatricContext, setPediatricContext] = useState(pediatric);

  useEffect(() => {
    setPediatricContext(pediatric);
  }, [pediatric]);

  const [name, setName] = useState("");
  const [nameDisplay, setNameDisplay] = useState("");
  const [brand, setBrand] = useState("");
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [asNeeded, setAsNeeded] = useState(false);
  const [minIntervalHours, setMinIntervalHours] = useState("");
  const [maxDailyCount, setMaxDailyCount] = useState("");
  const [redoseNotice, setRedoseNotice] = useState(false);
  const [formulationSlug, setFormulationSlug] = useState("");
  const [selectedPediatricBandMinLbs, setSelectedPediatricBandMinLbs] =
    useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Curated OTC defaults for the current name (#798): adult interval/max + the
  // pediatric weight-band chart; null when the ingredient isn't in the dataset.
  const prnDefaults = useMemo(
    () => (name.trim() ? prnDefaultsFor({ name, rxcui: null }) : null),
    [name]
  );

  // The pediatric band suggestion for a child (#798) — displayed, never auto-applied
  // beyond the resolver's dose-amount prefill. Bands only; a refusal explains itself.
  const pediatricResult = useMemo(() => {
    if (
      !prnDefaults?.pediatric ||
      !pediatricContext ||
      pediatricContext.ageMonths == null
    )
      return null;
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
  const isChildProfile =
    pediatricContext?.ageMonths != null &&
    pediatricContext.ageMonths < PEDIATRIC_MAX_AGE_MONTHS;

  // Picking a med prefills every knowable field from the ONE #846 resolver.
  function onPickName(picked: string, query?: string) {
    const resolved = resolveMedicationPick(picked, query);
    const generic = resolved.name || picked;
    setName(generic);
    setNameDisplay(picked);
    setBrand(resolved.brand ?? "");
    setFormulationSlug("");
    setSelectedPediatricBandMinLbs(null);

    const info = getMedicationInfo(generic);
    const prn = prnDefaultsFor({ name: generic, rxcui: null });
    const pf = resolveIntakePrefill({ info, prn, pediatric: pediatricContext });
    if (pf.asNeeded !== undefined) setAsNeeded(pf.asNeeded);
    if (pf.doseAmount !== undefined) {
      setAmount(pf.doseAmount);
      setAmountTouched(false);
    }
    if (pf.minIntervalHours !== undefined)
      setMinIntervalHours(String(pf.minIntervalHours));
    if (pf.maxDailyCount !== undefined)
      setMaxDailyCount(String(pf.maxDailyCount));
  }

  // A form action (not onSubmit) so SubmitButton's useFormStatus shows pending. The
  // submitted FormData is ignored — the quick-add builds its own field set from state
  // via the shared pure mapping.
  async function handle() {
    setError(null);
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    const fd = quickAddMedicationFormData({
      name,
      brand: brand || null,
      product:
        formulationForSlug(
          prnDefaults?.pediatric?.formulations ?? [],
          formulationSlug
        )?.label ?? null,
      amount: amount || null,
      asNeeded,
      minIntervalHours: minIntervalHours ? Number(minIntervalHours) : null,
      maxDailyCount: maxDailyCount ? Number(maxDailyCount) : null,
      redoseNotice,
    });
    let result: FormResult;
    try {
      result = await action(fd);
    } catch {
      setError("Couldn't add that medication. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(`${name.trim()} added`);
    setName("");
    setNameDisplay("");
    setBrand("");
    setAmount("");
    setAmountTouched(false);
    setAsNeeded(false);
    setMinIntervalHours("");
    setMaxDailyCount("");
    setRedoseNotice(false);
    setFormulationSlug("");
    setSelectedPediatricBandMinLbs(null);
    if (onDone) onDone();
    else router.refresh();
  }

  return (
    <form
      data-testid="quick-add-medication"
      action={handle}
      className="space-y-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="quick-med-name">
            Medication
          </label>
          <SupplementCombobox
            id="quick-med-name"
            ariaLabel="Medication"
            value={nameDisplay}
            onChange={(value) => {
              setNameDisplay(value);
              setName(value);
              setBrand("");
              setFormulationSlug("");
              setSelectedPediatricBandMinLbs(null);
            }}
            onPick={onPickName}
            options={MED_CATALOG_OPTIONS}
            placeholder="e.g. Ibuprofen (Advil, Motrin)"
          />
          {isChildProfile && name.trim() && !prnDefaults?.pediatric ? (
            <p
              data-testid="quick-add-pediatric-no-chart"
              className="mt-1 text-xs text-slate-500 dark:text-slate-400"
            >
              No pediatric label weight-band chart is available for this
              medication.
            </p>
          ) : null}
        </div>

        {/* Put the label chart before the amount it populates. A resolved chart is
            informational; only refusal/missing/stale-weight states use warning tone. */}
        {pediatricResult && pediatricResult.kind !== "no-pediatric" && (
          <section
            data-testid="quick-add-pediatric"
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
                Enter a current weight to match the package label’s weight band.
              </p>
            )}
            {pediatricResult.kind === "stale-weight" && (
              <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                The latest recorded weight is over{" "}
                {pediatricResult.thresholdDays} days old. Update it before using
                a weight band.
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
                idPrefix="quick-pediatric"
                context={pediatricContext}
                initiallyOpen={
                  pediatricResult.kind === "need-weight" ||
                  pediatricResult.kind === "stale-weight"
                }
                onSaved={(next) => {
                  setPediatricContext(next);
                  setSelectedPediatricBandMinLbs(null);
                  if (!prnDefaults || amountTouched) return;
                  const nextResult = pediatricDoseSuggestion({
                    entry: prnDefaults,
                    ageMonths: next.ageMonths as number,
                    weightKg: next.weightKg,
                    weightDate: next.weightDate,
                    today: next.today,
                    formulationSlug: formulationSlug || null,
                  });
                  if (nextResult.kind === "dose") {
                    setAmount(`${nextResult.mg} mg`);
                  } else {
                    // A label-derived amount from the previous weight no longer has
                    // a matching band. Clear only that suggestion; never erase a
                    // dose the caregiver typed or explicitly selected.
                    setAmount("");
                  }
                }}
              />
            )}
            {(pediatricResult.kind === "dose" ||
              pediatricResult.kind === "below-weight-band") && (
              <PediatricDoseBandPicker
                idPrefix="quick-pediatric"
                result={pediatricResult}
                bands={prnDefaults?.pediatric?.bands ?? []}
                formulations={prnDefaults?.pediatric?.formulations ?? []}
                formulationSlug={formulationSlug}
                today={pediatricContext?.today ?? ""}
                selectedBandMinLbs={selectedPediatricBandMinLbs}
                currentAmount={amount}
                onBandSelect={(band: PediatricBand) => {
                  setSelectedPediatricBandMinLbs(band.minLbs);
                  setAmount(`${band.mg} mg`);
                  setAmountTouched(true);
                }}
                onFormulationChange={setFormulationSlug}
              />
            )}
          </section>
        )}

        <div className="sm:col-span-2">
          <label className="label" htmlFor="quick-med-amount">
            Amount
          </label>
          <input
            id="quick-med-amount"
            data-testid="quick-add-amount"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setAmountTouched(true);
              setSelectedPediatricBandMinLbs(null);
            }}
            className="input"
            placeholder="e.g. 200 mg"
          />
        </div>
      </div>

      <div className="border-t border-black/5 pt-4 dark:border-white/5">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            data-testid="quick-add-prn"
            checked={asNeeded}
            onChange={(e) => setAsNeeded(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
          />
          As needed
        </label>
        <p className="mt-1 pl-6 text-xs text-slate-500 dark:text-slate-400">
          Log each dose when taken instead of scheduling reminders.
        </p>
        {asNeeded && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="quick-med-interval">
                Minimum hours between doses
              </label>
              <input
                id="quick-med-interval"
                data-testid="quick-add-interval"
                type="number"
                min={0}
                step="any"
                value={minIntervalHours}
                onChange={(e) => setMinIntervalHours(e.target.value)}
                className="input"
                placeholder="e.g. 6"
              />
            </div>
            <div>
              <label className="label" htmlFor="quick-med-max">
                Maximum doses per day
              </label>
              <input
                id="quick-med-max"
                data-testid="quick-add-max"
                type="number"
                min={1}
                step={1}
                value={maxDailyCount}
                onChange={(e) => setMaxDailyCount(e.target.value)}
                className="input"
                placeholder="e.g. 4"
              />
            </div>
          </div>
        )}
        {asNeeded && prnDefaults && (
          <div className="mt-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                data-testid="quick-add-redose"
                checked={redoseNotice}
                onChange={(e) => setRedoseNotice(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
              />
              Remind me when the redose window opens
            </label>
            <p className="mt-1 pl-6 text-xs text-slate-500 dark:text-slate-400">
              Label defaults: {prnDefaults.adult.minIntervalHours} hours between
              doses, maximum {prnDefaults.adult.maxDailyCount} per day.
            </p>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <SubmitButton pendingLabel="Adding…">Quick add</SubmitButton>
        {onDone && (
          <button type="button" onClick={onDone} className="btn-ghost">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import SupplementCombobox from "@/components/SupplementCombobox";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { NOTICE_TONE } from "@/components/Notice";
import {
  medicationCatalogNames,
  medicationBrandNames,
  splitMedicationName,
  getMedicationInfo,
} from "@/lib/medication-info";
import { prnDefaultsFor } from "@/lib/prn-defaults";
import {
  pediatricDoseSuggestion,
  type PediatricFormContext,
} from "@/lib/prn-dosing";
import { resolveIntakePrefill } from "@/lib/intake-prefill";
import { quickAddMedicationFormData } from "@/lib/quick-add-medication";
import type { FormResult } from "@/lib/types";

// The OTC medication quick-add (issue #843, door C). Collapses the common case — an
// over-the-counter PRN med you reach for when you first feel sick — to name + amount +
// a PRN preset. Picking a med prefills every knowable field from the #846 resolver over
// the cited #798 OTC datasets (dose amount, redose interval/max, brand suggestions,
// pediatric band context), each editable. Submitting builds the SAME intake-form fields
// the full MedicationForm posts and calls the SAME `addSupplement` action, so the row is
// identical (proven in the action tier) — no new model, no migration. The full form
// stays the long-tail path (Rx meds, schedules, prescriber). Renders on both the
// Medications page and inline on the dashboard symptom card.
const MED_CATALOG_NAMES = medicationCatalogNames();
const MED_BRAND_NAMES = medicationBrandNames();
const CHILD_MAX_AGE_MONTHS = 216; // 18 years — above this, no pediatric chart applies

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

  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [brandOptions, setBrandOptions] = useState<string[]>(MED_BRAND_NAMES);
  const [amount, setAmount] = useState("");
  const [asNeeded, setAsNeeded] = useState(true);
  const [minIntervalHours, setMinIntervalHours] = useState("");
  const [maxDailyCount, setMaxDailyCount] = useState("");
  const [redoseNotice, setRedoseNotice] = useState(false);
  const [formulationSlug, setFormulationSlug] = useState("");
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
    if (!prnDefaults?.pediatric || !pediatric || pediatric.ageMonths == null)
      return null;
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

  // Picking a med prefills every knowable field from the ONE #846 resolver.
  function onPickName(picked: string) {
    const split = splitMedicationName(picked);
    const generic = split.name || picked;
    setName(generic);
    if (split.brand) setBrand(split.brand);

    const info = getMedicationInfo(generic);
    const prn = prnDefaultsFor({ name: generic, rxcui: null });
    const pf = resolveIntakePrefill({ info, prn, pediatric });
    setBrandOptions(
      pf.brandSuggestions.length ? pf.brandSuggestions : MED_BRAND_NAMES
    );
    if (pf.asNeeded !== undefined) setAsNeeded(pf.asNeeded);
    if (pf.doseAmount !== undefined) setAmount(pf.doseAmount);
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
      setError("Couldn't add that medication. Please try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(`${name.trim()} added`);
    setName("");
    setBrand("");
    setBrandOptions(MED_BRAND_NAMES);
    setAmount("");
    setAsNeeded(true);
    setMinIntervalHours("");
    setMaxDailyCount("");
    setRedoseNotice(false);
    setFormulationSlug("");
    if (onDone) onDone();
    else router.refresh();
  }

  return (
    <form
      data-testid="quick-add-medication"
      action={handle}
      className="space-y-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Medication</label>
          <SupplementCombobox
            name="name"
            ariaLabel="Medication"
            value={name}
            onChange={setName}
            onPick={onPickName}
            options={MED_CATALOG_NAMES}
            placeholder="e.g. Ibuprofen"
          />
        </div>
        <div>
          <label className="label" htmlFor="quick-med-amount">
            Amount
          </label>
          <input
            id="quick-med-amount"
            data-testid="quick-add-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input"
            placeholder="e.g. 200 mg"
          />
        </div>
      </div>

      <div className="rounded-md border border-black/10 p-2.5 dark:border-white/15">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            data-testid="quick-add-prn"
            checked={asNeeded}
            onChange={(e) => setAsNeeded(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
          />
          As needed (PRN)
        </label>
        {asNeeded && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="quick-med-interval">
                Min hours between
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
                Max per day
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
          <label className="mt-2 flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              data-testid="quick-add-redose"
              checked={redoseNotice}
              onChange={(e) => setRedoseNotice(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
            />
            Remind me when the redose window opens (
            {prnDefaults.adult.minIntervalHours}h · max{" "}
            {prnDefaults.adult.maxDailyCount}/day, from the label)
          </label>
        )}
      </div>

      {/* Pediatric label-dosing context for a child (#798) — displayed, never invented. */}
      {pediatricResult && pediatricResult.kind !== "no-pediatric" && (
        <div
          data-testid="quick-add-pediatric"
          className={`rounded-lg border px-3 py-2 text-sm ${NOTICE_TONE.amber}`}
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
              Record this child’s weight first — the label doses by weight band.
            </p>
          )}
          {pediatricResult.kind === "stale-weight" && (
            <p className="mt-0.5 text-amber-700 dark:text-amber-300">
              The latest recorded weight is over {pediatricResult.thresholdDays}{" "}
              days old. Update it before using a weight band — kids grow.
            </p>
          )}
          {pediatricResult.kind === "dose" && (
            <p className="mt-0.5 text-amber-700 dark:text-amber-300">
              <span className="font-medium">
                {pediatricResult.bandLabel} → {pediatricResult.mg} mg
              </span>{" "}
              using {pediatricResult.weightLbs} lb. {pediatricResult.caveat}
            </p>
          )}
        </div>
      )}

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

"use client";

import type {
  PediatricBand,
  PrnFormulation,
} from "@/lib/datasets/prn-defaults";
import {
  bandRangeLabel,
  formulationForSlug,
  mlForBand,
  PEDIATRIC_DOSE_CAVEAT,
  type PediatricDoseResult,
} from "@/lib/prn-dosing";
import { formatMonthDay, formatRelativeDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";

type PickerResult = Extract<
  PediatricDoseResult,
  { kind: "dose" | "below-weight-band" }
>;

function amountBand(
  bands: readonly PediatricBand[],
  amount: string
): PediatricBand | null {
  const match = amount.trim().match(/^(\d+(?:\.\d+)?)\s*mg$/i);
  if (!match) return null;
  const mg = Number(match[1]);
  return bands.find((band) => band.mg === mg) ?? null;
}

export default function PediatricDoseBandPicker({
  idPrefix,
  result,
  bands,
  formulations,
  formulationSlug,
  today,
  selectedBandMinLbs,
  currentAmount,
  onBandSelect,
  onFormulationChange,
}: {
  idPrefix: string;
  result: PickerResult;
  bands: readonly PediatricBand[];
  formulations: readonly PrnFormulation[];
  formulationSlug: string;
  today: string;
  selectedBandMinLbs: number | null;
  currentAmount: string;
  onBandSelect: (band: PediatricBand) => void;
  onFormulationChange: (slug: string) => void;
}) {
  const formatPrefs = useFormatPrefs();
  const orderedBands = [...bands].sort((a, b) => a.minLbs - b.minLbs);
  const recordedBand = result.kind === "dose" ? result.band : null;
  const selectedBand =
    orderedBands.find((band) => band.minLbs === selectedBandMinLbs) ??
    amountBand(orderedBands, currentAmount) ??
    recordedBand;
  const formulation = formulationForSlug(formulations, formulationSlug);

  return (
    <div className="mt-1 space-y-2 text-slate-600 dark:text-slate-300">
      {formulations.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <label className="text-xs" htmlFor={`${idPrefix}-formulation`}>
            Formulation
          </label>
          <select
            id={`${idPrefix}-formulation`}
            data-testid="pediatric-formulation"
            value={formulationSlug}
            onChange={(event) => onFormulationChange(event.target.value)}
            className="input h-8 w-auto max-w-full py-0 text-xs"
          >
            <option value="">mg only (measure per package)</option>
            {formulations.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <fieldset>
        <legend className="text-xs font-medium">
          Select a label weight band
        </legend>
        <div
          data-testid="pediatric-band-picker"
          className="mt-1 divide-y divide-black/10 overflow-hidden rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10"
        >
          {orderedBands.map((band) => {
            const selected = band.minLbs === selectedBand?.minLbs;
            const recorded = band.minLbs === recordedBand?.minLbs;
            const ml = mlForBand(formulation, band.mg);
            return (
              <label
                key={band.minLbs}
                data-testid="pediatric-band-option"
                className="flex min-h-11 cursor-pointer items-center gap-2.5 px-2.5 py-2 transition hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <input
                  type="radio"
                  name={`${idPrefix}-pediatric-band`}
                  value={band.minLbs}
                  checked={selected}
                  onChange={() => onBandSelect(band)}
                  className="h-4 w-4 shrink-0 border-slate-300 text-brand-600 dark:border-slate-600"
                />
                <span className="grid min-w-0 flex-1 grid-cols-[minmax(5rem,1fr)_auto] items-baseline gap-x-3">
                  <span className="font-medium">
                    {bandRangeLabel(orderedBands, band)}
                  </span>
                  <span className="text-right font-medium">
                    {band.mg} mg{ml != null ? ` · ${ml} mL` : ""}
                  </span>
                  {recorded ? (
                    <span className="col-span-2 text-xs">
                      Recorded weight · {result.weightLbs} lb
                      {result.recordedDate
                        ? ` · ${formatMonthDay(result.recordedDate, formatPrefs)} (${formatRelativeDate(result.recordedDate, today)})`
                        : ""}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {result.kind === "dose" &&
      selectedBand &&
      selectedBand.minLbs !== result.band.minLbs ? (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
          This selection differs from the recorded-weight band.
        </p>
      ) : null}

      {result.kind === "below-weight-band" && selectedBand ? (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
          The recorded weight is below this chart. Confirm the selected band
          against the package label with a clinician or pharmacist.
        </p>
      ) : null}

      <p className="text-xs text-slate-500 dark:text-slate-400">
        {result.kind === "dose" ? result.caveat : PEDIATRIC_DOSE_CAVEAT}
      </p>
    </div>
  );
}

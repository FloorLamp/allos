import { formatClockValue, type TimeFormat } from "./format-date";

const DOSE_BUCKET_LABELS = new Map(
  ["Morning", "Midday", "Evening", "Before sleep", "Anytime"].map(
    (label) => [label.toLowerCase(), label] as const
  )
);

// Keep the full formulation label in storage so an edit can restore the exact picker
// choice, but keep compact dose surfaces focused on the concentration. A trailing
// parenthetical ratio such as `(160 mg / 5 mL)` is the useful dose context; formulation
// labels without a ratio remain intact. Exact duplicate parts are collapsed.
export function medicationProductDoseLabel(
  product: string | null | undefined
): string | null {
  const value = product?.trim();
  if (!value) return null;
  const concentration = value.match(/\(([^()]*(?:\/| per )[^()]*)\)\s*$/i);
  return concentration?.[1]?.trim() || value;
}

export function formatMedicationDoseProduct(
  amount: string | null | undefined,
  product: string | null | undefined
): string | null {
  const productLabel = medicationProductDoseLabel(product);
  const amountValue = amount?.trim() ?? "";
  const amountMg = amountValue.match(/^(\d+(?:\.\d+)?)\s*mg$/i);
  const concentration = productLabel?.match(
    /^(\d+(?:\.\d+)?)\s*mg\s*(?:\/|per)\s*(\d+(?:\.\d+)?)\s*mL$/i
  );

  // A liquid formulation is a concentration, not the administered dose. Preserve
  // the selected mg amount and scale the package-label volume to match it. This keeps
  // a 240 mg weight-band selection visibly different from a 160 mg selection while
  // staying compact (`240 mg / 7.5 mL`, not `240 mg · 160 mg / 5 mL`).
  if (amountMg && concentration) {
    const selectedMg = Number(amountMg[1]);
    const concentrationMg = Number(concentration[1]);
    const concentrationMl = Number(concentration[2]);
    if (
      Number.isFinite(selectedMg) &&
      Number.isFinite(concentrationMg) &&
      Number.isFinite(concentrationMl) &&
      concentrationMg > 0 &&
      concentrationMl > 0
    ) {
      const volumeMl =
        Math.round((selectedMg / concentrationMg) * concentrationMl * 20) / 20;
      return `${selectedMg} mg / ${volumeMl} mL`;
    }
  }

  const parts = [amount?.trim(), productLabel].filter(
    (part): part is string => !!part
  );
  const seen = new Set<string>();
  const unique = parts.filter((part) => {
    const key = part.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.join(" · ") || null;
}

export function formatMedicationDoseLine({
  amount,
  product,
  timeOfDay,
  asNeeded,
  timeFormat,
}: {
  amount: string | null;
  product?: string | null;
  timeOfDay: string | null;
  asNeeded: boolean;
  timeFormat: TimeFormat;
}): string {
  const storedTime = timeOfDay?.trim() || null;
  const time = storedTime
    ? (DOSE_BUCKET_LABELS.get(storedTime.toLowerCase()) ??
      formatClockValue(storedTime, timeFormat))
    : null;
  // As-needed status is already surfaced by the medication badge and action.
  // Keep the dose line about the dose itself instead of repeating the schedule.
  return [formatMedicationDoseProduct(amount, product), asNeeded ? null : time]
    .filter(Boolean)
    .join(" · ");
}

// The current-medication list (issue #852 item 4) — the ONE pure assembly behind the
// three surfaces that answer "what medications am I on?": the printable list, the
// tokenized /share view, and (via medicationDoseDetail) the offline Emergency Card's
// medication subset. Per the one-question-one-computation rule, none of them re-derives
// the med list; the print and share pages both format over buildMedicationList(), and
// the Emergency Card / passport share the medicationDoseDetail() dose-string projection
// so their "detail" can never drift from the print list's dose column. Pure — no DB.

// The dose/PRN detail string a compact surface shows for a medication (e.g. "10 mg" or
// "10 mg · as needed"). Extracted so the passport/Emergency Card gather and the med-list
// dose column are ONE computation. `doseAmounts` are the distinct strengths; a PRN med
// appends "as needed". Null when there's nothing to show.
export function medicationDoseDetail(
  doseAmounts: string[],
  asNeeded: boolean
): string | null {
  const strength = [...new Set(doseAmounts.filter(Boolean))].join(", ");
  return (
    [strength, asNeeded ? "as needed" : null].filter(Boolean).join(" · ") ||
    null
  );
}

// Human schedule label for the list's Schedule column: a PRN med reads "As needed
// (PRN)"; a scheduled med reads its distinct time-of-day buckets ("Morning, Evening")
// when it has timed doses, else the neutral "Scheduled".
export function medicationScheduleLabel(
  timesOfDay: (string | null)[],
  asNeeded: boolean
): string {
  if (asNeeded) return "As needed (PRN)";
  const buckets = [
    ...new Set(timesOfDay.map((t) => (t || "").trim()).filter(Boolean)),
  ];
  return buckets.length > 0 ? buckets.join(", ") : "Scheduled";
}

export interface MedicationListInput {
  id: number;
  name: string;
  brand: string | null;
  product: string | null;
  asNeeded: boolean;
  rx: boolean;
  prescriber: string | null;
  doseAmounts: string[];
  timesOfDay: (string | null)[];
  startedOn: string | null;
}

export interface MedicationListRow {
  id: number;
  name: string;
  subtitle: string | null;
  dose: string | null;
  schedule: string;
  prescriber: string | null;
  startedOn: string | null;
  rx: boolean;
}

// Assemble the current-medication list rows, sorted by name (case-insensitive). Each
// row carries name, brand/product subtitle, dose strengths, schedule/PRN, prescriber,
// and the start date — the fields a "bring your medication list" artifact needs.
export function buildMedicationList(
  input: MedicationListInput[]
): MedicationListRow[] {
  return input
    .map((m) => ({
      id: m.id,
      name: m.name,
      subtitle: [m.brand, m.product].filter(Boolean).join(" · ") || null,
      dose: [...new Set(m.doseAmounts.filter(Boolean))].join(", ") || null,
      schedule: medicationScheduleLabel(m.timesOfDay, m.asNeeded),
      prescriber: m.prescriber?.trim() || null,
      startedOn: m.startedOn,
      rx: m.rx,
    }))
    .sort((a, b) =>
      a.name.toLowerCase() < b.name.toLowerCase()
        ? -1
        : a.name.toLowerCase() > b.name.toLowerCase()
          ? 1
          : 0
    );
}

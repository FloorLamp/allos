import { formatMedicationDoseLine } from "@/lib/medication-dose-format";
import type { DoseHistoryDose } from "@/components/intake/DoseHistoryPanel";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import type { IntakeItemKind } from "@/lib/types";

// The dose mount's own row and item vocabulary (#3484 part 2). Shared by the two
// client halves of the mount — the rows and the backfill slot — and by nothing else:
// the event-ledger frame never sees these types, which is the seam.

// One taken dose as the cross-item ledger renders it: the per-item panel's entry plus
// the identity of the item it was taken against. `time` is the already-formatted
// profile-local clock (or "recorded 7:02am" when the row states no intake time of its
// own — #2228 decision 4), and `statedAt` is the ONLY thing the edit form's time field
// may seed from.
export interface DoseLedgerEntry {
  id: number;
  itemId: number;
  itemName: string;
  kind: IntakeItemKind;
  doseId: number;
  date: string;
  time: string;
  statedAt: string | null;
  amount: string | null;
  product: string | null;
}

// An item the ledger can log a past dose against — the picker in front of the backfill
// form. Only items with a LIVE dose can be logged against, so an item whose doses are
// all retired is simply absent from the picker (its history still lists).
export interface DoseLedgerItem {
  id: number;
  name: string;
  kind: IntakeItemKind;
  product: string | null;
  asNeeded: boolean;
  doses: DoseHistoryDose[];
}

// The dose options a HistoricalDoseForm offers for one item, in the profile's own
// clock format. Both halves of the mount build the same list, so they build it here.
export function doseOptionsFor(
  item: DoseLedgerItem,
  prefs: DisplayFormatPrefs
): { id: number; label: string; amount: string | null }[] {
  return item.doses.map((dose) => ({
    id: dose.id,
    label:
      formatMedicationDoseLine({
        amount: dose.amount,
        product: item.product,
        timeOfDay: dose.time_of_day,
        asNeeded: item.asNeeded,
        timeFormat: prefs.timeFormat,
      }) || "Dose",
    amount: dose.amount,
  }));
}

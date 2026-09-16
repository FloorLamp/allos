import type { HistoricalDoseOption } from "@/components/medications/HistoricalDoseForm";
import type { DoseLedgerItem } from "@/lib/queries/intake/dose-ledger";
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
// form. The shape is the gather's, not the mount's: `doseLedgerItems` builds it, both
// surfaces that mount this ledger take it from there, and it is re-exported here so the
// mount's vocabulary still reads from one module.
export type { DoseLedgerItem };

// The raw dose options a HistoricalDoseForm offers for one item. Both halves of the
// mount build the same list here; the form resolves and formats them for its chosen day.
export function doseOptionsFor(
  item: DoseLedgerItem,
  _prefs: DisplayFormatPrefs
): HistoricalDoseOption[] {
  return item.doses.map((dose) => ({
    id: dose.id,
    amount: dose.amount,
    time_of_day: dose.time_of_day,
    product: item.product,
    versions: dose.versions,
  }));
}
